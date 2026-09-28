/**
 * Pure parts of the synthesized demo caller (web/src/demo-caller.js). No DOM, no Web Audio.
 *
 * - parseWav(bytes)          RIFF/WAVE PCM16 -> {sampleRate, channels, samples: Int16Array (mono)}
 * - createPacer({frameMs})   how many 50 ms frames are due by wall clock; never ahead of real time
 *                            (faster than real time is an audio_rate_violation, and the extra audio is dropped)
 * - createDirector(lines)    when to start the next caller line:
 *                              normal line  after an agent reply that was spoken and completed, once the agent
 *                                           audio has finished playing here, plus a short settle pause that
 *                                           is cancelled if the agent starts another reply or tool call
 *                              barge-in     `bargeIn.delayMs` after the reply.started that follows a tool result
 *                                           for `bargeIn.afterTool` (the agent starts reading the plan); if that
 *                                           never comes, it plays as a normal line after `fallbackMs` idle
 */

/** @param {ArrayBuffer|Uint8Array} bytes */
export function parseWav(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const tag = (off) => String.fromCharCode(u8[off], u8[off + 1], u8[off + 2], u8[off + 3]);
  if (u8.length < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a WAV file');
  let off = 12;
  let fmt = null;
  let data = null;
  while (off + 8 <= u8.length) {
    const id = tag(off);
    const size = dv.getUint32(off + 4, true);
    const body = off + 8;
    if (id === 'fmt ') {
      fmt = { format: dv.getUint16(body, true), channels: dv.getUint16(body + 2, true), sampleRate: dv.getUint32(body + 4, true), bits: dv.getUint16(body + 14, true) };
    } else if (id === 'data') {
      data = { start: body, size: Math.min(size, u8.length - body) };
      break;
    }
    off = body + size + (size & 1); // chunks are word aligned
  }
  if (!fmt || !data) throw new Error('WAV without fmt or data chunk');
  if (fmt.format !== 1 || fmt.bits !== 16) throw new Error(`WAV must be PCM16 (format ${fmt.format}, ${fmt.bits} bit)`);
  const frames = Math.floor(data.size / (2 * fmt.channels));
  const samples = new Int16Array(frames);
  for (let i = 0; i < frames; i++) samples[i] = dv.getInt16(data.start + i * 2 * fmt.channels, true); // first channel
  return { sampleRate: fmt.sampleRate, channels: fmt.channels, samples, seconds: frames / fmt.sampleRate };
}

/**
 * Real-time pacing for input.audio. `due(now)` returns how many frames may be sent now so that the total sent
 * never exceeds the wall-clock time since start. A throttled background tab catches up in one burst, which is
 * still not ahead of real time.
 */
export function createPacer({ frameMs = 50, startAt = 0, maxBurst = 40 } = {}) {
  let t0 = startAt;
  let sent = 0;
  return {
    start(now) { t0 = now; sent = 0; },
    due(now) {
      const allowed = Math.floor((now - t0) / frameMs);
      let n = allowed - sent;
      if (n <= 0) return 0;
      if (n > maxBurst) { sent = allowed - maxBurst; n = maxBurst; } // a very long stall: drop the backlog instead of bursting
      sent += n;
      return n;
    },
    get sent() { return sent; },
  };
}

/**
 * @param {Array<{id:string, text:string, bargeIn?:{afterTool:string, delayMs:number}}>} lines
 * @param {{settleMs?:number, fallbackMs?:number}} opts
 *
 * Feed events with `on(type, data, now)`, call `tick(now)` often. Both return commands:
 *   {cmd:'play', id, index, bargeIn:boolean}   start sending this line
 *   {cmd:'done'}                                the last line has finished and the agent answered it
 */
export function createDirector(lines, { settleMs = 1000, fallbackMs = 20000, endAfterMs = 8000 } = {}) {
  const st = {
    next: 0, // index of the next line to play
    playing: false, // a caller line is being sent
    agentDone: false, // an agent reply was spoken and completed since the last caller line
    drained: true, // agent audio finished playing locally
    replyAudio: false, // the current reply produced audio
    replying: false, // between reply.started and reply.done
    busyTools: 0, // tool calls collected or being relayed
    settleAt: null, // when the settle pause ends
    lastToolSent: null, // name of the last tool whose result went back to the agent
    armedAt: null, // barge-in: reply.started after the trigger tool
    idleSince: null, // for the barge-in fallback
    finished: false,
    endAt: null,
  };

  const current = () => lines[st.next] || null;

  function play(now, bargeIn = false) {
    const line = current();
    if (!line) return [];
    st.playing = true;
    st.agentDone = false;
    st.settleAt = null;
    st.armedAt = null;
    st.idleSince = null;
    const cmd = { cmd: 'play', id: line.id, index: st.next, bargeIn };
    st.next += 1;
    return [cmd];
  }

  function readyForNormal() {
    return !st.playing && st.agentDone && st.drained && st.busyTools === 0;
  }

  function check(now) {
    if (st.finished) return [];
    const line = current();
    if (!line) {
      // after the last line: finish once the agent has answered it, or after endAfterMs with the agent quiet
      const quiet = !st.playing && !st.replying && st.drained && st.busyTools === 0;
      if (quiet && (st.agentDone || (st.endAt != null && now >= st.endAt))) {
        st.finished = true;
        return [{ cmd: 'done' }];
      }
      return [];
    }
    if (line.bargeIn && st.armedAt != null && now >= st.armedAt && !st.playing) return play(now, true);
    if (readyForNormal()) {
      if (line.bargeIn) {
        // wait for the trigger; play as a normal line only after a long quiet spell
        if (st.idleSince == null) st.idleSince = now;
        if (now - st.idleSince >= fallbackMs) return play(now, false);
        return [];
      }
      if (st.settleAt == null) st.settleAt = now + settleMs;
      if (now >= st.settleAt) return play(now, false);
    }
    return [];
  }

  return {
    state: st,
    on(type, data = {}, now = 0) {
      switch (type) {
        case 'reply.started':
          st.replyAudio = false;
          st.replying = true;
          st.agentDone = false; // only the latest reply counts (a spoken reply can carry a tool call, then another reply follows)
          if (st.endAt != null) st.endAt = now + endAfterMs; // the agent is still answering the last line
          st.settleAt = null; // the agent is talking again: no caller line yet
          st.idleSince = null;
          if (current()?.bargeIn && st.lastToolSent === current().bargeIn.afterTool && st.armedAt == null && !st.playing) {
            st.armedAt = now + current().bargeIn.delayMs;
          }
          break;
        case 'reply.audio':
          st.replyAudio = true;
          st.drained = false;
          break;
        case 'reply.done':
          st.replying = false;
          if (data.status === 'completed' && st.replyAudio && !String(data.reply_id || '').startsWith('fc-')) st.agentDone = true;
          if (data.status === 'interrupted') st.armedAt = null;
          break;
        case 'tool.call':
          st.busyTools += 1;
          if (st.endAt != null) st.endAt = now + endAfterMs;
          st.settleAt = null;
          break;
        case 'tool.settled': // result sent or dropped
          st.busyTools = Math.max(0, st.busyTools - 1);
          if (data.name && data.sent) st.lastToolSent = data.name;
          break;
        case 'playback.drained':
          st.drained = true;
          break;
        case 'line.ended':
          st.playing = false;
          if (!current()) st.endAt = now + endAfterMs;
          break;
        default:
          break;
      }
      return check(now);
    },
    tick(now) { return check(now); },
  };
}
