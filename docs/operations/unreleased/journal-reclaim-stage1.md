### Reclaim superseded journal checkpoints

Operators can size and reclaim obsolete context copies in idle sessions with
`scripts/ops/reclaim-checkpoints.ts`. Dry run is the default; apply rechecks idleness under session locks and keeps
native history, compactions, seed markers and every reserved ID. See the runbook (`docs/operations/journal-reclaim.md`).
Journal forks before the newest retained context head now return `FORK_POINT_INVALID`; choose a later message.
