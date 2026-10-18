### A speech can name its voice for each speech provider

- `POST /v1/voice/sessions/{id}/speak` takes `voices`: this speech's voice for each speech provider, by provider
  (`{"elevenlabs": "<voice id>", "openai": "fable"}`). It wins over the session's `speech.voices` for that speech
  alone. Before, a speech's `voice` reached OpenAI only, so a session speaking through ElevenLabs could not change
  voice for one speech.
- SDKs: TypeScript `voice.speak(id, { voices })`; Python `speak(..., voices=…)`.
