### History pages read forward: `after` and `nextAfter`

`GET /v1/agents/:id/history` (and the agent-token history endpoint) accepts `after`, a
message index like `before`. The page holds whole turns from the first turn start at or
after it (from `after` on when that is inside a turn, resuming a page a byte bound split),
oldest first, up to `limit` messages and `maxBytes`. A forward page keeps the
`{ entries, next, total }` shape and adds `nextAfter`: the `after` for the next page, one
past its last message, `total` once caught up. A job that polls reads each new message once
instead of paging back from the newest every run. `next` keeps its meaning (the older page's
`before`), and pages requested without `after` are unchanged.

`after` with `before` is a 400. An `after` older than the history the agent still holds
(compaction dropped it) is answered with what exists and `truncated: true`, not an error;
past `total` it is `entries: []` with `nextAfter: total`, so a caller sees the history
shrank and starts again from `total`.

Use `agent.historyPage({ after: 0, limit: 50 })` in TypeScript or
`agent.history_page(after=0, limit=50)` in Python. Read `nextAfter` from the answer and
pass it as `after` next time.
