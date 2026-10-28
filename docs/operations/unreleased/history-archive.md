### Moving history from before the journal into Pi storage

`POST /v1/operations/history-archive` (operator only; a dry run by default; resumable, a chunk per commit, idempotent)
moves each agent's history from before its journal (the history index's chunks: retired host transcripts, imports,
older forks) into its Pi storage as archive entries placed at their ordinals. `GET /v1/operations/history-archive-coverage`
reports agents still pending. History reads switch to the archive entries per agent as soon as they hold everything; the
history index is deleted in a following release once coverage is complete. See `docs/operations/pi-durable.md`.
