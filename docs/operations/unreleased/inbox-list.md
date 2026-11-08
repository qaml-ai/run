The decision inbox is available at `GET /v1/inbox` on both backends. It reads
`agent_inputs` with filters, keyset pagination and counts by priority and lead.
`GET /v1/inputs` now returns the same page (`items`, `cursor`, `counts`), lists
only pending unexpired items, orders by priority then expiry and age, defaults
to 50 items and accepts at most 100. It no longer accepts a state filter.
TypeScript and Python `inbox` take filter options and return that page. The CLI
reads the new inbox; use each item's `inputId` with its per-agent answer route.
