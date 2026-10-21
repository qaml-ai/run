### One compaction path

Agents always use Pi's native context selection and compaction. The adapter's
older host-compaction mode and its extra context checkpoints have been removed.

This does not change journal storage or the public session API.
