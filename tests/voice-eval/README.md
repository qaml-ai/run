# Voice eval

Scripted Discord voice calls played in real time through camelRun's voice sessions, with the bot's answers heard back
and scored. It is the scoreboard for voice: run it before and after a change to the pipeline, turn-taking or providers.

```sh
npm run eval:voice                                         # every pipeline, one at a time (about 4 minutes)
VOICE_EVAL_PIPELINES=run-agent VOICE_EVAL_SCENARIOS=barge-in,backchannel npm run eval:voice
VOICE_EVAL_PROFILE=instant npm run eval:voice              # providers that take no time: the pipeline's own latency
VOICE_EVAL_PROVIDERS=openai OPENAI_API_KEY=… npm run eval:voice   # real transcription and speech (costs a few cents)
VOICE_EVAL_OUT=/tmp/voice-eval npm run eval:voice          # also writes /tmp/voice-eval.md and .json
VOICE_EVAL_SPEAKERS=clips npm run eval:voice              # speakers are real people's clips (tests/fixtures/voice-turns, or VOICE_EVAL_CLIPS=<dir>)
```

CI runs `tests/voice-eval.test.ts` with fake providers (all pipelines at once, about a minute). It checks the harness
works and prints the scoreboard; it does not yet fail on a score.

## What runs, and what is faked

Real: `VoiceSessions`, the `Segmenter` (cuts, quiet threshold, silence timer), transcription and speech queues,
barge-in, `SpokenReply`, the playback jitter buffer (`buffered`), the webhook outbox and its sender (at the runtime's
default interval, 5 s, kicked as each voice event commits, as src/node.ts does), a real Postgres.

Faked:

- **Discord**: packets go straight to the session's handlers (no UDP, no DAVE); played packets are timed at 20 ms each,
  as Discord's player sends them. A client sends 200 ms of quiet frames after speech, then five silence frames, then
  nothing (an open mic keeps sending room tone). A pause up to 300 ms inside a turn is held (quiet frames); a longer one
  stops the client.
- **Speakers** (`audio.ts`): a voiced sound at about -20 dBFS with moving pitch and loudness, plus each speaker's
  noise; or, with `VOICE_EVAL_PROVIDERS=openai`, each line spoken by OpenAI's speech API (cached in `.cache/`). Every
  packet is remembered with the turn and frame it carries.
- **Transcription**: the words of the frames an utterance holds (so a cut at a pause gives half a sentence), after the
  profile's latency; or OpenAI's.
- **Speech**: a tone of the text's length (14 characters a second), first audio after the profile's latency; or OpenAI's.
- **The model writing answers**: the scenario's scripted answer, first token and speed from the profile.
- **The app**: camel-bots as a model. Its bot code answers an utterance that names the bot (`/\bmochi\b/i`), as the
  bot-authoring docs show.

Profiles (`harness.ts`, `PROFILES`): `realistic` assumes transcription 450 ms + 30 ms per second of audio, speech
350 ms to first audio, a model with 600 ms to first token and 250 characters a second, camel-bots 150 ms from webhook to
call, each varying by 25%. These are assumptions, not measurements: the `openai` providers measure the real ones.

## Pipelines

| name | path |
|---|---|
| `bots-say` | camel-bots bot code today: `voice.utterance` webhook, the speech handler, `ctx.ai` (whole answer), `ctx.reply` spoken with `POST …/speak` |
| `bots-agent` | camel-bots bot answering with its agent: webhook, prompt with `speak: {session}`, spoken sentence by sentence as written |
| `run-agent` | camelRun alone: `deliver.agent` with `speak: {agentReplies: true}`, no webhook hop |
| `bots-agent@poll` | `bots-agent` as before #230: voice events wait for the webhook sender's next run (every 5 s) instead of being sent as they commit |

To add one (a session option another change adds, a new turn-taking mode), add it to `PIPELINES` with its `session`
settings.

## Scenarios

`scenarios.ts`: one person's Q&A; group chatter with two questions for the bot; barge-in (cutting the bot off with a new
question); backchannels ("mm-hm" while the bot talks); thinking pauses mid-sentence (600-1000 ms); Spanish, Portuguese
and French; an open mic with loud noise (-35 dBFS) and one with soft noise (-55 dBFS); crosstalk.

## Scores

`score.ts` says exactly how each is counted. Latency is a turn's speech end (its last speech frame) to the bot's first
audio packet answering it; its stages use the names of camelRun's `voice_turn_latency` line (turnCommitMs,
transcriptMs, deliveredMs, llmFirstTokenMs, ttsFirstAudioMs, firstPacketMs), each in ms after the speech end.

## Baseline (main at 61d36e5, 2026-10-18, fake providers, realistic profile, `npm run eval:voice`)

| pipeline | latency p50 | p95 | answered | missed | premature | wrong addressee | false cuts | merged | talking over | answer gaps (p50 ms) | barge-in stop p50 | missed barge-ins | false barge-ins | WER |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| bots-say | 3788 | 7262 | 21/22 | 1 | 1 | 0 | 1 | 1 | 0 | 0 (-) | 0 | 0 | 1 | 0 |
| bots-agent | 3790 | 6858 | 21/22 | 1 | 1 | 0 | 1 | 1 | 0 | 2 (404) | 0 | 0 | 1 | 0 |
| run-agent | 2664 | 2853 | 21/22 | 1 | 1 | 0 | 1 | 1 | 0 | 2 (512) | 1 | 0 | 1 | 0 |
| bots-agent@push | 2900 | 3081 | 21/22 | 1 | 1 | 0 | 1 | 1 | 0 | 2 (355) | 1 | 0 | 1 | 0 |

| pipeline | turnCommitMs | transcriptMs | deliveredMs | llmFirstTokenMs | ttsFirstAudioMs | firstPacketMs |
|---|---|---|---|---|---|---|
| bots-say | 1001 (1003) | 1510 (1636) | 2425 (5648) | 3071 (6518) | 3684 (7158) | 3788 (7262) |
| bots-agent | 1000 (1002) | 1516 (1583) | 2557 (5633) | 3195 (6275) | 3686 (6754) | 3790 (6858) |
| run-agent | 1001 (1003) | 1481 (1649) | 1485 (1661) | 2101 (2268) | 2561 (2744) | 2664 (2853) |
| bots-agent@push | 1001 (1004) | 1513 (1625) | 1568 (1680) | 2263 (2450) | 2763 (2976) | 2868 (3080) |

With `VOICE_EVAL_PROFILE=instant` (providers take no time), run-agent answers in 1048 ms (p50): the cut alone.

After #230 (voice events kick the webhook sender; main at a3769d0, same settings): camel-bots' pipelines answer
about 1 s sooner at p50 and 4 s sooner at p95. `bots-agent@poll` is `bots-agent` without the kick, as before.

| pipeline | latency p50 | p95 | deliveredMs p50 (p95) |
|---|---|---|---|
| bots-say | 2930 | 3918 | 1540 (1643) |
| bots-agent | 2860 | 3075 | 1533 (1658) |
| run-agent | 2728 | 2912 | 1531 (1654) |
| bots-agent@poll | 3839 | 6860 | 2475 (5425) |

What it shows (the first baseline):

- **The cut takes 1,000 ms, not 800** (turnCommitMs): the silence timer restarts at each quiet packet a client sends
  after speech, so its 200 ms of hangover is added to `silenceMs`.
- **The webhook outbox adds 0-5 s** (deliveredMs minus transcriptMs: about 1 s at p50, 4 s at p95): voice events wait
  for the sender's next run, every 5 s. `bots-agent@push` is the same pipeline with them sent at once: p95 6.9 s to 3.1 s.
- **Streamed answers pause 350-500 ms between sentences** (answer gaps): each sentence is its own speech, made only once
  the one before has played.
- **Any sound stops the bot** (false barge-ins: a backchannel "mm-hm" ends its answer).
- **A pause mid-sentence longer than `silenceMs` cuts the turn, and the bot answers half a question** (premature).
- **An open mic with noise above -45 dBFS never ends an utterance**: its turns run together until the 30 s cut, and the
  bot misses them (merged, missed).
