# Retry invalid native compaction summaries

Compaction retries an empty, whitespace-only, thinking-only, truncated or tool-call summary, and transient provider
errors, up to three attempts per chunk. Retries use the agent's configured backoff and may be disabled by its retry
policy. Each chunk must finish with text and no tool call before its summary can be carried into the next chunk.
Previously an empty summary failed a blocking run after one attempt. A tool-call response containing text could be
carried into later chunks even though it was not a valid summary.

Every attempt keeps its original response and usage in the durable journal before another call starts. Aborts cancel
requests and backoff. Spend and run limits are checked before each summary call, including background compaction.
Accounting failures and permanent provider errors are not retried.

If compaction still fails, the current run ends with an error. Its messages and completed tool results remain in
history; an invalid summary never replaces them. Later queued runs can attempt compaction again.
