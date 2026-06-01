# Onboarding Interview — WhatsApp-driven KB seed

The new-client onboarding flow. Bot conducts a conversational interview over WhatsApp that simultaneously:
- Populates **Layer 1** (structured facts: `client_profile`)
- Builds **Layer 2** (voice library: pinned samples + computed style profile)
- Seeds **Layer 3** (semantic memory: every answer becomes a kb_chunk)
- Frames **goals** so the strategist has commercial context for every future reply

Total time: ~30 min spread over 1–3 sessions. Adrian can pause/resume. Each batch saves to Supabase so nothing's lost if WhatsApp closes.

## Interview structure — 5 batches × 5–7 questions each

### Batch 1 — Business basics (5 min)

Populates L1 client_profile.

1. *"What's the legal business name + the name customers actually call you?"*  → `legal_name`, `display_name`
2. *"What suburbs do you mostly work in? List as many as you want."* → `suburbs_served[]`
3. *"What are your main services? Just the way you'd describe them to a customer."* → `services[]` + first voice sample
4. *"What paint brands do you use most? Any you refuse to touch?"* → `brands_used[]`, `brands_avoided[]`
5. *"Who's on the team? First names + what they do."* → `staff[]`
6. *"Hours? When can people call?"* → `hours`
7. *"What's your warranty / guarantee like? In your words."* → `warranty` + voice sample

### Batch 2 — Goals & growth (5 min)

These shape what the strategist's *recommendations* prioritise.

1. *"In your own words — what does a great month look like for the business?"* → `goals.success_definition` + voice sample
2. *"What's been growing well lately? What's stuck?"* → `goals.growth_signals`, `goals.stuck_areas`
3. *"If you doubled bookings tomorrow, what suburb / type of job would you want them to be?"* → `goals.ideal_pipeline_mix`
4. *"What's a customer you'd love more of?"* → `goals.ideal_customer` + voice sample
5. *"What's a customer or job type you avoid?"* → `goals.avoid_segments`

### Batch 3 — Voice elicitation (10 min)

Direct voice-sample collection. Three asks, frictionless.

1. *"Open your phone's gallery for me. Send 3 of your last GBP posts — just screenshot them and send. I'll pull the captions."*  
   → Bot OCR's the screenshots → 3 voice samples
2. *"Forward me the last 3 customer emails you wrote yourself. Just hold-tap, forward to me."*  
   → 3 more samples
3. *"Tell me about the last job you finished — just talk through it in a voice note like you would on the phone."*  
   → Whisper transcribes → 1 long-form sample + L3 KB content

That gives us 7 voice samples in ~10 minutes with near-zero friction. Beats waiting for him to "send 25 samples".

### Batch 4 — Customers & jobs (5 min)

Seeds L3 with rich, story-level context.

1. *"Quick story: best job you've done in the last year? Why was it good?"* → kb_chunk + voice
2. *"Worst job? Or worst customer? Doesn't have to be named."* → kb_chunk
3. *"What's a question customers always ask that you wish they didn't?"* → kb_chunk (great for FAQ content later)
4. *"Something customers don't realise about painting that you wish they did?"* → kb_chunk + likely voice sample
5. *"A product you swear by + why."* → kb_chunk
6. *"A product you won't touch + why."* → kb_chunk

These are pure gold for content generation — Adrian wouldn't think to write any of this down, but it's exactly what makes content sound authentic.

### Batch 5 — Competition & market (5 min)

Names competitors so the bot can track them, plus differentiation framing.

1. *"Who do you think are your real competitors in Cairns? Up to 5."* → `competitors[]` for Semrush tracking
2. *"What do they do better than you? Be honest."* → `competitive_position.gaps`
3. *"What do you do better than them?"* → `competitive_position.strengths` + voice sample
4. *"Is there a suburb or job type where you wish you ranked higher?"* → `priority_targets`

## Bot interview UX

- One question per WhatsApp message. Adrian replies. Bot acknowledges briefly, asks next.
- *"Skip"* or *"come back to this"* always available.
- Bot saves progress after every answer — no "start over" pain if WhatsApp drops.
- Bot drops Adrian's own phrasing back to him verbatim sometimes: *"Got it — you said you 'won't touch Wattyl on weatherboards.' Adding that to your no-go list."* — confirms understanding + signals the bot is listening.
- After each batch: bot tells him what it learned and asks if anything's wrong.
- After all 5 batches: *"Right — I've got enough now to talk to you properly about your business. Send `/start` whenever you want to ask me something or get a report."*

## What's already populated after the interview

- **L1 client_profile** — ~25 structured fields, all from his own words
- **L2 voice_samples** — 7–10 high-quality samples, all genuinely his
- **L2 stylometric profile** — computed from the samples (avg sentence length, contractions, emoji usage, signature phrases extracted via Claude)
- **L3 kb_chunks** — every story-form answer embedded
- **client_intelligence (L5)** — first-pass brand voice summary generated from the interview itself
- **competitors[] + tracked_keywords** — ready for Semrush Position Tracking sync
- **goals** — feeds every future strategist response with commercial context

## Implementation order

1. Interview state machine (Vercel Workflow DevKit — it survives long pauses cleanly)
2. WhatsApp message handlers for each question type (text, voice, image)
3. Whisper transcription pipeline (already on the build list)
4. OCR for screenshots (Vision call to Claude — extracts captions from GBP screenshots)
5. Auto-save to Supabase after every answer
6. End-of-interview summary + Claude-generated brand voice draft
7. Test end-to-end on Adrian first (he IS client #1 — meta-validation)

Estimated: ~10 hours focused build, slots in after the conversation orchestrator.
