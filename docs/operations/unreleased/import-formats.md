### Importing conversations from other APIs

- `importMessages: {format, messages, model?}` on agent creates and upserts: a conversation in Anthropic's Messages
  format, OpenAI's Responses input items or Chat Completions messages, tool calls and results included, converted
  to the Pi messages the agent begins with. Reasoning goes back to the model that wrote it (`model`) as it came, and
  to any other as text. Python: `import_messages=`; TypeScript also exports `toPiMessages` to convert one locally.
  See [Bringing in existing conversations](../guides/multi-user.md#bringing-in-existing-conversations).
