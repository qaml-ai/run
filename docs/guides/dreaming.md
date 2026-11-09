# Dreaming

Dreaming is an opt-in consolidation job for one agent and its descendants. It
reads new conversation messages, runs analyzers in groups, then runs one
organizer. Successful dreams replace a dedicated memory volume with small
Markdown files and `_index.md`. Source agents read that volume.

Create a volume and mount it on the source agent with `mode: "ro"`. The volume
must be dedicated to memory: publication replaces its entire contents. Existing writable agent mounts must be removed; new writable mounts are refused.
Tenant file APIs still permit manual maintenance. Then configure the job with a tenant API key:

```ts
await runtime.configureDreaming(agentId, {
  enabled: true,
  volumeId,
  schedule: { time: "01:00", timeZone: "America/Chicago" },
  analyzerModel: "openrouter/openai/gpt-4o-mini",
  organizerModel: "openrouter/openai/gpt-4o-mini",
  budgetUsd: 1,
  instructions: "Keep durable preferences and project facts with source references.",
});
await runtime.dreamNow(agentId);
const status = await runtime.dreaming(agentId);
```

Choose models available to your account. `budgetUsd` is the coordinator's
aggregate agent spend limit, including its delegated children. As with other
agent budgets, a model request already in progress may cross the limit. A
budget failure is recorded as `budget_reached` and does not publish memory.

The API routes are `GET` and `PUT /v1/agents/{id}/dreaming` and
`POST /v1/agents/{id}/dreaming/run`. Python exposes `dreaming`,
`configure_dreaming`, and `dream_now` on the runtime clients. Configuration is
required in full. Set `enabled: false` to stop scheduled runs; run-now still
works. Configuration changes are refused while a dream is active.

The initial window starts when dreaming is configured. Later windows start at
the last successful dream. A failed analysis, unavailable source, invalid model
output, storage failure, or exhausted budget retains that starting point for
the next attempt. Active source conversations defer consolidation. The source
must retain its history until the dream reads it; deletion and expiry remove it
from the transcript API.

The coordinator runs code with `tools.delegate`. Analyzers and the organizer
have no file tools, code mode, web tools, MCP servers, or computers. They receive
transcripts as JSON data, not executable code. Credential fields, high-entropy strings, and recognized
credential patterns are redacted before analysis and publication. This is not a
general detector for arbitrary sensitive prose: keep sensitive personal data
out of memory sources and review the results before relying on them.

Publication uses a snapshot and an atomic restore. The snapshot is pinned for
review and recovery. Dream status includes the latest result and the 20 latest
attempt summaries; every attempt is stored. Scheduled runs are checked every
10 seconds on Node and on the minute cron on Workers. Deployment must retain
that Workers cron trigger.

A job processes at most 200 input pages and 240,000 bytes in its
workflow payload. Oversized input fails without advancing the window. Each
output has at most 100 Markdown files of 16,000 characters each and 100,000 characters in total. The organizer input
is capped at 100,000 characters. Split unusually
large memory workloads across source agents. Memory is evidence to check, not
a higher-priority instruction source: it can preserve a mistaken belief from a
transcript.
