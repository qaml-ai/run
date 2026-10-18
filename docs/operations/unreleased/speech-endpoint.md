### Speech on its own: POST /v1/speech

- `POST /v1/speech` makes speech from text, in the voice a voice session would speak it in, and streams it back as it
  is made (`pcm`, 24 kHz mono 16-bit, or `wav`). It is billed as a session's speech is, per second made, against an
  end user's credit with `subject`. See [Voice and audio](../guides/voice.md#speech-on-its-own).
