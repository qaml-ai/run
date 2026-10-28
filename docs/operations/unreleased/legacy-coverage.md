### Legacy format coverage endpoint

`GET /v1/operations/legacy-coverage` (platform operator token only) counts the agents that still need the retired and
legacy history readers: host transcripts never retired, retired ones whose history index is short of the journal base,
Pi sessions with no journal history, and agents with no Pi storage (with and without hot legacy-log rows), with up to
20 agent ids per nonzero count and a `gate` saying whether the readers can go. It reads in one read-only transaction
stopped after 60 s and matches entry kinds on each record's first 200 characters, so it never reads whole records.
See `docs/operations/pi-durable.md`.
