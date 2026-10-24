### Bound history pages by bytes

History paging accepts `maxBytes` (16,384 to 4,000,000) to cap the UTF-8 JSON response,
including its envelope. It returns the newest messages that fit and the existing `next`
cursor for older messages. Pages may start inside a turn; a single oversized message
is returned whole. Requests without `maxBytes` keep their existing behavior.

Use `agent.historyPage({ limit: 50, maxBytes: 65536 })` in TypeScript or
`agent.history_page(limit=50, max_bytes=65536)` in Python. The parameter works on
`GET /v1/agents/:id/history` and the agent-token history endpoint.
