### Pi storage is ready for the next Pi release's commit contract

The next `@earendil-works/pi-durable` release calls `Storage.commit(writes, adopt, context)` and expects the storage to
call `adopt(seq)` once, synchronously, when the batch is durable and before its next commit. camelRun's Postgres
storage, its SQLite wrapper and the agent-process RPC storage (`remotePiStorage`) now take that shape as well as Pi
1.4.0's `commit(writes, context)`, never adopt a commit that failed, and adopt a commit whose answer was lost but
landed exactly once. Pi reports and commit observation also take both releases' shapes. No behavior changes on Pi 1.4.0.
