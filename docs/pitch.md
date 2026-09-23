# MarketPilot Voice Consultant - pitch deck (draft, 8 slides)

lablab.ai x AssemblyAI Voice Agent Hackathon, September 2026

---

## Slide 1 - Title

**MarketPilot Voice Consultant**
*You talk about your store. A priced 30-day marketing plan comes out.*

A voice agent for small business owners, built on AssemblyAI Universal-Streaming and AssemblyAI
audio intelligence, connected to MarketPilot's live marketing catalog.

Team: MarketPilot (Seoul). Demo: live voice call, Korean and English.

---

## Slide 2 - The problem

- Korea has 5.7 million self-employed business owners. Most run a cafe, restaurant, salon, gym, clinic
  or a small online store, and most of them do marketing by guesswork.
- A first consultation with a marketing agency takes a 30-60 minute call, a follow-up email, and a
  quote days later. Owners who work 12-hour shifts do not book that call.
- Chat-based tools do not fit either: owners describe their situation in spoken sentences
  ("weekdays are dead, I have maybe three reviews"), not in forms.
- What they need is the agency intake call, at 9 pm, in their own words, ending with a plan they can
  actually buy.

---

## Slide 3 - The solution

**A voice consultant that listens like an account manager and answers like a planner.**

1. The owner presses Start and talks. Live transcript on screen.
2. The agent asks only what is missing: business, location, monthly budget, most urgent problem.
3. A 30-day plan appears with real products, quantities and prices, always inside the budget,
   plus an action checklist (what to prepare this week).
4. The owner says "go ahead" and gets a card checkout link, no signup.
5. After the call, the recording becomes a structured brief: who spoke, what the owner actually
   complained about, key phrases, places and amounts mentioned.

Works in Korean and English. Degrades to a typed chat when there is no microphone.

---

## Slide 4 - Demo flow (what the judges will see)

```
[Start]  "Hi, this is MarketPilot's marketing consultant..."
Owner:   "I opened a ramen shop in Hongdae two months ago. Weekdays are dead."
         -> chips: restaurant · Hongdae · problem: not enough customers · just opened
Agent:   "Got it, a restaurant in Hongdae. Roughly how much can you spend per month?"
Owner:   "About 500,000 won."
Agent:   "Here is a 30-day plan for your Hongdae restaurant. Naver Place traffic 40%,
          receipt reviews 30%, blogger posts 20%... totaling 496,000 KRW. Say go ahead if it works."
         -> plan card + checklist + Naver Place candidates found via MCP
Owner:   "Go ahead."
Agent:   "Press Create card checkout link on screen..."
[End]    -> Call analysis: Speaker B 82% (owner) · concerns: "Weekdays are dead, nobody comes before six."
            key phrases: ramen shop, weekdays, three reviews · entities: Hongdae, 500,000 won, Naver
```

---

## Slide 5 - How AssemblyAI powers it

| Moment | AssemblyAI feature | Why it matters |
|---|---|---|
| Live call (EN + 17 languages) | **Universal-Streaming** (`universal-3-5-pro`, formatted turns, end-of-turn detection) | sub-second partials; formatted finals go straight into slot extraction |
| Security | **Temporary streaming tokens** | the browser only ever holds a 60-second token |
| Live call (Korean) | **Pre-recorded API per utterance** (Universal-2 `ko`) with `keyterms_prompt` | Korean streaming is not available yet; we ship an honest fallback today and flip to streaming when it lands |
| After the call | **Speaker labels** | separates the owner from a co-owner, staff or our own TTS echo |
| After the call | **Sentiment analysis** | negative sentences = the real pain points, quoted verbatim |
| After the call | **Key phrases** + **Entity detection** | the owner's own vocabulary and the hard facts (area, amounts, competitors) |

The brief is not decoration: problems found in it are merged into the profile and the plan is
re-built.

---

## Slide 6 - Architecture

- **Browser**: Vite + vanilla JS. AudioWorklet resamples the mic to 16 kHz PCM16. English: WebSocket
  straight to AssemblyAI with the temp token. Korean: energy VAD cuts utterances, WAV to the server.
  Browser TTS reads replies; half-duplex mute while speaking.
- **Server**: Node 22, no framework. Token minting, transcription proxy, session state, planner,
  MCP client. 47 offline unit tests.
- **Agent**: rule engine always on (slot extraction in KO/EN, budget parsing incl. USD, 11 business
  types, 11 problem classes). Optional LLM layer (Anthropic, JSON-schema output, low effort) for
  natural wording. Prices never come from the LLM.
- **MarketPilot MCP** (`api.marketpilot.it/mcp`, public): `list_products` (222 SKUs),
  `search_places` (Naver Place), `create_checkout` (card link, no signup). Mock snapshot fallback
  with a visible "mock" badge.

---

## Slide 7 - Team and why us

- **MarketPilot** is a Seoul marketing-execution platform for self-employed owners and small brands
  (Naver Place, blog reviews, receipt reviews, press, Instagram, app marketing). The catalog and
  checkout in this demo are the production ones.
- Hyogeon Kim, founder (Seoul National University; full-stack, AI agents, MCP server author).
- We already sell these plans through human consultants; this project turns the intake call into
  software and connects it to the products we fulfil ourselves.

---

## Slide 8 - What is next

- **Korean streaming** the moment AssemblyAI ships it (one query parameter change; the reducer and
  UI are already language-agnostic).
- **Barge-in** with AssemblyAI end-of-turn confidence and `agent_context` so the owner can interrupt.
- **Phone channel**: same server behind a SIP/Twilio bridge so owners can call a number.
- **Follow-up calls**: 30 days later, read Naver Place visits, review count and sales, and re-plan
  by voice.
- **Multi-owner sessions**: speaker labels already tell us who is talking; next is per-speaker
  action items for co-owners.

Repo: `github.com/<org>/marketpilot-voice-agent` (to be published). Demo video: link in submission.
