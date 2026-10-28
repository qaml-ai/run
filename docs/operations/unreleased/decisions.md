### Decisions: `POST /v1/decisions` and the `decide` builtin

Typed questions about a state (`noul` yes/no, `choice`, `score`) answered with calibrated probabilities by a decision
model: TypeSafe's Jev (`typesafe/jev-1.14`, pinned) through OpenRouter's decisions API (`/api/alpha/decisions`), on the
tenant's OpenRouter key or the platform's at OpenRouter's reported cost. One state, or a batch of up to 100 answered in
parallel (16 calls at once per tenant per node, 64 per node), with transient failures retried and Retry-After honoured.
Agents get it as the `decide` builtin, and from js_exec as `tools.decide({items})`, billed to the run's and agent's
spend limits (`usage.decisionCostUsd`). Usage has a new kind, `decision` (`decisions` counted), in `/v1/usage`, the
ledger and `usage.recorded`. The provider sits behind `src/decision-providers.ts`; nothing is cached or logged of a
state. `AGENT_DECISIONS_URL` points the adapter elsewhere (tests). See `docs/guides/decisions.md`.
