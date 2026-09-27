// LLM Gateway 확인: 공개 모델 목록 + 짧은 호출 1회(AssemblyAI 크레딧)
import fs from 'node:fs'
const K = fs.readFileSync(new URL('../../.env', import.meta.url), 'utf8').match(/^ASSEMBLYAI_API_KEY=(.+)$/m)[1].trim()
const list = await (await fetch('https://llm-gateway.assemblyai.com/v1/models')).json()
const ids = (list.data || []).map((x) => x.id)
console.log(ids.length, 'models:', ids.filter((i) => /claude|gemini|gpt/i.test(i)).join(', '))
const model = process.argv[2] || 'gemini-3.8-flash'
const r = await fetch('https://llm-gateway.assemblyai.com/v1/chat/completions', { method: 'POST', headers: { Authorization: K, 'Content-Type': 'application/json' }, body: JSON.stringify({ model, messages: [{ role: 'user', content: '한국어로 한 문장만: 강남역 카페 사장님께 인사' }], max_tokens: 60 }) })
const j = await r.json(); console.log('HTTP', r.status, JSON.stringify(j).slice(0, 500))
