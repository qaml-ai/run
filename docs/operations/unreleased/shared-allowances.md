### Shared end-user allowances

Tenant settings and end-user overrides accept `sharedAllowances`. Matching
buckets share one daily raw-cost allowance per person. Holds, settlement,
corrections, warning events, and exhaustion use that pool. Existing per-bucket
spend remains available. Reads include `today.pools` and each member's `pool`.
PUT replaces the supplied map. PATCH merges keys, with null removing a key.

The most-specific shared key selects the pool and takes precedence over ordinary
bucket allowances. Pool changes include existing member spend for that UTC day.
TypeScript and Python clients expose the setting and per-person overrides.

