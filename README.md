# MarketPilot Voice Consultant

**A voice marketing consultant for small business owners, built on AssemblyAI.**
The owner talks (Korean or English). AssemblyAI transcribes in real time, an agent asks the
three questions that matter (business, budget, urgent problem), and a priced 30-day plan with an
action checklist appears on screen while the consultant reads it out. When the call ends,
AssemblyAI's speaker labels, sentiment, key phrases and entity detection turn the recording into a
structured brief of "what the owner actually complained about". Real products and prices come from
MarketPilot's public MCP server, so the plan ends in a real card-checkout link.

Built for the lablab.ai x AssemblyAI **Voice Agent Hackathon** (build window 2026-09-01 to 09-30).

```
npm install
cp .env.example .env      # add ASSEMBLYAI_API_KEY (voice) and optionally LLM_API_KEY
npm run dev               # API on :8787 + Vite on :5173  ->  open http://localhost:5173
npm test                  # 47 unit tests, no network, no keys
```

Without any key the app still runs: the header badges show `AssemblyAI: no key`, `LLM: rules`, and
you can hold the whole consultation by typing in the composer. With only `ASSEMBLYAI_API_KEY` you
get live voice; with `LLM_API_KEY` the consultant's wording comes from Claude instead of templates.

---

## What it does (demo flow)

1. Pick a language, press **Start call**. The consultant greets you (browser TTS).
2. Talk: "I run a cafe near Gangnam station and weekdays are dead. I can spend about 500,000 won a month."
3. Live transcript appears on the left (partials in italics, finals as bubbles). The **What we heard**
   card fills chips as slots are recognized: business, location, budget, urgent problem.
4. Once business + budget + problem are known, the **30-day plan** card renders: channel mix,
   real MarketPilot products with quantities that respect min/max order units, total <= budget,
   assumptions, and the **Action checklist**. The consultant reads a 2-sentence summary.
5. Say "go ahead" / "진행" -> the consultant points to **Create card checkout link** (MarketPilot MCP
   `create_checkout`, no signup needed).
6. Press **End call**. The whole recording goes to AssemblyAI's pre-recorded API with speaker labels,
   sentiment analysis, key phrases and entity detection. The **Call analysis** card shows who spoke,
   the owner's negative sentences as quotes, key phrases, and named facts (places, money, orgs).
   Problems found there are merged back into the profile and the plan is re-built.

---

## Architecture

```
 Browser (Vite, vanilla JS)                         Node 22 server (no framework)                 External
 ─────────────────────────────                      ─────────────────────────────────            ─────────────────────────
 mic ──AudioWorklet──> 16 kHz PCM16 frames          GET  /api/assemblyai/token ───────────────>  streaming.assemblyai.com/v3/token
   │                                                  (API key stays here; 60 s token out)
   ├─ EN: WebSocket ──────────────────────────────────────────────────────────────────────────>  wss://streaming.assemblyai.com/v3/ws
   │      Turn events -> reduceTurn() -> final text     (Universal-Streaming, universal-3-5-pro, format_turns)
   │        └─> POST /api/session/:id/utterance ────>  agent.js
   │                                                     ├─ extract.js  (rule slots: business/location/budget/problem)
   ├─ KO: energy VAD cuts one utterance -> WAV           ├─ llm.js      (optional, Anthropic SDK, JSON schema output)
   │        └─> POST /api/session/:id/voice-turn ───>    ├─ planner.js  (channel mix + priced picks + checklist)
   │              server: /v2/upload + /v2/transcript ─>  api.assemblyai.com (pre-recorded, universal-2 for ko)
   │                                                     └─ mcp.js ──── JSON-RPC ───────────────>  api.marketpilot.it/mcp
   │                                                            list_products · search_places · create_checkout
   ├─ TTS (Web Speech API) reads the reply; mic is muted while speaking (half-duplex)
   │
   └─ End: whole-call WAV -> POST /api/session/:id/analyze ──>  api.assemblyai.com/v2/transcript
                                                              speaker_labels · sentiment_analysis · auto_highlights · entity_detection
                                                              └─> brief.js -> "owner brief" (speakers, concerns, key phrases, entities)
```

Files:

| Path | Role |
|---|---|
| `server/index.js` | HTTP routes, session store, static serving of `dist/` in production |
| `server/lib/assemblyai.js` | temp token, upload + transcript + polling, feature downgrade retry |
| `server/lib/agent.js` | dialogue policy (slot filling, plan, confirmation), LLM or rules |
| `server/lib/extract.js` | Korean/English slot extraction (business, area, budget incl. USD, problems) |
| `server/lib/planner.js` | deterministic budget allocation over catalog products, checklist, spoken summary |
| `server/lib/brief.js` | AssemblyAI intelligence results -> structured owner brief |
| `server/lib/llm.js` | Anthropic SDK call with `output_config.format` JSON schema, `effort: low` |
| `server/lib/mcp.js` | MarketPilot MCP client with mock fallback (`server/data/products.mock.json`) |
| `web/src/main.js` | app orchestration (call lifecycle, half-duplex, analysis) |
| `web/src/stt.js` | `StreamingSTT` (AssemblyAI WebSocket) and `TurnVAD` (utterance cutter) |
| `web/src/lib/transcript.js` | pure Turn-event reducer + streaming URL builder (shared with tests) |
| `web/src/pcm-worklet.js` | AudioWorklet: resample to 16 kHz, Int16 frames, RMS |

---

## Where AssemblyAI is used

| # | Feature | Where | Notes |
|---|---|---|---|
| 1 | **Temporary streaming token** `GET https://streaming.assemblyai.com/v3/token?expires_in_seconds=60&max_session_duration_seconds=1800` | `server/lib/assemblyai.js` -> `GET /api/assemblyai/token` | API key never reaches the browser |
| 2 | **Universal-Streaming WebSocket** `wss://streaming.assemblyai.com/v3/ws` with `speech_model=universal-3-5-pro`, `encoding=pcm_s16le`, `sample_rate=16000`, `format_turns=true`, `language_detection=true`, `prompt=<domain context>`, `token=` | `web/src/stt.js`, URL built in `web/src/lib/transcript.js` | Browser sends 100 ms PCM16 chunks; `Turn` messages are reduced so each turn is emitted once (formatted final); `Terminate` on hang-up |
| 3 | **Pre-recorded transcription** (`POST /v2/upload`, `POST /v2/transcript`, poll `GET /v2/transcript/{id}`) with `language_code=ko`, `keyterms_prompt` | `server/lib/assemblyai.js` -> `POST /api/session/:id/voice-turn` | Korean path. Universal-Streaming does not cover Korean yet (AssemblyAI lists it as "coming soon"), so Korean runs per-utterance through the pre-recorded API where Universal-2 supports `ko`. Latency is a few seconds instead of sub-second; the UI shows "Transcribing (AssemblyAI)". |
| 4 | **Speaker labels** `speaker_labels=true` | `POST /api/session/:id/analyze` -> `server/lib/brief.js` | The speaker with the most words who is not echoing our TTS lines is the owner |
| 5 | **Sentiment analysis** `sentiment_analysis=true` | same | English only on AssemblyAI; negative sentences become "concerns". Korean falls back to keyword rules |
| 6 | **Key phrases** `auto_highlights=true` | same | English only; Korean uses frequency-based phrases |
| 7 | **Entity detection** `entity_detection=true` | same | places, money amounts, organizations mentioned by the owner |

If an intelligence feature is rejected for a language, `transcribe()` retries once with plain
transcription so the call still completes (`features_downgraded: true` in the response).

---

## LLM (optional) and the rule engine

- `LLM_API_KEY` (Anthropic) enables `server/lib/llm.js`: one `messages.create` per owner turn with a
  JSON-schema structured output (`reply`, `profile`, `ready_for_plan`, `owner_confirmed_plan`),
  `output_config.effort = "low"` for speed and cost, `max_tokens 1024`. Default model `claude-opus-5`
  (`LLM_MODEL` to override). A refusal stop reason, invalid JSON or any API error falls back to the
  rule engine for that turn; an authentication error disables the LLM for the process.
- The rule engine (`extract.js` + `agent.js`) always runs: it fills slots from every utterance and
  asks for the next missing one (business -> location for physical stores -> budget -> problem).
- Prices, product names and quantities are **never** generated by the LLM. `planner.js` allocates the
  budget over channels chosen by business type and nudged by the problems mentioned, using catalog
  unit prices and min/max order units, and guarantees `total_cost <= budget`.

## MarketPilot MCP

`https://api.marketpilot.it/mcp` (JSON-RPC over HTTP, Streamable HTTP style). Probed 2026-09-23:
`initialize` and `tools/list` answer **without authentication** for the shopper group
(`list_products`, `get_product`, `search_places`, `create_checkout`, `get_checkout_status`,
`submit_inquiry`). Account tools (`quote_order`, `list_my_orders`, points) need a linked account and
are not used.

- `list_products` -> catalog (222 products) cached 10 min. If the endpoint is unreachable the server
  loads `server/data/products.mock.json` (a snapshot of the same call taken 2026-09-23) and reports
  `catalogSource: "mock"` in `/api/health`; the UI badge shows `MCP: mock` and the checkout form
  explains that a real payment link cannot be created from the mock.
- `search_places` -> Naver Place candidates once a location and a physical business type are known
  (shown in the "What we heard" card, used in the checklist).
- `create_checkout` -> real card checkout URL from the plan's orderable items (`aiOrderable=true`).
  Inquiry-only products are listed separately and never priced.

---

## Configuration

`.env` (see `.env.example`):

| Variable | Required | Purpose |
|---|---|---|
| `ASSEMBLYAI_API_KEY` | for voice | temp tokens, transcription, call analysis |
| `LLM_API_KEY` | no | Anthropic key for the conversational layer (rules if empty). Do not reuse a production key |
| `LLM_MODEL` | no | default `claude-opus-5` |
| `MARKETPILOT_MCP_URL` | no | default `https://api.marketpilot.it/mcp` |
| `PORT` | no | API port, default 8787 (Vite proxies `/api` to it) |

Production: `npm run build` then `NODE_ENV=production node server/index.js` serves `dist/` and the
API from one process (needs HTTPS for `getUserMedia` on anything but localhost).

---

## Tests

`npm test` runs `node --test` over `server/test/*.test.js` (47 tests, all offline with injected
`fetch`/clients):

- `transcript.test.js` streaming URL only carries the temp token; Turn reducer emits each turn once (formatted), flush on close
- `assemblyai.test.js` token route (no key -> `no_key`, 401 -> `bad_key`), upload/transcript/poll, Korean never asks for English-only features, downgrade retry
- `extract.test.js` Korean/English slots, budget parsing (만원, 원, won, $ with conversion), locations, merge order
- `planner.test.js` total <= budget, min/max units, problem-driven mix, default budget assumption, inquiry items, checkout items
- `brief.test.js` owner detection vs TTS echo, sentiment -> concerns, key phrases, entities, Korean fallback
- `mcp.test.js` live parsing + cache, mock fallback with reason, tool errors, checkout call shape
- `llm.test.js` structured output request shape, user-first history, refusal/invalid JSON -> null
- `agent.test.js` full Korean and English rule-based calls, LLM path and fallback
- `server.test.js` real HTTP server on an ephemeral port: health, token, session flow, voice-turn, analyze, checkout failure honesty

Browser-side audio (mic, WebSocket, TTS) needs a real browser and a key; it is not covered by the
unit tests.

---

## Submission checklist (lablab.ai, due 2026-09-30)

- [x] Uses AssemblyAI (streaming + pre-recorded + 4 audio-intelligence features)
- [x] Runs locally with `npm run dev`; degrades honestly without keys
- [x] Unit tests pass (`npm test`)
- [x] Pitch deck draft: `docs/pitch.md` (8 slides, English)
- [x] Demo video script: `docs/video-script.md` (60-90 s, English)
- [ ] `ASSEMBLYAI_API_KEY` added to `.env` and a real English + Korean call tested end to end
- [ ] Optional `LLM_API_KEY` (project-specific key, not the production one) and 2-3 test turns
- [ ] Deploy the built app behind HTTPS (single Node process; e.g. Render/Fly/EC2 + Caddy) and put the URL in the submission
- [ ] Record the 60-90 s demo (see script), upload, add link
- [ ] Turn `docs/pitch.md` into slides (Google Slides / Pitch), export PDF
- [ ] Public GitHub repo link + README (this file) in the lablab.ai submission form
- [ ] Team page on lablab.ai filled (team name, members, project title, category)

## Known limits

- Korean is not streamed in real time (AssemblyAI streaming languages as of 2026-09: en, es, fr, de,
  it, pt, tr, nl, sv, no, da, fi, hi, vi, ar, he, ja, zh). The per-utterance path is honest about it.
- Sentiment and key phrases are English-only on AssemblyAI; Korean uses keyword rules.
- Half-duplex: the mic is ignored while the consultant speaks, so barge-in is not supported.
- Sessions live in memory; restart the server and they are gone.
- The rule engine's vocabulary is a curated list (11 business types, 11 problems, ~90 areas); an LLM
  key makes the conversation much more forgiving.
