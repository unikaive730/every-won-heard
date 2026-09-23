/** Browser text-to-speech (Web Speech API). Free, no key, works offline in Chrome/Edge. */
export function createTts() {
  const synth = globalThis.speechSynthesis;
  let voices = [];
  const refresh = () => { voices = synth ? synth.getVoices() : []; };
  refresh();
  synth?.addEventListener?.('voiceschanged', refresh);

  function pick(lang) {
    const want = lang === 'ko' ? 'ko' : 'en';
    const cands = voices.filter((v) => v.lang?.toLowerCase().startsWith(want));
    const prefer = [/google/i, /microsoft.*(sunhi|heami|injoon|aria|jenny|guy)/i, /natural/i, /premium/i, /siri/i];
    for (const re of prefer) {
      const v = cands.find((c) => re.test(c.name));
      if (v) return v;
    }
    return cands[0] || null;
  }

  let current = null;
  function speak(text, lang, { rate = 1.02, onStart, onEnd } = {}) {
    return new Promise((resolve) => {
      if (!synth || !text) { resolve(false); return; }
      cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = lang === 'ko' ? 'ko-KR' : 'en-US';
      const v = pick(lang);
      if (v) u.voice = v;
      u.rate = rate;
      u.pitch = 1;
      let done = false;
      const finish = (ok) => { if (done) return; done = true; current = null; onEnd?.(); resolve(ok); };
      u.onstart = () => onStart?.();
      u.onend = () => finish(true);
      u.onerror = () => finish(false);
      current = u;
      synth.speak(u);
      // Chrome occasionally never fires onend; guard with a generous timeout based on length
      setTimeout(() => finish(true), Math.min(60000, 4000 + text.length * 90));
    });
  }

  function cancel() {
    if (synth && (synth.speaking || synth.pending)) synth.cancel();
    current = null;
  }

  return { speak, cancel, get available() { return Boolean(synth); }, get speaking() { return Boolean(current); } };
}
