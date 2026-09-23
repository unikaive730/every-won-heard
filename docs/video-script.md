# Demo video script (60-90 seconds, English)

Format: screen recording of the app at 1440x900 with the presenter's voice, small webcam bubble
optional. Record the English flow first (true streaming); show the Korean flow as a 5-second cut.

Timing targets in brackets. Total about 80 seconds.

---

**[0:00-0:08] Hook (title card, then app on screen)**

> "Five million business owners in Korea do marketing by guesswork, because the agency intake call
> never fits a 12-hour shift. So we turned that call into a voice agent."

**[0:08-0:15] Start the call**

Click **Start call**. The consultant's greeting plays through the speakers, badges show
`AssemblyAI key ok`, `MCP live`.

> "Press Start and talk. AssemblyAI Universal-Streaming transcribes as I speak."

**[0:15-0:35] The conversation (speak naturally, leave the partials visible)**

Say:
> "I opened a ramen shop near Hongdae two months ago. Weekdays are dead, nobody comes before six,
> and I have maybe three reviews on Naver. I can spend about five hundred thousand won a month."

Point at the right column as the chips fill: *restaurant · Hongdae · 500,000 KRW · not enough
customers, few reviews, just opened*.

Consultant replies with the plan summary. Let it speak for ~6 seconds, then lower the volume.

> "Three slots, one plan. Channel split, real products, quantities inside the budget,
> and a checklist for this week. Every price comes from MarketPilot's live MCP catalog, not from a
> language model."

**[0:35-0:45] Close the deal**

Say:
> "Go ahead."

Consultant points to the checkout button. Type a name, click **Create checkout link**, show the URL.

> "One sentence and the owner has a card checkout link. No signup."

**[0:45-0:65] End the call, show the analysis**

Click **End call**. The analysis card shows "AssemblyAI is analyzing the whole call" for a few
seconds, then renders.

> "After the call, AssemblyAI's speaker labels, sentiment analysis, key phrases and entity detection
> turn the recording into a brief: who spoke, which sentences were negative, the owner's own words,
> and the facts they named. Those problems feed back into the plan."

Hover the quote *"Weekdays are dead, nobody comes before six."* and the entities line.

**[0:65-0:75] Korean cut (pre-recorded 5-8 s clip)**

Show the Korean session: chips fill from a Korean utterance, plan in Korean.

> "Korean works today through AssemblyAI's pre-recorded model per utterance, and switches to
> streaming the day AssemblyAI ships Korean streaming. Same reducer, same UI."

**[0:75-0:82] Close**

Title card with repo URL and team.

> "MarketPilot Voice Consultant. Built on AssemblyAI. Thank you."

---

## Recording checklist

- `.env` has `ASSEMBLYAI_API_KEY`; `npm run dev`; open `http://localhost:5173` in Chrome.
- Chrome: allow the microphone once; pick a Google or Microsoft English voice (Settings > Languages >
  Speech) so TTS sounds natural.
- Speak in full sentences and pause 1 second at the end so end-of-turn fires cleanly.
- Keep the LLM badge visible either way; if `LLM_API_KEY` is set the bubbles show `llm`, otherwise `rules`.
- Record with OBS or Loom at 30 fps; mute notifications; hide bookmarks bar.
- Export 1080p MP4; upload unlisted to YouTube; paste the link in the lablab.ai submission.
