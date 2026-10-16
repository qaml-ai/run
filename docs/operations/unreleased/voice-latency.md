### Voice: replies sooner after people stop talking

- Utterances are transcribed as they are spoken: each speaker's audio streams to OpenAI's Realtime transcription
  (`wss://…/v1/realtime?intent=transcription`, `gpt-live-transcribe`, turn detection off) and each cut commits it, so
  the transcript comes a few hundred milliseconds after the cut instead of after an upload and a whole transcription.
  A stream that fails (or a key scope with its own address) falls back to transcribing after the cut; `voice.utterance`
  is unchanged. Billed at $0.017 a minute of audio sent (`AGENT_PRICE_LIVE_TRANSCRIPTION_USD`), against $0.0045 after
  the cut. `AGENT_VOICE_LIVE_TRANSCRIPTION=false` turns it off; `AGENT_VOICE_LIVE_MODEL`, `AGENT_VOICE_LIVE_DELAY`
  choose the model and its delay. Logs: `voice_utterance` has `live` and `speechEndToTextMs`;
  `voice_live_transcription_failed` marks a fallback.
- Speech starts playing after 0.2 s of audio is made (0.5 s after a stall), and the speech provider's connection is
  opened when someone starts talking in a session that speaks, so the reply's speech does not wait to connect.
- `scripts/voice-check.ts` measures it: `speechEndToText` (after the cut, and per live model), each utterance's
  timing, `cutsAtSilenceMs` (how a sentence with pauses is cut at 500, 600 and 800 ms) and `warmMs`.
