// Browser-side stand-in for wss://agents.assemblyai.com/v1/ws, injected by web-browser-run.mjs --fake.
// It plays the Voice Agent server for the demo script (C1..C7) with no network and no cost, so the client's
// glue (ordering, tool relay, barge-in, session.end) can be checked before a paid call.
// Energy-based turn detection on the input.audio it receives; each caller turn gets the transcript the real
// API gave for that line (numbers as digits, measured 9/28), then a scripted agent move.
(() => {
  const USER = [
    'Hi. I run a small ramen place near Mangwon Market. We opened in the spring. Weekends are fine, but weekday lunch is empty.',
    'Maybe 4 or 500,000 won a month.',
    'Four hundred... eighty thousand.',
    "Yes, that's right.",
    'Wait. Cut it to 380,000. And can you take 20% off?',
    'Yes.',
    'Okay. Go ahead.',
    'Thanks. Bye.',
  ];
  const b64 = (i16) => { const u = new Uint8Array(i16.buffer); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
  const tone = (ms, f = 196) => { const n = Math.round(24 * ms); const a = new Int16Array(n); for (let i = 0; i < n; i++) a[i] = Math.round(Math.sin((2 * Math.PI * f * i) / 24000) * 2400); return a; };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let seq = 0;
  const id = (p) => `${p}_${++seq}`;

  class FakeVA {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.listeners = {};
      this.turn = 0;
      this.speaking = false;
      this.quietMs = 0;
      this.reply = null; // {id, cancelled}
      this.waiting = new Map(); // call_id -> resolve(tool.result)
      this.config = { input: { keyterms: [], transcription_mode: 'balanced' } };
      FakeVA.last = this;
      setTimeout(() => { this.readyState = 1; this.fire('open', {}); }, 30);
    }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    fire(type, ev) { this[`on${type}`]?.(ev); for (const fn of this.listeners[type] || []) fn(ev); }
    emit(msg) { if (this.readyState === 1) this.fire('message', { data: JSON.stringify(msg) }); }
    close() { if (this.readyState >= 2) return; this.readyState = 3; this.fire('close', { code: 1000, reason: '' }); }

    send(raw) {
      const m = JSON.parse(raw);
      if (m.type === 'session.update') {
        const s = m.session || {};
        if (s.input) this.config = { ...this.config, input: { ...this.config.input, ...s.input } };
        this.emit({ type: 'session.updated', config: this.config });
        if (!this.started) {
          this.started = true;
          setTimeout(() => { this.emit({ type: 'session.ready', session_id: 'sess_fake', config: this.config }); this.say('Hi, this is MarketPilot. Tell me about your shop: what do you run, and where?', 2200); }, 60);
        }
      } else if (m.type === 'input.audio') {
        this.hear(m.audio);
      } else if (m.type === 'tool.result') {
        const w = this.waiting.get(m.call_id);
        if (w) { this.waiting.delete(m.call_id); w({ ...m, parsed: JSON.parse(m.result) }); }
      } else if (m.type === 'session.end') {
        setTimeout(() => { this.emit({ type: 'session.ended', session_duration_seconds: 1, audio_duration_seconds: 1 }); this.close(); }, 50);
      }
    }

    hear(audio) {
      const bin = atob(audio);
      let sum = 0;
      const n = bin.length >> 1;
      for (let i = 0; i < n; i++) { let v = bin.charCodeAt(i * 2) | (bin.charCodeAt(i * 2 + 1) << 8); if (v >= 0x8000) v -= 0x10000; sum += v * v; }
      const loud = Math.sqrt(sum / n) / 32768 > 0.01;
      const ms = (n / 24000) * 1000;
      if (loud) {
        this.quietMs = 0;
        if (!this.speaking) {
          this.speaking = true;
          this.emit({ type: 'input.speech.started' });
          if (this.reply && !this.reply.done) this.interrupt();
        }
      } else if (this.speaking) {
        this.quietMs += ms;
        if (this.quietMs >= 1500) { this.speaking = false; this.endTurn(); }
      }
    }

    interrupt() {
      const r = this.reply;
      r.cancelled = true;
      r.done = true;
      this.emit({ type: 'transcript.agent', reply_id: r.id, item_id: r.item, text: r.text.split(' ').slice(0, 6).join(' '), interrupted: true });
      this.emit({ type: 'reply.done', reply_id: r.id, status: 'interrupted' });
    }

    async endTurn() {
      this.emit({ type: 'input.speech.stopped' });
      const k = this.turn++;
      const item = id('msg');
      this.emit({ type: 'transcript.user', item_id: item, text: USER[k] || '' });
      await sleep(150);
      await this.agentMove(k);
    }

    async call(name, args) {
      const call_id = id('call');
      this.emit({ type: 'reply.started', reply_id: `fc-${call_id}`, item_id: id('msg') });
      this.emit({ type: 'tool.call', call_id, name, arguments: args });
      await sleep(40);
      this.emit({ type: 'reply.done', reply_id: `fc-${call_id}`, status: 'completed' });
      return new Promise((resolve) => this.waiting.set(call_id, resolve));
    }

    async say(text, ms) {
      const r = { id: id('resp'), item: id('msg'), text, done: false, cancelled: false };
      this.reply = r;
      this.emit({ type: 'reply.started', reply_id: r.id, item_id: r.item });
      await sleep(180);
      const words = text.split(' ');
      const chunks = Math.max(1, Math.round(ms / 200));
      for (let i = 0; i < chunks && !r.cancelled; i++) {
        this.emit({ type: 'reply.audio', data: b64(tone(200)) });
        const w = words.slice(Math.floor((i * words.length) / chunks), Math.floor(((i + 1) * words.length) / chunks));
        for (const d of w) this.emit({ type: 'transcript.agent.delta', reply_id: r.id, item_id: r.item, delta: d });
        await sleep(100); // faster than real time, like the real server
      }
      if (r.cancelled) return;
      await sleep(ms / 2); // reply.done comes around when generation ends, before playback ends here
      if (r.cancelled) return;
      r.done = true;
      this.emit({ type: 'transcript.agent', reply_id: r.id, item_id: r.item, text, interrupted: false });
      this.emit({ type: 'reply.done', reply_id: r.id, status: 'completed' });
    }

    async agentMove(k) {
      const words = USER[k];
      if (k === 0) { await this.call('record_shop', { business_type: 'restaurant', neighborhood: 'Mangwon', main_problem: 'low_traffic' }); return this.say('Got it. What monthly marketing budget should I plan for, in won?', 2000); }
      if (k === 1 || k === 2 || k === 4) {
        const r = await this.call('record_budget', { owner_words: words.replace(/^(Maybe|Wait\.)\s*/i, ''), period: 'monthly' });
        if (r.is_error) return this.say(r.parsed.options ? `Which one should I plan for, ${r.parsed.options.join(' or ')}?` : 'Sorry, what monthly budget should I plan for?', 2400);
        return this.say(`${k === 4 ? "I can only use catalog prices, but I can fit the plan to a smaller budget. " : ''}${r.parsed.read_back}, is that right?`, k === 4 ? 4200 : 2400);
      }
      if (k === 3 || k === 5) {
        await this.call('confirm_budget', { confirmed: true });
        const p = await this.call('build_plan', {});
        const lines = (p.parsed.lines || []).map((l) => `${l.qty} ${l.name}`).join(', ');
        return this.say(`Here is the plan: ${lines}. The total is ${p.parsed.spoken_total}. Want the checkout link?`, k === 3 ? 8000 : 4000);
      }
      if (k === 6) { await this.call('create_checkout_link', {}); return this.say('The checkout link is on your screen.', 1600); }
      if (k === 7) { await this.call('end_call', {}); return this.say('Thanks for calling. Bye!', 1200); }
      return null;
    }
  }
  window.__EWH_WS = FakeVA;
})();
