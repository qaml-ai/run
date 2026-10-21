### One compaction path for Pi sessions

Pi sessions always use Pi's native context selection and compaction. The adapter's
older host-compaction mode and its extra context checkpoints have been removed.
The host compactor is now passed only to the legacy engine, which remains available
for sessions whose migration is deferred and for operator rollback.

This does not change journal storage, migration limits, or the public session API.
