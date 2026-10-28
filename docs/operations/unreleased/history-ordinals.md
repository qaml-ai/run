### History ordinals in Pi storage

Each history entry in Pi storage now records its place in the agent's history (`msg_from`, `msg_count`, `msg_skip`,
`turn_start` on `pi_durable_entries`; `history_next` and `history_last_id` on `pi_durable_metadata`), kept by every
commit, so history reads can find a page of messages by ordinal in SQL instead of reading the journal from its base.
New agents are placed from their start. Agents from before this release are placed by
`POST /v1/operations/history-ordinals` (operator only; a dry run by default; resumable, bounded, idempotent), and
`GET /v1/operations/history-ordinals-coverage` reports agents not placed yet. The index on `msg_from` is built
concurrently at start. History reads do not use the ordinals yet. See `docs/operations/pi-durable.md`.
