### Voice: the transcribe-and-reply pipeline is removed (breaking for voice clients)

A voice session either answers with the realtime model (`brain: "realtime"`, the default) or only listens (`brain:
"listen"`: muted, each utterance transcribed and sent to webhooks, nothing answering). The pipeline released in 0.10.0,
which sent each utterance to `deliver.agent` or your app and spoke replies through text to speech, is gone. What
clients must change:

- A session that only listened (no `speak`) now asks for `brain: "listen"`; left out, a session answers aloud.
- `POST /v1/voice/sessions` no longer takes `speak.agentReplies`, `transcription`, `speech` or `bargeIn.backchannels`
  (400). A realtime session speaks, so your app joins un-muted (`join.self_mute: false`); a listening one joins muted.
  `speak: true` is still accepted, changes nothing, and is deprecated; leave it out. `voice` (OpenAI's names) maps to
  the realtime provider's nearest voice; `realtime.voice` names the provider's own.
- `deliver.agent` no longer gets each utterance as a prompt: the model asks it (`ask_agent`) when it needs it.
  `voice.utterance` still comes for what people say, now always with `brain` (`realtime` or `listen`; a listening
  session's have no `addressed`); it no longer has `echo` or `backchannel`.
- `POST /v1/voice/sessions/{id}/speak` is removed (404), and so is a prompt's `speak` (400: not a field). `DELETE
  /v1/voice/sessions/{id}/speak` still stops what the bot is saying. The SDKs drop `voice.speak()` and the `speak`
  prompt option.
- `voice.speech.*` events no longer carry `reply`; `by` is `requested`, `barge_in`, `end`, `superseded` or `budget`.
  Sessions no longer show `speak`, `agentReplies`, `transcription`, `speech`, or `addressing.contextTurns` and
  `contextMs`; `brain` is `realtime` or `listen`, and `bargeIn` and `voice` are shown for realtime sessions only.
- A session made before this change, still live when the runtime is upgraded, ends (`voice.session.ended` with
  `reason: "error"`; logged as `brain_removed`).
- `POST /v1/speech` speaks through OpenAI unless the request names `speech.providers`: there is no runtime default
  chain any more.
- Operators: `AGENT_VOICE_TTS`, `AGENT_VOICE_STT`, `AGENT_VOICE_LIVE_TRANSCRIPTION`, `AGENT_VOICE_LIVE_MODEL`,
  `AGENT_VOICE_LIVE_DELAY`, `AGENT_PRICE_LIVE_TRANSCRIPTION_USD`, `AGENT_SONIOX_URL` and `AGENT_ASSEMBLYAI_URL` are no
  longer read, and `AGENT_SPEECH_PRICES` takes `tts` only. Soniox and AssemblyAI keys are no longer offered (`PUT
  /v1/providers/soniox/key`). `AGENT_VOICE_REALTIME` defaults to `openai`. `AGENT_VOICE_TURN_MODELS` stays: the
  realtime brain ends turns with Smart Turn.
