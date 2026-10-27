### Pi context size metrics

Pi model requests now log `held_tokens`, `sent_tokens` and `held_sent_ratio` in CloudWatch
namespace `AgentRuntime`, with only `ServiceName` as a dimension. Both counts use the same
estimator, before context trimming and after request conversion respectively. Agent ids remain
plain log fields. A `context_divergence` warning appears at most once per host run when held
tokens exceed both four times sent tokens and 50,000.

The existing context size guard also reports `context_range_bytes` and `context_range_entries`
at host load and the first model request of each run, without extra SQL. Committed tool results
report `tool_result_details_bytes` (serialized JSON) and `tool_result_inline_image_bytes`
(stored base64 payloads). Contents are never logged. Held estimates reuse unchanged message
objects; each request walks the message list without serializing the whole context. These
metrics do not change model-visible messages or compaction behavior.
