### Speech on its own: POST /v1/speech

- `POST /v1/speech` makes speech from text and streams it back as it is made (`pcm`, 24 kHz mono 16-bit, or `wav`):
  OpenAI's `gpt-4o-mini-tts` by default, or the providers `speech.providers` names in order (`elevenlabs`, `cartesia`,
  `deepgram`, `openai`), each on the tenant's key for it, else the platform's. It is billed as its provider bills it
  (OpenAI per second made, the others per character), against an end user's credit with `subject`. See
  [Voice and audio](../guides/voice.md#speech-on-its-own). `AGENT_SPEECH_PRICES` overrides the other providers' list
  prices; `AGENT_DEEPGRAM_URL`, `AGENT_ELEVENLABS_URL` and `AGENT_CARTESIA_URL` dial other addresses.
