### Voice: replies sooner after people stop talking

- The speech provider's connection is opened when someone starts talking in a session that speaks, so the reply's
  speech does not wait to connect (about 90-180 ms saved on a cold connection).
- Live transcription, off by default (`AGENT_VOICE_LIVE_TRANSCRIPTION=true`): each speaker's audio streams to
  OpenAI's Realtime transcription (`wss://…/v1/realtime?intent=transcription`, `gpt-live-transcribe`, turn detection
  off) and each cut commits it. Measured live, it brought the text at most ~200 ms sooner than transcribing after the
  cut (sometimes later, on short utterances), at $0.017 a minute against $0.0045, so it stays off. A stream that fails
  (or a key scope with its own address) falls back to transcribing after the cut; `voice.utterance` is unchanged.
  `AGENT_VOICE_LIVE_MODEL`, `AGENT_VOICE_LIVE_DELAY` choose the model and its delay; `AGENT_PRICE_LIVE_TRANSCRIPTION_USD`
  its price. Logs: `voice_utterance` has `live` and `speechEndToTextMs`; `voice_live_transcription_failed` marks a
  fallback.
- `scripts/voice-check.ts` measures it: `speechEndToText` (after the cut, and per live model), each utterance's
  timing, `cutsAtSilenceMs` (how a sentence with pauses is cut at 500, 600 and 800 ms) and `warmMs`.
