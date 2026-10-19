### Concurrent index migrations; an index for end users' credit history

- A migration whose first line is `-- migrate: concurrently` builds its indexes with `CREATE INDEX CONCURRENTLY`,
  outside the migrations' transaction, so a large table keeps taking writes while it builds
  ([architecture](architecture.md)). The runners' lock is now taken by polling, so a node waiting for it holds no
  snapshot that a concurrent build would wait for.
- Migration 074 builds `end_user_ledger_entries`, a partial index on `end_user_ledger (tenant, end_user, id)` for
  entries other than usage, that way: a person's credit history (`ledger?kind=grant,refund,adjustment`) and the entries
  in `GET /v1/end-users/{id}/days` read from their few entries however much usage they have. The first node of the
  release to start builds it before it serves; the build reads the whole ledger once.
