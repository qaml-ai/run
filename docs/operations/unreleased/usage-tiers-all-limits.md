### Usage tiers set every per-account limit, raised; an internal tier; per-account decision concurrency

A prepaid account's usage tier (by credit paid in total) now sets every per-account limit, not only busy agents:
runs and agent creates a minute, js_exec executions and decision calls at once per node. The defaults are much higher:

| Tier | Paid | Busy agents | Runs/min | Creates/min | js_exec/node | Decisions/node |
| --- | --- | --- | --- | --- | --- | --- |
| Free | $0 | 50 (was 20) | 300 (was 240) | 600 | 4 (was 2) | 16 |
| Tier 1 | $5 | 250 (was 50) | 1,500 (was 600) | 1,200 (was 600) | 8 (was 4) | 32 (was 16) |
| Tier 2 | $50 | 1,000 (was 100) | 6,000 | 3,000 | 16 | 48 |
| Tier 3 | $250 | 4,000 (was 250) | 20,000 | 6,000 | 16 | 64 |
| Tier 4 | $1,000 | 10,000 (was 1,000) | 60,000 | 12,000 | 16 | 64 |

Each limit is the first of: set for the account (its tenants-file field, or `PUT /v1/tenants/{id}/limits`), none on the
internal tier, its tier's, the deployment's default. Unbilled accounts keep the defaults they had; an admin tenant
with `billing: "prepaid"` now has its tier's rate and js_exec limits instead of none.

- **`GET /v1/limits`** (new): the account's tier and the next one, every limit with its `source` (`tier`, `tenant`,
  `internal`, `default`) and what the next tier raises it to, and the tier table. The 429 for runs and creates says
  what the next tier unlocks.
- **`tier: "internal"`** in the tenants file: the operator's own applications, with no per-account limit unless a field
  of the entry sets one. Node caps (agents hosted, js_exec workers, decision calls, in-flight characters, memory, body
  shedding) and spend limits still apply. `infra/tenant.sh set-tier <tenant> internal|default`.
- **`decisionConcurrency`** (issue #493): decision calls at once for an account on a node, set like `codeConcurrency`
  (tenants file, `PUT /v1/tenants/{id}/limits`, null clears; `infra/tenant.sh set-decision-concurrency`), at most
  the node's, now `AGENT_DECISION_NODE_CONCURRENCY` (default 64). The account's queue and in-flight characters scale up
  with it (48: 3,000 waiting, 24M characters), the characters at most the node's 32M.
- **Visibility:** a `decision_wait` metric line (tenant, calls of a request that waited past 250 ms, the longest wait,
  the queue depth) and a `decision_load` gauge per tenant with calls in flight, sampled with `node_load` (which adds
  `decisionsActive` and `decisionsWaiting`).
- `AGENT_USAGE_TIERS` takes the new fields, each optional (left out: the deployment's default). `GET /v1/billing`'s
  `busyAgents.limit` is null on the internal tier.
