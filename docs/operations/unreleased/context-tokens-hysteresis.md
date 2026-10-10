### contextTokens compacts in the background, and not on every turn

- A compaction for `runLimits.contextTokens` now runs in the background only, so it never holds up a turn, and the
  next one waits until a quarter of the limit is new since the last. Before, an agent whose system prompt, summary and
  recent messages nearly filled the limit was summarized again on almost every turn, and each summary made the
  provider write the whole context to its cache again ([Context size](../guides/models-and-keys.md#context-size)).
