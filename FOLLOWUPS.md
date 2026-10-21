# camelRun follow-ups (found 2026-10-12 while building camelBots)

Findings from running camelBots (a Discord bot builder) and its triage tooling on camelRun, plus what was fixed along
the way. Each item says what is wrong, why it matters, and a rough size. Status is as of 2026-10-12.

## Do soon

### 1. Structured model errors (small)
A run that fails inside the model call reports `model_error` with free text only. A client that wants to react (retry on
another model, tell the owner their credit ran out) has to parse the message for 402, 429 or 5xx.
- Return, on the run error and on the failed response event: the provider's HTTP status, a `retryable` flag, a class
  (`billing`, `rate_limit`, `server`, `refusal`, `auth`, `other`) and the concrete model that failed.
- Put the model that actually served the run in the run result, next to `usage`.
- Why: camel-bots' `ctx.ai` fallback currently matches message text.

### 2. Real failover for a named model (medium; about a day on top of a parked branch)
Today `defaultModels` / `AGENT_MODEL_FALLBACKS` (src/model.ts, src/node.ts `defaultModelFor`) is only a creation-time
choice of the first model the tenant has a key for. It never fails over at runtime. A named model gets same-model
retries for 429/5xx/timeouts (3 attempts, 2/4/8 s) and a 402 or refusal ends the turn.
- A tenant whose agents all use one model (one provider, one credit pool) goes fully down on a credit outage.
- Option A, small: a per-tenant default model list in the tenants secret, reloaded every 60 s, read first by
  `defaultModelFor` (about 50 lines, no deploy to change, still no failover).
- Option B: failover across a chain on 402/429/5xx/timeout/auth/refusal with cooldowns and per-model usage attribution
  (about 350 lines). A prototype with tests exists on the local branch `feat/model-profiles` (named profiles); it would
  be re-keyed to the tenant default chain rather than named profiles.

### 3. Serve plain agent reads from any node (small to medium)
`GET /v1/agents/:id` answers 503 "served by another node; retry" while an agent is moving between nodes. Clients that
treat it as a failure surface 500s to their users. They now retry, but a read that needs no turn should be answered by
any node (or proxied to the owner).

### 4. Balanced CI shards and a cheaper sim (PR #112)
CI shards are balanced from recorded timings and the simulation is faster. Open PR, conflicting; merge it. The shared
CI machines are saturated and every rerun costs about ten minutes.

## Smaller gaps

5. **Spend limits have no daily window.** A client that wants "$N per day per agent" must reset the limit by hand every
   day (camel-bots' watcher does). Add a `window: "day"` option.
6. **Tool credentials are static tokens only.** Short-lived credentials (GitHub App installation tokens) need a
   credential provider that can mint on demand.
7. **No per-tool write caps and no dry-run or fixture mode.** Agents that file issues or send mail need "at most N
   writes per run/day" and a mode that prints what they would do.
8. **No alert when a scheduled agent stops running.** Add a missed-schedule metric and alarm.
9. **No git or shell sandbox,** which blocks agents that open pull requests from inside camelRun.
10. **Catalog prices come from Pi and have been wrong twice** (Sonnet 5.5 cache reads, fixed in #134; Azure OpenAI's
    missing long-context tier, fixed in the Azure PR). Add a price audit test against a checked-in table of provider
    list prices, and report upstream.
11. **Azure OpenAI is platform-keys only.** A tenant cannot bring its own Azure endpoint and deployments (the catalog
    marks `azure` as needing an endpoint and deployment, not one key).

## Compaction (from comparing with pi-durable)
The host compactor these were for was removed with the legacy engine: Pi compacts natively now. Check Pi's own
summary path for the same gaps before reviving any of them.
12. **Retry the summary call** (3 attempts with backoff, not on abort or spend-limit refusal).
13. **Reject a truncated or empty summary** (`stopReason: "length"`, empty text, or a tool call): never save a cut-off
    summary.
14. **Leave the model's thinking out of the serialized summary transcript** (upstream dropped it on 2026-10-11 after it
    caused summary-request overflows).
15. **Cached summary call (not now):** reuse the agent's cached prefix for the summary request instead of a separate
    serialized prompt. Estimated to cut a 250k-token compaction from about $0.33-0.46 to about $0.16, but only with a warm
    cache; needs identical tools, system prompt and thinking settings and a fallback to today's path.
12 to 14 were assigned and not yet pushed.

## Done during this work (for context)
- `runLimits.contextTokens`, pinned leading system message (#133), thrash guard (#135), count the system prompt once and
  skip empty compactions (#136).
- Sonnet 5.5 cache-read price fix (#134), alarm tuning (#138, needs the guarded apply).
- Schedules: `history: "none"` and bounded delivery retries (#137).
- Azure OpenAI platform images and transcription (#115) and chat models (#139): open.
