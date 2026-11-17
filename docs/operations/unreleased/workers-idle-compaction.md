### Idle compaction across model providers

Eligible conversations on Workers now compact in the background while the agent
is idle. The summary request reuses the previous provider request's prefix where
the provider cache allows it. The next turn uses the summary and recent messages,
and full history remains available.

The cache replay supports Anthropic, OpenAI, Azure OpenAI, OpenRouter, Gemini,
Amazon Bedrock, Workers AI, and compatible endpoints that report cache usage.
Workers uses known cache lifetimes where available and estimates five minutes
otherwise. A summary can still miss the provider cache.

Existing agents pick up the default on their next qualifying turn. Set
`idleCompaction: false` when creating or configuring an agent to opt out. Operators
can set `AGENT_IDLE_COMPACTION=0` to disable the feature runtime-wide.
