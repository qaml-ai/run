# Voice pipeline

How a voice session's audio moves through a node, and the interfaces the parts plug into. This page covers the media
plane: what runs per session, where it runs, and how its timing is measured. The API and the session's lifecycle are
covered elsewhere: [Voice calls](../guides/voice-calls.md) and `src/voice-sessions.ts`.

Status: landed (see [Rollout](#rollout)). Since 2026-10-19 every session answers with a realtime speech-to-speech
model (`src/voice/realtime/`); the pipeline that transcribed each utterance, had an agent or the app write a reply, and
spoke it through text to speech is gone, with its streaming STT and TTS providers.

## Goals

1. **A voice bug ends at most its own session.** On 2026-10-18 an Opus trap thrown from a timer ended a whole node,
   every tenant's agent turns included (#222 fixed the trap; #223 drains the node on any fatal error). Voice shares the
   process, and the event loop, with agent turns. Isolating it means that a crash, an OOM or a hot loop in one session's
   audio leaves the other sessions and every agent turn alone.
2. **Latency we can see.** Each stage of a turn gets a timestamp, from the end of speech to the first Opus packet out,
   published as a metric with p50 and p95, plus an alarm. This is the yardstick for every other change: turn-taking,
   providers and this pipeline.
3. **Streaming end to end.** Audio goes to the model as it arrives, and the model's audio plays as it comes. Nothing
   waits for a whole turn or a whole answer when it does not have to.
4. **Clean audio.** Packets are reordered, losses are concealed, silence frames go out when the bot stops, and the bot's
   speaking state and the voice gateway's resume behave as Discord expects.

## Shape

```
 main thread (control + providers)                      media worker (one per session, worker_threads)
 ─────────────────────────────────                      ───────────────────────────────────────────────
 VoiceSessions: DB rows, ownership, billing   ◀──────▶  MediaSession
   │  MediaHost: spawn, supervise, restart    protocol    ├─ DiscordVoice: voice WS (v8), UDP, DAVE
   │                                                      ├─ JitterBuffer per SSRC (reorder, loss → PLC)
   ├─ RealtimeBrain: mixer, provider socket  ◀── PCM ───├─ Decoder per speaker (Opus → 24 kHz mono)
   │    (OpenAI Realtime, Gemini Live)       ◀── cut ────├─ Segmenter (cuts) + TurnTaker (voice-turns)
   ├─ ask_agent → deliver.agent                          ├─ barge-in / duck: local, no round trip
   ├─ the model's audio                     ─── PCM ────▶ ├─ Encoder (24 kHz mono → 20 ms Opus 48 kHz stereo)
   └─ TurnClock → voice_turn_latency                      └─ Player: jitter-buffered playback, silence frames
```

The main thread keeps what needs the database, keys or money: rows, claims, credit holds, the realtime provider's
connection, `ask_agent` and webhooks. The worker keeps everything that touches audio samples or the Discord media connection.

### Why worker_threads, not a child process

- The failures we have seen, and the likely ones, are JavaScript or WebAssembly failures: a WASM trap, an exception from
  a timer or stream listener, a heap that grows without bound, a loop that never yields. A worker contains all of them.
  Its uncaught error ends the worker, not the process. `resourceLimits` turns a heap OOM into `ERR_WORKER_OUT_OF_MEMORY`
  on that worker. A supervisor heartbeat catches a loop that never yields, and `worker.terminate()` stops it.
- The cost is low. A worker is an isolate in the same process: about 10 MB of heap and a few ms to start. Messages are
  structured clones, or transfers for PCM `ArrayBuffer`s. A child process costs 40+ MB of RSS and a full Node startup
  (~150 ms on Fargate), and IPC serializes each message twice.
- What a worker does **not** contain: a native crash, which ends the process. The native code involved is
  `@snazzah/davey` (Rust, N-API), plus `onnxruntime-node` if voice-turns lands it. Neither has crashed so far.
  `MediaHost` is written against a small `MediaChannel` interface (`postMessage`, `on("message" | "error" | "exit")`),
  which `child_process.fork` also satisfies. Switching one session class to child processes
  (`AGENT_VOICE_ISOLATION=process`) is a constructor change, not a redesign. If a native crash ever happens in
  production, that is the switch.

### Workers per session, and the shard fallback

By default each session gets its own worker (`AGENT_VOICE_SESSIONS_PER_WORKER=1`), which is the only setting under
which "a crash ends only that session" holds. With N > 1, sessions are packed N to a worker, and a crash hits that
worker's sessions (at most N). This is for a node holding many sessions, where per-worker memory adds up. Measured
numbers go into the isolation PR, and from them the default per-node cap (`AGENT_VOICE_SESSIONS_PER_NODE`, 200 today).

### Supervision

- **Heartbeat.** The worker posts `tick` every 1 s with its heap, its external/ArrayBuffer bytes and the Opus WASM heap
  (`opusStats`). If no tick arrives for 5 s (a stuck loop), or memory passes `AGENT_VOICE_WORKER_MAX_MB` (256 by default;
  WASM memory is outside `resourceLimits`), the worker is terminated.
- **A worker that dies** (error, OOM, terminated, non-zero exit) fails each of its sessions with a crash:
  - A `voice_worker_crashed` log line and a `VoiceWorkerCrashes` metric.
  - A `voice.session.error` event for the tenant's webhooks:
    `{ code: "media_crashed", detail, restarting: true, attempt }`.
  - Audio already sent to the model stays in its conversation. Audio of a turn not yet cut is lost, at most `maxMs`
    (30 s) per speaker and usually under a second.
  - The session's speech stops (`voice.speech.ended`, `reason: "error"`).
  - The session restarts in a fresh worker with the same credentials. The library identifies again, and DAVE re-forms.
- **Repeated crashes end the session**: 3 crashes in 5 minutes ends it with `reason: "error"`, `detail: "media_crashed"`,
  so a poisoned session cannot loop forever.
- **The main thread never awaits the worker on the request path.** `DELETE …/speak`, `DELETE` and `PATCH` post a message and
  return. A worker that is gone simply drops the message, and the restart re-sends the current credentials and options.

## Protocol (`src/voice/protocol.ts`)

Messages are plain objects with a `t` tag. PCM is a transferred `ArrayBuffer` (no copy). The protocol is versioned
(`MEDIA_PROTOCOL = 1`), and the worker refuses an `open` of another version. A rolling deploy replaces the worker code
together with the main thread, so this is a guard, not a compatibility promise.

Control → media:

| `t` | Fields | Meaning |
| --- | --- | --- |
| `open` | `session, credentials, options: MediaOptions` | Connect and start listening. `MediaOptions`: `silenceMs, ignoreUserIds, bargeIn, bargeInMinMs, bargeInPause, live (send PCM up; always, for the model), endOfTurn?` |
| `models` | `port: MessagePort` | The node's turn models (one shared inference worker) |
| `update` | `credentials` | Discord moved the call: reconnect |
| `configure` | `Partial<MediaOptions>` | `ignoreUserIds` changed |
| `play` | `id, expectedMs?` | An answer begins: PCM follows |
| `pcm` | `id, pcm: ArrayBuffer` | 24 kHz mono s16le audio, as the model made it |
| `pcm_end` | `id, error?` | The speech's audio is whole (or failed) |
| `stop` | `id` | Stop this speech now (5 silence frames follow) |
| `resume` | | End a barge-in pause (`bargeInPause`): what still plays goes on where it paused |
| `close` | | Flush every speaker (`ended: "end" \| "handoff"`), then exit |

Media → control:

| `t` | Fields | Meaning |
| --- | --- | --- |
| `ready` / `lost` / `diagnostic` | as `VoiceHandlers` today | The connection's state |
| `others` | `users: string[] \| null` | Who else is in the call, sent on change (for `emptySeconds`) |
| `speech_start` | `speaker, at` | The first loud frame of an utterance |
| `barge_in` | `speaker, speechMs` | The utterance has `bargeInMinMs` of speech over the bot. Playback has already been stopped locally, or with `bargeInPause` paused until `resume` (src/voice/echo-guard.ts) |
| `speech_progress` | `speaker, speechMs` | While paused: each further loud frame of that speaker's utterance, so the echo guard sees speech go on |
| `pcm` | `speaker, pcm: ArrayBuffer, at` | 24 kHz mono s16le, 40–60 ms at a time, from the first loud frame (only with `live`) |
| `drop` | `speaker` | The turn was too short (a cough): the model's input for it is dropped |
| `cut` | `Cut` (packets as ArrayBuffers) | A turn ended: the brain commits it and asks the model to answer |
| `turn` | `TurnEvent` | voice-turns' events (`likely_end`, `turn_end`, `resume`, `barge_in`, `duck`, …), at their `at` |
| `started` | `id, at` | The speech's first Opus packet went to the player |
| `played` | `id, result, stats` | The speech ended: `done \| stopped \| error`, with `speech_played` stats |
| `tick` | `heapMb, externalMb, opusHeapMb, sessions` | Heartbeat |

Timestamps (`at`) come from `performance.timeOrigin + performance.now()` in the worker. They are on the same clock as
the main thread's `Date.now()`, to within a millisecond.

### Interfaces the other voice work plugs into

- **Turn-taking (voice-turns, `src/voice/turns/`).** `TurnTaker` is constructed inside `MediaSession`, one per session.
  It gets `frame(speaker, pcm: Int16Array /* 320 samples, 20 ms, 16 kHz mono */, atMs, { concealed? })` for every
  received or concealed packet, in RTP order after the jitter buffer, and `botSpeaking(text | null)` from the player. Its `duck`, `unduck` and `barge_in` act on the player
  locally. Every event is also forwarded as `turn`. When a `TurnPolicy` is given, `turn_end` (not the Segmenter's
  silence timer) cuts the utterance. The models (Silero VAD, Smart Turn) are not loaded per session. One shared
  inference worker per node (`TurnModels`, voice-turns) batches VAD across every speaker on the node, and MediaHost
  transfers a `MessagePort` to it into each session worker (`open.models`). That is about 21 MB of models per node
  instead of per session, and a crash of the inference worker degrades turn-taking to the silence timer rather than
  ending sessions. `TurnTaker` itself is a pure state machine on an injected clock. `likely_end` and `resume` drive the brain's
  speculative answer on main (`realtime.speculative`; the pipeline carries the events). The module must have no DB, network or main-thread dependencies.
- **The realtime brain (`src/voice/realtime/`).** On main. It takes each speaker's `pcm`, mixes them into one 24 kHz
  stream with a note naming who speaks at each change, commits a turn at its `cut` (or at `likely_end`, speculatively)
  and asks the provider to answer. The answer's PCM goes down as `play`/`pcm`/`pcm_end`, and a barge-in cancels it and
  truncates the model's item at what was heard. `RealtimeProvider` (`provider.ts`) is the seam: OpenAI Realtime
  (`openai.ts`) and Gemini Live (`gemini.ts`).

## Streaming

- **Per-speaker streams to the model.** Each speaker has one ordered stream from the jitter buffer through decoding, the
  segmenter and the turn model, up to the brain's mixer. Nothing batches a whole turn.
- **Playback starts on the first chunk** once the model's rate proves it will stay ahead (the jitter buffer's
  `startRate` rule).
- **Webhooks without the poll.** `voice.*` events kick the webhook outbox at once (`Webhooks.kick()`), rather than
  waiting for the 5 s scheduler poll.

## Audio hygiene

| Item | Today | Change |
| --- | --- | --- |
| Reorder | Packets go to the library as UDP delivers them | Per-SSRC jitter buffer on the RTP sequence (16-bit wrap), before decryption: holds up to 60 ms (3 packets), releases in order, and treats a late packet as lost |
| Loss | A lost packet is skipped: the decoder state jumps and STT hears a click | Gaps of 1–3 packets are concealed by libopus PLC (`decode(null)`). Longer gaps count as silence, not loss. opusscript's handler conceals 5,760 samples a call (240 ms at 24 kHz, measured), so one call is made per gap and only the lost packets' length of it is kept |
| End of speech | The player pads 5 silence frames when a speech ends; an interrupt (`stop(true)`) sends none | An interrupt also sends 5 silence frames before going idle, so the far end's decoder does not interpolate from a cut-off frame |
| Speaking (op 5) | The library sets speaking on the first packet and clears it after the padding | Kept, and tested: speaking is cleared after every speech, including stopped ones, and is not left set through a long DAVE hold |
| Gateway | @discordjs/voice 0.19 already speaks v8 (`seq_ack`) and resumes after 4015 or a close below 4000 while Ready | Tested against a fake voice gateway: a resumed socket is not counted as a rejoin, does not reset DAVE, and loses no receive stream |

## Latency instrumentation (`src/voice/latency.ts`)

A `TurnClock` follows one turn, from its cut to the first audio of the model's answer:

| Mark | Where | Stage |
| --- | --- | --- |
| `speechEnd` | the last loud packet (`Cut.endedAt`) | origin, 0 |
| `turnCommit` | the cut (or, for an answer begun at `likely_end`, the turn's end confirming it) | turn-taking delay (`silenceMs`, or the turn model) |
| `ttsFirstAudio` | the first PCM bytes from the model | the model's time to first audio |
| `firstPacket` | the first Opus packet to the player (`started`) | the playback buffer, encoding, DAVE |

Each finished turn writes one EMF line, `voice_turn_latency`. Each stage is a metric in ms, from `speechEnd`:
`VoiceTurnCommitMs`, `VoiceTtsFirstAudioMs` and `VoiceFirstPacketMs` (= end of speech to first audio, the headline).
There are deltas too: `VoiceRealtimeMs` (commit to the model's first audio) and `VoicePlayoutMs` (first audio to first
packet). The dimension is `Path` (`realtime`). The properties carry `ttsProvider` and `ttsModel` (the realtime provider
and model), `speculative` and `askAgent`. A turn that never reaches audio (no answer, `stay_silent`, barge-in, error)
logs its marks with `outcome`, but publishes no `VoiceFirstPacketMs`.

In CloudWatch, the `${name}-voice` dashboard (infra/terraform/voice.tf) shows p50, p95 and p99 of
`VoiceFirstPacketMs`, p95 of each stage, and where the time goes (turn commit, the realtime model, playout), stacked. A `voice_turn_latency_p95` alarm fires when p95 `VoiceFirstPacketMs` exceeds
`var.voice_latency_p95_alarm_ms` (2,500 by default) in 3 of 4 15-minute periods, with at least 20 turns, and goes to
the alerts topic. The voice load test asserts the same stages exist, so a code path that loses a mark fails CI.

## Load test

`tests/voice-load.test.ts` keeps its current shape (sessions × speakers in real time, speech played and barged in), and
grows three ways:

- It runs with the worker host, plus the inline host for comparison, reporting per-session RSS and CPU.
- A worker is killed (crash, OOM, hang) in the middle of the run. Asserted: only that session gets `voice.session.error`
  and restarts; every other session keeps its cadence of utterances. A concurrent stream of agent turns on the same node
  keeps its time to first token. The main thread's event-loop delay (p99, `monitorEventLoopDelay`) stays under 20 ms.
- It checks that `voice_turn_latency` lines have every stage.

## Rollout

Each PR is behind no flag unless noted, has tests, and leaves `tests/voice-load.test.ts` green.

1. **This design.**
2. **Latency.** `TurnClock`, `voice_turn_latency`, `Webhooks.kick()` for voice events, and the dashboard row + p95
   alarm in `infra/terraform/observability.tf`. It changes no audio path, so it lands first and measures every PR after
   it.
3. **Media boundary, inline.** `MediaSession` (`src/voice/media.ts`) owns the connection, segmenter, decoding and
   playback encoding. `VoiceSessions` speaks the protocol to it in-thread. `Player.play` takes PCM. Behavior is
   unchanged, and the existing voice tests pass untouched apart from the fakes.
4. **Media workers.** `MediaHost`, the worker entry, supervision, `voice.session.error`, restart and crash budget, and
   the load test's crash scenarios. `AGENT_VOICE_ISOLATION=worker` becomes the default (`inline` stays for tests and
   as an escape hatch).
5. **Audio hygiene.** Jitter buffer, PLC, silence frames on stop, speaking and resume tests.
6. **Streaming.** The faster playback start, and PCM batching up the protocol.
7. **Realtime only** (2026-10-19). The realtime brain is the only one: streaming STT providers, text to speech for
   replies, `POST …/speak` and the cascade's latency stages are removed.

Merge in that order: 3 before 4 (4 builds on the boundary), and 2 any time before 4, so the crash scenarios are
measured. Rebase onto 5 and 6 if voice-turns or voice-providers land first: they touch `src/voice/turns/`,
`src/voice-providers/`, `transcription*.ts` and `speech.ts`. This work stays in `src/voice/`, `src/voice-audio.ts`,
`src/voice-discord.ts`, `src/voice-speech.ts`, `src/voice-sessions.ts` (call sites only), `src/webhooks.ts` (`kick`)
and `infra/terraform/observability.tf`.
