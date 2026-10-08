### TypeScript SDK

- `agents.transcriptions.create({ file | url, language, prompt })` (also `runtime.transcriptions`); attachments take
  `{ url }` and `transcribe`, and a message with audio may have no text. See [Voice and audio](../guides/voice.md).

### Python SDK

- `transcriptions.create(file or url=…)` on `Agents` and `AgentRuntime`, async and in `camelai_run.sync`; attachments
  take `{"url"}` and `"transcribe"`, and a message with audio may have no text.
