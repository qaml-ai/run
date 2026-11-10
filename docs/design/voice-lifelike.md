# Lifelike voice: what it takes, and our path

Status: proposal, 2026-10-18. Research only: nothing here changes production. The probe in
`scripts/voice-s2s-latency.ts` is a stand-alone script.

The question: our Discord voice bots should feel like OpenAI's Realtime voice and the other speech-to-speech (S2S)
systems. What would that take, and which path should we pick? Thinking Machines Lab is covered in its own section.

## Recommendation

1. **Most of the gap is latency we add ourselves, not the cascade.** In production a camel bot answers **3.7 s** after
   someone stops talking (p50; p90 6.2 s).
   - 2.0 s of that is the bot's code waiting for a whole `ctx.ai` answer before `ctx.reply`.
   - The model's settings matter as much: the probe measured DeepSeek V4.1 Flash's first clause at 2.7 s with default
     routing and reasoning, and at 0.42 s on `:nitro` with reasoning off.
   - Three cheap changes bring the same cascade to about **1.35 s**: stream the bot's answer, live STT with #262's
     early commit, and a voice-tuned model route.
   - That is within ~0.2 s of Gemini 3.8 Live in our pipeline: 1.2 s, once it waits for the same end of turn.
   - Speculative starts and fillers take it toward 1 s.
2. **Keep the cascade as the brain.** Our bots run code and tools on every turn, sit in group calls with many
   speakers, and run on DeepSeek or Claude through our own billing and credits. No S2S API takes labelled audio from
   several speakers. They all tie us to one vendor's model for reasoning and tools. On cost, our cascade is about
   $0.015-0.02 per minute. That is level with Gemini Live, about a third of OpenAI Realtime (full model), and a quarter
   to a fifth of the managed agent platforms.
3. **Add S2S later, as an opt-in session `brain`**, Gemini Live first, for one-on-one "character" bots, where
   expressiveness matters more than tools. Our media plane, turn-taking, floor control and billing stay as they are.
   This is phase 3, after the cascade work, and only if blind listening tests say people can hear the difference.
4. **Watch Thinking Machines; don't build on it yet.** Their full-duplex interaction model (May 2026) has the best
   published turn-taking numbers, but there is no API, no pricing and no date. Their split of a fast duplex front with a
   slow reasoning back is the design we should grow toward. OpenAI's GPT-Live is the first API that ships it.
5. **Drop Hume EVI.** Hume ends EVI and its TTS on 2026-11-13.

## Where we are (measured)

### Production: 19 spoken turns, 4 sessions, camel-bots, 2026-10-18

These are from `voice_turn_latency` in `/ecs/camelai-agent-runtime`. Every turn took `Path=speak`: the
`voice.utterance` webhook, then the bot's `speech` handler, then `ctx.ai` (the whole answer), then `ctx.reply`, then
`POST …/speak`. No bot used `ctx.voice.converse`. Live STT is off, so transcription is batch `gpt-transcribe` after the
cut. This is a small sample (voice has been on in production for two days); re-read it from the dashboard once there
are a few hundred turns.

| Stage (ms after the last word) | p50 | p90 | What it is |
|---|---|---|---|
| turnCommit | 743 | 1,607 | Smart end of turn at its defaults (`commitMs` 500 after Smart Turn's call, up to 1,400 held) |
| transcript | 1,500 | 2,727 | Batch STT after the cut: **742 ms** p50 on its own |
| firstPiece | 3,330 | 5,922 | Webhook, the bot's code and `ctx.ai`'s whole answer, then `speak`: **1,966 ms** p50 on its own |
| ttsFirstAudio | 3,534 | 6,156 | TTS first audio: 233 ms p50 |
| firstPacket | **3,675** | **6,239** | The headline: end of speech to the first audio out |

The voice eval (`tests/voice-eval/README.md`, fake providers with a realistic profile) agrees on the shape: `bots-say`
2.9-3.8 s and `run-agent` 2.7 s, both before smart turns and the webhook kick.

A side finding: `voice_turn_latency.ttsModel` reads `gpt-4o-mini-tts` even on turns after ElevenLabs became the first
TTS in the chain (#248, live 18:15 UTC). The field comes from the session's default synthesizer, not from the
provider that served (`src/voice-sessions.ts:1148`). It should name the provider that served.

### The text step: the probe, 2026-10-18

`scripts/voice-s2s-latency.ts` runs the bake-off's synthetic clips, 10 clips that ask for something. Audio goes out in
real time.

Each S2S turn is ended by us at the end of speech (an oracle commit) unless marked VAD. The text step is a streamed
OpenRouter chat completion on the clip's words, to the first speakable clause. Runs came from a laptop, not from AWS,
so absolute numbers carry about 50-100 ms of extra network.

| Run | n | Result p50 (p90) |
|---|---|---|
| Gemini 3.8 Live, first audio after our commit | 20 | **645 ms** (850) |
| Gemini 3.8 Live, first audio with its own VAD (from the last word) | 10 | **1,177 ms** (1,744) |
| Gemini 3.8 Live, `--tool`: function call / first audio after the result | 10 | 604 / 1,144 ms (1,278) |
| DeepSeek V4.1 Flash, default routing and reasoning: first clause | 20 | **2,743 ms** (4,561) |
| DeepSeek V4.1 Flash, reasoning off: first clause | 20 | 1,214 ms (1,542); first token 1,057 |
| DeepSeek V4.1 Flash `:nitro`, reasoning off: first clause | 20 | **422 ms** (742); first token 406 |
| DeepSeek V4.1 Flash `:nitro`, reasoning off, `--tool`: call / first clause after the result | 10 | 466 / 806 ms (1,088) |
| Claude Haiku 5.5: first clause | 20 | 1,761 ms (2,267) |
| Claude Haiku 5.5, `--tool`: call / first clause after the result | 10 | 1,684 / 3,328 ms |
| OpenAI `gpt-realtime-2.1` | — | not run: no OpenAI key on this machine (`OPENAI_API_KEY=… --providers openai`) |

Two things stand out:

- **The model's routing and reasoning settings swing the text step by 6x** (2.7 s to 0.42 s). In a voice turn, the
  default route with reasoning on costs more than everything else put together.
- **Apples to apples, S2S is not much faster than a tuned cascade.** In our pipeline an S2S model would still wait for
  our end of turn (Smart Turn's commit, 580 ms median), so Gemini Live lands at about 580 + 645 ≈ **1.2 s**, the same as
  with its own VAD. A tuned cascade comes in at about 0.73 s for the text (live STT with #262's early commit) + 0.42 s
  for the first clause + 0.15 s TTS + 0.06 s playout ≈ **1.35 s**. The S2S edge is ~0.15-0.3 s, not seconds.

## What makes voice feel alive

These are ranked by how much people notice them, from the research below and our own eval.

1. **Gap after a turn.** People leave about 200 ms between turns, with a spread of about ±250 ms across languages
   (Stivers et al., PNAS 2009). Voice-agent practice targets **≤ 800 ms p50 and ≤ 1.5 s p95** from voice to voice
   (Daily/Pipecat; Hamming suggests a p95 under 800 ms). Past 1.5 s people re-ask or talk over the bot. At 3.7 s, we
   are past that point on most turns. This dwarfs every other item.
2. **Not being cut off, and not being talked over.** Turn-taking errors read as rude more than slowness does.
   Smart Turn (merged) holds 87% of mid-thought pauses. Floor control and addressing (#261) cover group calls.
3. **Barge-in that stops at once, and a bot that knows what was heard.** We stop within `minMs`, with an echo check.
   One gap: after a barge-in the agent's history still holds the whole reply it wrote, not the part that was played.
   OpenAI's Realtime truncates the item to `audio_end_ms`. We should do the same.
4. **Prosody that fits the moment.** Flash-class TTS is fast but flat. Expressive models (ElevenLabs v3/v4 with audio
   tags, Cartesia Sonic-3 emotion controls, OpenAI `gpt-4o-mini-tts` instructions) cost latency. Sesame's results show
   that conditioning on the conversation counts as much as tags: the same words, said for this context. S2S models win
   here by construction.
5. **Backchannels and fillers from the bot.** A bot that goes "mm, let me check" when a tool will take a second fills
   the gap the way people do. Full-duplex models do this natively. In a cascade it is a policy plus pre-made audio.
   We already hear people's backchannels (#260); the bot doesn't make any.
6. **Streaming everywhere.** STT while they talk, the LLM starting at a likely end of turn, TTS from the first clause,
   and the next piece made while one plays. The pipeline already streams TTS from the first clause and makes the next
   piece ahead (voice-streaming). The camel-bots `say` path throws that away by waiting for the whole answer.
7. **One voice, stable.** Keep one voice id per bot. Never fail over to another provider's voice in the middle of a
   reply (we already don't). With per-speech voices, keep a character's voice fixed across sessions.

## The landscape (2026-10-18)

V = vendor claim, M = third-party measurement, P = our probe. "First audio" for an S2S model is from the end of the
user's turn. Artificial Analysis (AA) measures on reasoning questions, so its numbers run higher than on chat turns.

| System | Kind | First audio | Duplex, backchannels | Tools | Languages | $/min* | Discord fit |
|---|---|---|---|---|---|---|---|
| **OpenAI Realtime** `gpt-realtime-2.1` / `-mini` (Jul 2026) | Native S2S, turn-based | AA 0.97-1.21 s; older model 232 ms p50 (M, small test) | VAD or semantic VAD; barge-in with truncate; no bot backchannels | Sync functions, remote MCP | Many | ~0.047 / ~0.015 | One mono stream; text items for who spoke |
| **OpenAI GPT-Live** `gpt-live-1` (Sep 2026) | Full-duplex front, reasoning in a backend agent you supply | AA 1.24-1.34 s; turn-taking 0.8 s (V) | Full-duplex, backchannels | Delegated to the backend (could be ours) | Many | 0.05 + backend | One stream; `session.thinking.append` |
| **Gemini 3.8 Live** (GA ~Sep 15) | Native audio | **P: 0.6 s after commit; ~1.2 s with its own VAD**; AA 1.18 s | Auto or manual activity; affective dialog; proactive audio (may stay quiet) | Functions, incl. NON_BLOCKING (async) with INTERRUPT / WHEN_IDLE / SILENT; Search | 70+ | ~0.01-0.03 | One 16 kHz stream; `clientContent` text; 10-15 min per connection without compression |
| **ElevenLabs Agents** | Managed cascade (Scribe → any LLM → Flash/v3) | ~0.5 s (M, one test) | Own turn model; v3 conversational "expressive mode" | Server/client tools; custom LLM (OpenAI-compatible) | 70+ | 0.08 (+LLM) | One stream |
| **Deepgram Voice Agent** | Managed cascade (Flux → LLM → Aura/others) | Flux end of turn ~260 ms (V) | Flux eager end of turn | Functions; BYO LLM and TTS | En + 10 | 0.05-0.075 | One stream |
| **Cartesia** Sonic-3.x, Ink-2, Line | TTS, STT, agent runtime | Sonic TTFA <90 ms (V), 188 ms (M) | n/a | Your code | 42+ (TTS) | 0.06 + LLM (Line) | We already have Sonic-3 |
| **xAI Grok Voice 3.0** | Native S2S | AA 0.81 s; #1 on AA's index | Turn-based | Functions, search | Many | 0.08 | One stream |
| **Amazon Nova 2 Sonic** | Native S2S | AA 1.14 s | Barge-in | Async tool calls | Several | ~0.015 | Bedrock bidirectional stream |
| **Hume EVI 3/4** | S2S plus LLM | — | — | — | — | — | **Shuts down 2026-11-13** |
| **Kyutai Moshi**, NVIDIA PersonaPlex, Nemotron VoiceChat, MiniCPM-o | Open full-duplex | ~0.2 s (V) | True duplex and backchannels | None or weak; AA BBA 4-27% | Mostly En | Self-host GPU | Single speaker; can't run our bots' code |
| **Kyutai Unmute** | Open cascade (STT with semantic VAD → any LLM → TTS) | "< 1 s" (V) | Semantic VAD | None native | En/Fr | Self-host GPU | Same shape as ours |
| **Sesame CSM** (CSM-1B open) | Contextual TTS | — | Not duplex | — | En | Self-host | A TTS that hears context; no API |
| **Ultravox**, Qwen3-Omni / Qwen Audio 3.0 Realtime, Step-Audio | Speech-in LLMs | AA 0.88-1.5 s | VAD | Yes | Many | 0.05 (Ultravox), lower for Qwen | One stream |

\* About one conversational minute: the user talks 50% of it and the bot 30%. OpenAI bills audio tokens and re-bills
history each turn, so its cost grows with session length and cache misses. Gemini lists $0.005/min audio in and
$0.018/min audio out. **Our cascade costs about $0.015-0.02 per minute**, mostly ElevenLabs Flash at $0.05 per 1k
characters. STT is $0.0045/min of speech (batch) or $0.002 (Soniox streaming). DeepSeek V4.1 Flash costs well under
$0.001 per minute, and Claude Haiku 5.5 about $0.002-0.004.

### Thinking Machines Lab

- **Interaction Models** (blog, 2026-05-11). `TML-Interaction-Small`: 276B MoE, 12B active. Full-duplex in 200 ms
  micro-turns, audio, video and text in one stream, with no VAD or turn-taking harness. An asynchronous background
  model does the reasoning, tools and search, and its results are "woven" back into the talk.
  - Vendor numbers against GPT-realtime-2.0 (minimal): FD-bench turn-taking latency 0.40 s vs 1.18 s; FD-bench v1.5
    77.8 vs 46.8; BigBench Audio 75.7% vs 71.8%. GPT-realtime at high reasoning still beats it on BigBench Audio
    (96.6%).
  - Status: they promised a "limited research preview in the coming months, wider release later this year". As of
    10-18 there is no API, no pricing and no preview announced. Access is by email (interaction@thinkingmachines.ai).
- **Inkling** (open weights, 2026-07-15): 975B MoE, 41B active, 1M context, natively takes text, images and audio. It
  is meant as the background model behind interaction models. **Inkling-Small** (2026-07-30): 276B/12B, "for audio
  intelligence".
- **Tinker**: their fine-tuning API (GA 2025-12), now with a sampling API in beta. Nothing voice-specific.
- **What it means for us.** The architecture is right: a duplex front end for timing, backchannels and interruptions,
  and a back end that thinks and runs tools. OpenAI's `gpt-live-1` is the same split, shipping now. Kyutai's MoshiRAG
  and NVIDIA's open duplex models point the same way. Our cascade already has the back end (camelRun agents). What we
  lack is a front end that talks while the back end works. Ask TML for preview access; there is nothing to build
  against yet.

## The Discord constraint: many speakers, one bot

Every S2S API takes **one mono stream from one user**. Discord gives us a separate Opus stream per speaker (SSRC to
user). Our pipeline relies on that: turn detection per speaker, addressing by name or conversation, floor control, the
echo guard, and `<@speaker>:` context for the agent. To put an S2S model in a group call we would have to do one of
these:

- **Mix everyone into one stream.** The model can't tell who spoke. Its VAD and barge-in fire on anyone, and it
  answers chatter it wasn't asked.
- **Gate the stream.** Forward only the speaker who holds the floor with the bot (our floor control decides), and send
  "[Alice is speaking]" as a text item before their audio. Gemini's proactive audio lets the model stay quiet. Overheard
  turns would still need our STT, to give the model context as text.
- **Keep our STT per speaker and feed text.** That is the cascade.

So in any S2S mode, our media plane, Smart Turn, addressing and floor control stay in front of the model. The model
is the voice and the brain for the one speaker who has the floor. That works well one on one, and is passable in a
small group with clear addressing.

## Options

### (a) S2S as the session's brain (a `brain: {provider: "gemini-live" | "openai-realtime"}` session option)

Shape:

- The media worker sends the floor holder's 16/24 kHz PCM to the provider's socket. That stream already exists for
  live STT.
- We end turns ourselves, with Smart Turn: manual activity, or `commit` + `response.create`. That keeps our
  turn-taking, echo guard and addressing, and gives the best latency the probe measured.
- Provider audio goes into `SessionSpeech` as one long speech, so barge-in, `stop` and billing work unchanged.
- Our tools bridge as functions, with each call run by the bot's agent (or `ctx` handlers) through camelRun's tool
  runner. Gemini's NON_BLOCKING functions let the model keep talking while a tool runs.
- Text injection carries the overheard turns and who-is-speaking.
- On barge-in, truncate the provider's item to what was played.

Costs and effort:

| | |
|---|---|
| $/min | Gemini 3.8 Live ~$0.01-0.03; OpenAI full ~$0.047, mini ~$0.015; plus our STT for overheard speakers |
| Effort | ~3-4 weeks for one provider behind a flag: provider socket, tool bridge, credits and usage records per token, session resume (Gemini's 10-15 min connections), transcripts back into the agent's history, eval |
| Gains | Prosody and emotion we can't match with Flash TTS; ~0.6 s after commit; the model hears tone (sarcasm, hesitation) |
| Loses | Our model choice (DeepSeek/Claude), cost control per bot, the bot's agent as the one brain (history split across two systems), the group-call semantics, and vendor portability. Tool-heavy turns get no faster: the tool still runs |

### (b) Keep the cascade, close the gap

Ranked by impact per effort. The latency estimates are p50 savings against today's 3.7 s.

| # | Change | Saves | Effort | Notes |
|---|---|---|---|---|
| 1 | **camel-bots voice bots stream their answers**: builder and docs default to `ctx.voice.converse` (or `ctx.ai` streamed into `ctx.reply`), and the `say` path speaks pieces as they come | **~1.2-1.6 s** | S (days) | Today's 2.0 s app stage is a whole `ctx.ai` answer. Streaming starts TTS at the first clause. The fix is in camel-bots, not camelRun |
| 2 | **Live STT on with a cheap streaming provider, plus #262's preemptive commit at likely end** | **~0.6-0.7 s** | S | Soniox ($0.002/min) or Deepgram, not OpenAI live ($0.017). The transcript then lands with the commit, not 742 ms after it |
| 3 | **A voice-tuned model route for voice turns**: reasoning off, throughput routing (`:nitro`, as the builder already uses, not an order pin), a short spoken-style prompt, chosen on first-clause p95 | **~0.8-2.3 s** (probe: 2.7 s → 0.42 s first clause) | S | camel-bots' `BOT_MODEL` applies to voice as well; voice needs its own setting. Needs the canary and turn-outcome watch for any model change. Claude Haiku 5.5 measured 1.76 s, which is too slow for the first sentence |
| 4 | **Speculative LLM start at `likely_end`** (#262's stats decide): run the agent turn on the preemptive transcript; discard on `resume` | ~0.3-0.5 s | M | 13% discard at commit 200/300, 43% at defaults. A discarded turn costs one extra LLM call (cheap on Flash) but must not run side-effecting tools: gate tools until commit |
| 5 | **Lower `commitMs` when Smart Turn is confident** (e.g. 250 ms at p≥0.8, 500 otherwise) | ~0.2 s | S | Measure with `voice-turns-eval.ts`; the cost is more mid-thought cuts |
| 6 | **Bot fillers and acknowledgements**: when the first token or a tool call will take > ~700 ms, play a short pre-made filler in the bot's voice ("mm, one sec") | perceived ~0.5-1 s on tool turns | M | Cached per voice; at most one per turn; never in the middle of a reply |
| 7 | **Heard-only history on barge-in**: on a barge-in stop, rewrite the agent's last reply in its history to the part that was played, plus "(cut off)" | quality | S | Same as Realtime's truncate |
| 8 | **Expressive TTS where it can afford it**: emotion and pace hints per piece (Cartesia Sonic-3 controls, ElevenLabs v3/v4 when realtime); the LLM writes a tone tag per sentence; context conditioning when providers offer it | prosody | M | Keep Flash for the first clause, a richer model after, only if A/B listening says it's better |
| 9 | **TTS keep-warm and region**: keep the ElevenLabs socket warm through the session; run voice in the region nearest the call | 50-150 ms | S | |
| 10 | Fix `ttsModel` in `voice_turn_latency`: name the provider that served | observability | XS | |

With 1-3, a turn takes:

| Step | ms |
|---|---|
| Transcript (#262's measurement, live STT committed at likely end) | ~730 |
| First clause on the nitro route | 420 |
| TTS | 150 |
| Playout | 60 |
| **Total, p50** | **~1,350** |

A streaming provider that finalizes faster than #262's 400 ms test stub, plus 4 and 5, gets this to **~1.0-1.1 s**.
Turns that call a tool add the tool's time (466 ms to the call on the probe, then 806 ms to the first clause). Fillers
(6) cover that wait.

Cost per minute stays ~$0.015-0.02. The live STT stream adds ~$0.001-0.002.

### (c) Other options

- **A managed agent platform (ElevenLabs Agents or Deepgram Voice Agent with a custom LLM pointed at camelRun).** It
  keeps our brain, but costs $0.05-0.08/min plus the LLM (3-5x ours), adds a hop, and is still one stream per user. It
  buys little that (b) doesn't.
- **A duplex front end over our back end** (the TML / GPT-Live split). `gpt-live-1` talks, backchannels and handles
  interruptions, and hands reasoning and tools to a backend agent that could be the bot's camelRun agent. It is $0.05/min
  plus the backend. Of all the options, this is the one most likely to feel "alive", and the one that keeps our agents as
  the brain. But it is new (Sep 2026), single-speaker, and has no independent latency data. We would prototype it next
  to (a) in phase 3, not first.
- **Self-host open duplex models** (Moshi or PersonaPlex as the front end, our agent behind). Timing is the best
  available, but reasoning is weak, models are English-mostly, licenses are mixed (Kyutai's RL models are
  non-commercial), and it needs GPUs we don't run. Not now.

## Plan

### Phase 1 (this week and next): turn on what we have, and fix the app path

- camel-bots: voice bots stream. The builder writes `ctx.voice.converse` (or streamed `ctx.reply`) for voice bots;
  migrate existing voice bots' handlers; the voice guide says why. This is (b)1.
- camelRun: land #262, turn on live STT for speaking sessions with Soniox, then Deepgram, then batch as the chain
  ((b)2).
- camel-bots and camelRun: a voice model route, with reasoning off on a throughput route, chosen with the probe and
  rolled out through a canary and the turn-outcome watch ((b)3).
- Fix the `ttsModel` label, and add `VoiceFirstPacketMs` p50 to the dashboard next to p95.
- Exit: production p50 ≤ 1.5 s, p95 ≤ 3 s, from `voice_turn_latency`.

### Phase 2 (2-4 weeks): the last second

- Speculative start at `likely_end` with tools gated until commit, if `discardRate` allows ((b)4). Then confidence-scaled
  `commitMs` ((b)5).
- Bot fillers on slow turns ((b)6), and heard-only history ((b)7).
- An expressive-TTS A/B in blind listening, on recorded calls: Flash vs Sonic-3 with emotion vs ElevenLabs
  v3/v4 ((b)8).
- Exit: p50 ≤ 1.0 s; listening tests show which TTS wins.

### Phase 3 (after phase 2, if listening tests still favour S2S): `brain: "gemini-live"`

- Behind a flag, for one-on-one character bots: the shape in (a), Gemini 3.8 Live first (cheapest, async tools,
  measured fastest), OpenAI Realtime second.
- A `gpt-live-1` prototype with the bot's camelRun agent as its backend: the duplex-front option.
- Re-check Thinking Machines' preview.

## What to prototype first

1. **A camel-bots voice bot on `converse` with the nitro, reasoning-off route, against today's `ctx.ai` +
   `ctx.reply`.** Run it in the preview panel and one real call, and read `voice_turn_latency`. These are the two
   biggest wins together, and they are cheap to confirm.
2. **This PR's probe from AWS, with an OpenAI key.** Run `scripts/voice-s2s-latency.ts` with `OPENAI_API_KEY` for
   OpenAI Realtime 2.1 (`--vad`, `--tool`), from a runtime-region host, so the network matches production. Gemini and
   the text step are measured above. It takes minutes and costs cents.
3. **The voice eval's `bots-agent` pipeline with live STT + #262**, to put a number on (b)2 before production.
4. Only then: a Gemini Live `brain` spike in a browser session (`provider: "browser"`), which needs no Discord. It
   would show tool bridging and barge-in truncation end to end in about a week.

## Sources

Fetched 2026-10-18 unless dated.

- **OpenAI:**
  - [pricing](https://developers.openai.com/api/docs/pricing)
  - [Realtime conversations](https://developers.openai.com/api/docs/guides/realtime-conversations)
  - [VAD](https://developers.openai.com/api/docs/guides/realtime-vad)
  - [Realtime MCP](https://developers.openai.com/api/docs/guides/realtime-mcp)
  - [costs](https://developers.openai.com/api/docs/guides/realtime-costs)
  - [gpt-live-1](https://developers.openai.com/api/docs/models/gpt-live-1)
  - [live conversations](https://developers.openai.com/api/docs/guides/live-conversations)
  - [gpt-realtime-2.1 coverage](https://datanorth.ai/news/openai-releases-gpt-realtime-2-1-voice-models) (Jul 2026)
- **Gemini:**
  - [pricing](https://ai.google.dev/gemini-api/docs/pricing) (updated 10-16)
  - [models](https://ai.google.dev/gemini-api/docs/models) (10-13)
  - [Live guide](https://ai.google.dev/gemini-api/docs/live-guide) (09-18)
  - [sessions](https://ai.google.dev/gemini-api/docs/live-session) (09-15)
  - [tools](https://ai.google.dev/gemini-api/docs/live-tools) (09-15)
- **ElevenLabs:**
  - [API pricing](https://elevenlabs.io/pricing/api)
  - [expressive mode](https://elevenlabs.io/docs/eleven-agents/customization/voice/expressive-mode)
  - [custom LLM](https://elevenlabs.io/docs/eleven-agents/customization/llm/custom-llm)
  - [v3 not for realtime](https://help.elevenlabs.io/hc/en-us/articles/35869142561297)
- **Deepgram:**
  - [pricing](https://deepgram.com/pricing)
  - [Voice Agent configuration](https://developers.deepgram.com/docs/configure-voice-agent)
  - [Flux launch](https://www.businesswire.com/news/home/20251002758871/en/) (2025-10-02)
- **Cartesia:**
  - [pricing](https://cartesia.ai/pricing)
  - [Line](https://docs.cartesia.ai/line)
- **Hume:** [EVI docs, with the sunset notice](https://dev.hume.ai/docs/speech-to-speech-evi)
- **Thinking Machines:**
  - [Interaction Models](https://thinkingmachines.ai/blog/interaction-models/) (2026-05-11)
  - [Inkling](https://thinkingmachines.ai/news/introducing-inkling/) (07-15)
  - [Inkling-Small](https://thinkingmachines.ai/news/inkling-small/) (07-30)
  - [news](https://thinkingmachines.ai/news/)
  - [The Decoder](https://the-decoder.com/thinking-machines-lab-ships-its-first-model-and-argues-interactivity-is-what-openai-gets-wrong-about-voice/) (05-12)
- **Kyutai:**
  - [Moshi](https://github.com/kyutai-labs/moshi)
  - [Unmute](https://github.com/kyutai-labs/unmute)
  - [STT](https://github.com/kyutai-labs/delayed-streams-modeling)
  - [interactivity RL](https://kyutai.org/blog/2026-06-10-interactivity/) (06-10)
  - [MoshiRAG](https://github.com/kyutai-labs/moshi-rag)
- **Sesame:** [Crossing the uncanny valley of voice](https://www.sesame.com/research/crossing_the_uncanny_valley_of_voice) (2025-02-27)
- **Benchmarks and roundups:**
  - [Artificial Analysis speech-to-speech](https://artificialanalysis.ai/speech-to-speech)
  - [Coval TTS benchmark](https://www.coval.ai/blog/best-text-to-speech-providers-in-2026-how-to-choose-(and-why-vendor-benchmarks-lie)/) (09-08)
  - [kenimoto.dev five stacks](https://kenimoto.dev/blog/five-voice-ai-stacks-only-two-under-300ms/) (05-13; small sample)
  - [xAI models](https://docs.x.ai/docs/models)
  - [Ultravox pricing](https://www.ultravox.ai/pricing)
  - [futureagi roundup](https://futureagi.com/blog/best-voice-ai-september-2026/) (10-05)
- **Turn-taking and practice:**
  - [Stivers et al., PNAS 2009](https://doi.org/10.1073/pnas.0903616106)
  - [Pipecat turn strategies](https://docs.pipecat.ai/server/utilities/turn-management/user-turn-strategies)
  - [LiveKit turn tuning](https://docs.livekit.io/agents/logic/turns/tuning/)
  - [Hamming metrics](https://hamming.ai/resources/voice-agent-evaluation-metrics-guide)
  - [voiceaiandvoiceagents.com](https://www.voiceaiandvoiceagents.com)
