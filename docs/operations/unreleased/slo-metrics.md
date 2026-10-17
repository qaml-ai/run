### Metrics for SLOs and limits

- `turn_metrics` has a `Fault` dimension (`none`, `platform` or `caller`): a failed turn is the caller's for an abort,
  a refusal, a context too long, the tenant's own key or credit, or an output the model never gave; else the
  platform's. Its new `FirstTokens` and `SlowFirstTokens` count the turns with a first token and those whose first token
  took over 30 s; its `stopCode` property is the turn result's code (`aborted`, `output_missing`, a limit's).
- `limit_refused` (metric `LimitRefusals`, dimensions `Limit` and `Tenant`): a request the API refused at a limit:
  `definitions`, `busyAgents`, `agentsPerTenant`, `agentsPerNode`, `endUserCredit` (with its `reason`),
  `voiceSessions`, `storage`, `monthlySpend`, `credit`, `freeCredit`, `rateLimit:<name>` (a tenant's).
- `tenant_limits` (metric `TenantLimitUsedPct`, dimensions `Limit` and `Tenant`): every 5 minutes, how much of its
  definitions, busy agents and monthly spend cap each tenant of the tenants file uses, in percent.
