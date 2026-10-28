### Legacy format coverage endpoint

`GET /v1/operations/legacy-coverage` (platform operator token only) counts the agents that still need the retired and
legacy history readers: host transcripts never retired, retired ones whose history index is short of the journal base,
Pi sessions with no journal history, and agents with no Pi storage (with and without hot legacy-log rows), with up to
20 agent ids per nonzero count and a `gate` saying whether the readers can go. It walks agents in batches with a few
index lookups each (never a scan of `pi_durable_entries`), about 20 s per call, and answers a `next` cursor carrying
the counts until `complete`. Each batch is read-only, each statement stopped after 20 s. See
`docs/operations/pi-durable.md`.
