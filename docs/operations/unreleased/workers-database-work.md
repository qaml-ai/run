# Workers pilot database work and account deletion

The Workers pilot batches webhook outbox work and avoids repeated credit reads
inside a model settlement. Active turns keep their recovery alarm and live
limits checks without repeating unrelated maintenance on every tick. Financial
reservations and charges remain transactional in PostgreSQL.

Account deletion continues through bounded Queue passes after the request ends.
An interrupted pass resumes from its persisted lease; Cron repairs missed
enqueue attempts. Accounting records remain retained.

Pilot measurements and their limits are recorded in `backends/workers/PILOT.md`
and `backends/workers/measurements/turn-db-profile.json`.
