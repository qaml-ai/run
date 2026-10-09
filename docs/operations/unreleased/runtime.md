### Runtime

- Speech to text. Audio attached to a message (a voice note, a recording) is transcribed before the message is
  accepted, and the model reads the transcript, so every model hears it; history keeps the audio file with its
  transcript. A file of type `audio/*` is transcribed by default (`transcribe: false` keeps it a plain file; `true`
  asks for any file); a message with audio needs no `text`. Files attach by URL too (`{url}`, fetched through the
  outbound guard). `POST /v1/transcriptions` transcribes audio alone (multipart, base64 or a URL; `language`,
  `prompt`). It runs on OpenAI's `gpt-transcribe` with the tenant's OpenAI
  key as model calls resolve it, else the platform's: $0.0045 a minute, per second, on prepaid credit. Ogg (Opus,
  Vorbis), WebM, MP3, M4A/MP4, WAV and FLAC, 25 MB and 30 minutes a file, 5 files and 30 minutes a message.
  Transcriptions count toward spend limits, monthly caps and credit, and are `usage.recorded` events with the new
  `kind: "transcription"` (and `audioSeconds`; `agentId` is null for one made alone): a consumer that switches on
  `kind` should treat an unknown one as other usage. Channels' voice messages and audio files are transcribed with no setup. See
  [Voice and audio](../guides/voice.md).
- `maxOutputTokens` and `temperature` on agents, definitions, `PATCH /v1/agents/:id/configuration` and stateless
  runs: the most the model writes in one response (at most its own maximum), and its sampling temperature (0 to 2).
  A temperature the model would refuse is a 400 where it is set: Claude Opus 4.7 and later, Sonnet 5.5 and Fable,
  models that always reason (o-series, GPT-5), and any reasoning model at a `thinkingLevel` other than `off`. Set on
  an agent from a definition, both stay its own when the definition is applied. Compaction summaries keep the
  runtime's settings. See [Output length and temperature](../guides/models-and-keys.md#output-length-and-temperature).
- `mcpServers` on agents without a definition (`POST /v1/agents`, upserts, `PATCH /v1/agents/:id/configuration`)
  and on stateless runs: MCP servers of their own, without credentials (`auth: {"type": "runtime"}` or none; a token
  or headers is a 400 that says to use a definition). They count toward an upsert's `configHash`, a fork copies
  them, and `GET /v1/agents/:id` shows them. An agent from a definition refuses them. OpenAPI specs stay in
  definitions. See [An agent's own MCP servers](../guides/tools.md#an-agents-own-mcp-servers).
