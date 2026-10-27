### Bound full-history reads to 64 MiB

Full-history requests and forks now return HTTP 413 before reading indexed chunks when their stored size exceeds 64 MiB. Read large histories in pages with `limit`, `before` and `maxBytes`.

The console polls the latest bounded page and keeps absolute message indexes when forking. The TypeScript SDK's `history()` collects bounded pages while keeping its existing return type; use `historyPage()` to avoid holding the whole history in your client.
