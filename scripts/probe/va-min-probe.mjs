// Minimal Voice Agent API probe: inline session, no tools, one spoken question. Prints every event type and any agent text.
// node scripts/probe/va-min-probe.mjs <wav 24kHz mono pcm16> [voice]
import fs from 'node:fs'

const env = fs.readFileSync(new URL('../../.env', import.meta.url), 'utf8')
const KEY = env.match(/^ASSEMBLYAI_API_KEY=(.+)$/m)[1].trim()
const [wavPath, voice] = process.argv.slice(2)
const tok = await (await fetch('https://agents.assemblyai.com/v1/token?expires_in_seconds=60&max_session_duration_seconds=90', { headers: { Authorization: `Bearer ${KEY}` } })).json()
if (!tok.token) { console.log('token failed', JSON.stringify(tok).slice(0, 300)); process.exit(1) }
const pcm = fs.readFileSync(wavPath).subarray(44)
const ws = new WebSocket(`wss://agents.assemblyai.com/v1/ws?token=${tok.token}`)
const seen = {}
let replyText = ''
const t0 = Date.now()
const at = () => ((Date.now() - t0) / 1000).toFixed(1)
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  seen[m.type] = (seen[m.type] || 0) + 1
  if (m.type !== 'reply.audio') console.log(`[${at()}]`, m.type, JSON.stringify(m).slice(0, 240))
  if (m.type === 'transcript.agent' || m.type === 'reply.text') replyText += (m.text || m.transcript || '')
}
ws.onerror = (e) => console.log('ERR', e.message || e)
ws.onclose = (e) => { console.log('CLOSE', e.code, e.reason, 'events', JSON.stringify(seen)); process.exit(0) }
ws.onopen = async () => {
  const session = { system_prompt: process.env.SYS || 'You are a helpful assistant. Answer in one short sentence.', greeting: 'Hi there.', output: { type: 'audio', voice: 'alba' } }
  if (voice && voice !== '-') session.output = { voice }
  if (process.argv[4]) session.tools = JSON.parse(fs.readFileSync(process.argv[4], 'utf8'))
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.type === 'tool.call') console.log('TOOL.CALL', JSON.stringify(m).slice(0, 300)); if (/error/.test(m.type)) console.log('ERRORMSG', JSON.stringify(m).slice(0, 300)) })
  ws.send(JSON.stringify({ type: 'session.update', session }))
  await new Promise((r) => setTimeout(r, 3000))
  const chunk = 2400 // 50 ms at 24 kHz
  for (let i = 0; i < pcm.length; i += chunk) {
    ws.send(JSON.stringify({ type: 'input.audio', audio: pcm.subarray(i, i + chunk).toString('base64') }))
    await new Promise((r) => setTimeout(r, 50))
  }
  for (let i = 0; i < 60; i++) { ws.send(JSON.stringify({ type: 'input.audio', audio: Buffer.alloc(chunk).toString('base64') })); await new Promise((r) => setTimeout(r, 50)) }
  await new Promise((r) => setTimeout(r, 8000))
  ws.send(JSON.stringify({ type: 'session.end' }))
  setTimeout(() => ws.close(), 1500)
}
setTimeout(() => { console.log('timeout'); try { ws.send(JSON.stringify({ type: 'session.end' })) } catch {} process.exit(0) }, 60000)
