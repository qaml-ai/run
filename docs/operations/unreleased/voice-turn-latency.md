### Voice: turn latency, measured stage by stage; utterance webhooks without the poll

- Each turn the bot answers writes one `voice_turn_latency` line: the time from the end of speech to the turn's
  commit, the model's first audio and the first Opus packet out (`VoiceFirstPacketMs`, the headline), with
  `VoiceRealtimeMs` (commit to the model's first audio) and `VoicePlayoutMs`, under `Path=realtime`. Stages are as
  `src/voice/latency.ts` documents them.
- Tofu adds a `<name>-voice` dashboard and the `<name>-voice-turn-latency-p95` alarm (`voice_latency_p95_alarm_ms`,
  2,500 by default, in 3 of 4 15-minute periods with at least 20 spoken turns).
- `voice.utterance` webhooks are sent as soon as they are written, rather than at the outbox's next scan (every 5 s by
  default).
