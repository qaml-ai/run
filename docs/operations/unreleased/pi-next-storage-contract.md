### Pi storage is ready for the next Pi release's commit contract

The next `@earendil-works/pi-durable` release calls `Storage.commit(writes, adopt, context)` and expects the storage to
call `adopt(seq)` once, synchronously, when the batch is durable and before its next commit. camelRun's Postgres
storage, its SQLite wrapper and the agent-process RPC storage (`remotePiStorage`) take that shape, never adopt a commit
that failed, and adopt a commit whose answer was lost but landed exactly once. (The vendored Pi uses it: the shapes
for Pi 1.4.0 are gone again.)
