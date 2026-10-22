### The host transcript is removed: an agent's history is its Pi journal

Every agent's history and model context are now Pi's journal alone: Pi's messages, the messages the host makes
itself as native entries, and its turns, retractions, waiting calls and skips as markers. The host transcript
(`camel.host.snapshot`, `camel.host.record`), its dual write and dual read, and its working set that runs checked
into Pi's context are gone. A session's first load on this release retires its host transcript, once: it indexes
whatever settled history before the journal's base its history index lacks, then disables the host document
(`retired: "journal"`), and logs `host_transcript_retired`. A release before this one then refuses the session
(409 `AGENT_NOT_MIGRATED`), so a rollback below it is one-way. See `docs/operations/pi-durable.md`.

`AGENT_HISTORY_BACKLOG_BYTES`, `AGENT_PI_DUAL_WRITE`, `AGENT_PI_DUAL_READ` and `AGENT_PI_HISTORY_SOURCE_TENANTS` are
ignored (`settings_ignored`), and their Terraform variables (`agent_pi_dual_write`, `agent_pi_dual_read`,
`agent_pi_history_source_tenants`) and the `-dual-read-mismatches` and `-history-source-mismatches` alarms are
removed: apply with this release's image, never before it. Migration 084 drops the `pi_sweep` table.

What the model is sent changes in two places, for the same content: after a Pi compaction, requests carry Pi's own
compacted context (its summary and kept messages, after its system message with every section in effect) rather
than the host's copy of it; and a prompt with `history: "none"` is cut to its own messages in each request, while
Pi's context (and the compaction threshold it measures) keeps the whole history.
