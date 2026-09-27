// 실측: AssemblyAI v3 스트리밍에 WAV(16kHz mono PCM16)를 실시간 속도로 흘려 Turn 결과를 받는다.
// node scripts/probe/stream-probe.mjs <wav> "<추가 쿼리, 예: speech_model=universal-3-6-pro&language_detection=true>"
import fs from 'node:fs'
const env = Object.fromEntries(fs.readFileSync(new URL('../../.env', import.meta.url), 'utf8').split(/\r?\n/).filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
const [wavPath, extra = ''] = process.argv.slice(2)
const tok = await (await fetch('https://streaming.assemblyai.com/v3/token?expires_in_seconds=60&max_session_duration_seconds=300', { headers: { Authorization: env.ASSEMBLYAI_API_KEY } })).json()
if (!tok.token) { console.log('token 실패', JSON.stringify(tok).slice(0, 200)); process.exit(1) }
const wav = fs.readFileSync(wavPath); const pcm = wav.subarray(44)
const url = `wss://streaming.assemblyai.com/v3/ws?sample_rate=16000&encoding=pcm_s16le&${extra}&token=${tok.token}`
console.log('URL params:', extra)
const ws = new WebSocket(url)
const t0 = Date.now(); let finals = []
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.type === 'Turn' && (m.end_of_turn || m.turn_is_formatted)) { finals.push(m.transcript); console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] TURN eot=${m.end_of_turn} fmt=${m.turn_is_formatted} lang=${m.language_code ?? ''} :`, m.transcript) } else if (m.type !== 'Turn') console.log('MSG', JSON.stringify(m).slice(0, 300)) }
ws.onerror = (e) => console.log('ERR', e.message || e)
ws.onclose = (e) => { console.log('CLOSE', e.code, e.reason); process.exit(0) }
ws.onopen = async () => {
  const chunk = 3200 // 100ms
  for (let i = 0; i < pcm.length; i += chunk) { ws.send(pcm.subarray(i, i + chunk)); await new Promise((r) => setTimeout(r, 100)) }
  for (let i = 0; i < 15; i++) { ws.send(Buffer.alloc(chunk)); await new Promise((r) => setTimeout(r, 100)) }
  setTimeout(() => ws.send(JSON.stringify({ type: 'Terminate' })), 1500)
}
setTimeout(() => { console.log('timeout'); process.exit(0) }, 60000)
