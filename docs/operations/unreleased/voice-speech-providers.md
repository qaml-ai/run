### Voice sessions choose their speech providers

- **Transcription chain.** `transcription: {providers, keyterms}` on `POST /v1/voice/sessions` streams speech to
  text as people speak through the named providers, tried in order:
  - Deepgram `nova-3`
  - Deepgram Flux `flux-general-en`: it detects turns itself, and its turn events go to the turn taker
  - Soniox `stt-rt-v3`
  - AssemblyAI Universal Streaming
  - OpenAI `gpt-live-transcribe`
- **Mid-utterance failover.** An utterance's audio is kept until its transcript arrives. If a provider drops, errs, or
  has not answered 3 s after the cut, the next provider gets the whole utterance. When all fail, the utterance is
  transcribed after it ends (OpenAI's `gpt-transcribe`, then the Azure deployment). OpenAI's live stream now carries
  prior-turn context: what was just said prompts the next utterance.
- **Speech chain.** `speech: {providers, voices}` speaks through ElevenLabs `eleven_flash_v2_5`, Cartesia `sonic-3`,
  Deepgram `aura-2` or OpenAI, each provider with its own voice. A provider that fails or is slow (3 s) before its first
  audio is passed over for the next.
- **Runtime defaults.** `AGENT_VOICE_STT` and `AGENT_VOICE_TTS` set the chains a session gets when it names none
  ([configuration](configuration.md)).
- **Keys.** New key providers `deepgram`, `soniox`, `assemblyai`, `elevenlabs` and `cartesia` (`PUT
  /v1/providers/<id>/key`, `kind: "speech"`), plus `platformKeys.<id>` for the platform's.
- **Billing.** Each provider is billed at its list price, passed through (`src/voice-providers/prices.ts`,
  `AGENT_SPEECH_PRICES`): STT per second streamed, TTS per character. Usage records name the provider and model that
  served ([billing](billing.md)).
- **SDKs.** TypeScript `voice.create({ transcription, speech })`; Python `create(transcription=…, speech=…)`.
