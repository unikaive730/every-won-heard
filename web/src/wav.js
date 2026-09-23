/** Encode Int16 PCM frames into a 16-bit mono WAV file. */
export function encodeWav(frames, sampleRate = 16000) {
  const total = frames.reduce((a, f) => a + f.length, 0);
  const buffer = new ArrayBuffer(44 + total * 2);
  const v = new DataView(buffer);
  const w = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
  w(0, 'RIFF');
  v.setUint32(4, 36 + total * 2, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, 'data');
  v.setUint32(40, total * 2, true);
  let off = 44;
  for (const f of frames) {
    for (let i = 0; i < f.length; i++, off += 2) v.setInt16(off, f[i], true);
  }
  return buffer;
}

export function durationSeconds(frames, sampleRate = 16000) {
  return frames.reduce((a, f) => a + f.length, 0) / sampleRate;
}
