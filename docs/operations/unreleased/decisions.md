### Decisions: `POST /v1/decisions` and the `decide` builtin

Typed questions about a state (`noul` yes/no, `choice`, `score`) answered with calibrated probabilities by a decision
model: TypeSafe's Jev (`typesafe/jev-1.14`, pinned) through OpenRouter's decisions API (`/api/alpha/decisions`), on the
tenant's OpenRouter key or the platform's at OpenRouter's reported cost. One state, or a batch of up to 100 answered in
parallel (16 calls at once per tenant per node, 64 per node), with transient failures retried and Retry-After honoured.
Agents get it as the `decide` builtin, and from js_exec as `tools.decide({items})`, billed to the run's and agent's
spend limits (`usage.decisionCostUsd`). Usage has a new kind, `decision` (`decisions` counted), in `/v1/usage`, the
ledger and `usage.recorded`. The provider sits behind `src/decision-providers.ts`; nothing is cached or logged of a
state. `AGENT_DECISIONS_URL` points the adapter elsewhere (tests). See `docs/guides/decisions.md`.

Also: a provider answer with neither cost nor tokens is billed at the estimate (logged as
`decision_usage_untrusted`); `dataCollection: "deny"` (a request's, new on `POST /v1/decisions`, or an agent's) is sent as
`provider.data_collection: "deny"`, which the decisions API takes and TypeSafe serves (a 404 for want of such a host
is `DECISIONS_DATA_POLICY`); a
request body is at most 2 MB and characters in flight are bounded per tenant (8M) and node (32M), with a 429 before the
body is read; a key scope's chat `baseUrl` is not used; a call's own timeout is retried; end users settle at what the
tenant pays (the OpenRouter credit multiplier on the platform's key). Images and transcriptions asked for alone now
record their usage before settling an end user's hold.
