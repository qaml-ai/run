### contextTokens no longer summarizes on every turn

- After a compaction for `runLimits.contextTokens`, the next one waits until a quarter of the limit is new since the
  last. An agent whose system prompt, summary and recent messages nearly filled the limit was summarized again on
  almost every turn, and each summary made the provider write the whole context to its cache again.
