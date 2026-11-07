### A sub-agent's notification says what its run took

A background sub-agent's `<agent_notification>` now carries its run's time, model responses, tool calls, tokens and
cost: `took="1m23s" model_calls="5" tool_calls="7" tokens="41k" cost_usd="0.031"`, on Node and Workers alike. The
notice's metadata gains `durationMs` (from the call that started it to its ending) and `toolCalls`. A notification
stored before this renders as it did, so existing histories keep their cached prompt prefix. See
`docs/guides/multi-agent.md`.
