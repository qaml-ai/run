### Fresh turns retain their task after compaction

A prompt with `history: "none"` now keeps its original task, the latest compaction summary and subsequent messages when compaction removes the task from working context. Earlier history stays hidden except as summarized. Previously, later requests could contain only system instructions and repeat work indefinitely.

A request with no user message now fails the run with code `context_lost` before calling the model.
