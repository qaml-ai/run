### Scheduled memory consolidation

Agents can opt into nightly dreaming with a schedule, analyzer and organizer models,
a per-dream budget, instructions, and a dedicated read-only memory volume. Use
`PUT /v1/agents/{id}/dreaming` to configure it, `POST /v1/agents/{id}/dreaming/run`
to run now, and `GET /v1/agents/{id}/dreaming` for status and recent summaries.
Node and Workers use restricted delegate agents and publish linked Markdown after
all analysis succeeds. Failed dreams retain their input window. See
`docs/guides/dreaming.md` for limits and credential filtering.
