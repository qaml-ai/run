### Smaller contexts, and a cached prefix that survives mount changes

- `runLimits.contextTokens` keeps each of an agent's model requests within that many tokens: older context is
  compacted below it, as it is below the model's window otherwise. On a large-window model a long-lived agent then
  stops paying to read its whole history on every request ([Context size](../guides/models-and-keys.md#context-size)).
- The system prompt the model saw first is pinned with the agent's first message. A change of mounts (or another
  configuration change) before the first change of prompt or tools now follows as a system message of its own,
  instead of rewriting the start of the context, which made the provider write the whole prompt and history to its
  cache again.
