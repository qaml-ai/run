# Round-two analytics query corrections

Read-only investigation on November 4, 2026. No billing endpoint was called.
All persisted resource metrics are attributed to the `camelrun-proto-` inventory.
The discarded discovery rows contained only dimension names; unrelated names
and their measurements were not retained.

- All queried datasets were enabled for the existing token. Their time-window
  limit was 32 days. Empty responses were not an authorization failure.
- Durable Object metrics arrived after the first attempts. At 20:34 the
  namespace-filtered rows were empty; by 20:37–20:39 they included the earlier
  20:22 workloads. Treat early totals as incomplete, not zero consumption.
- `durableObjectsInvocationsAdaptiveGroups` reports `scriptName: "__unknown__"`
  for these objects. Filter by the compact 32-character namespace ID from the
  prefixed inventory. A script-name filter can omit those rows.
- Container analytics expects UUID-form `applicationId`, such as
  `a55ea012-8ec7-47fe-bc58-fc13e1136693`. REST returned its compact form. Paired
  queries returned no usage with the compact form and real usage with UUID form.
- Workers AI `modelId` is the `@cf/ibm-granite/granite-4.0-h-micro` name, not the
  model-catalog UUID. Selecting `dimensions.requestSource` caused a valid query
  to return no rows on this account. Removing that dimension returned 1,905
  calls in the paired experiment. `errorCode`, cost-metric names and numeric
  cost-metric values work. This is an observed query pitfall; its server-side
  cause is unknown.
- SQLite row reads/writes are `durableObjectsPeriodicGroups.sum.rowsRead` and
  `.rowsWritten`. `durableObjectsSqlStorageGroups.max.storedBytes` is the SQL
  storage dataset; the older `durableObjectsStorageGroups` is a different
  storage metric. SQL stored-byte rows remained absent at 20:42 even with a
  full-day query, and are not assumed to be zero.

`codemode-telemetry.mjs` now records periodic/invocation sample intervals,
per-object maximum isolate memory, SQLite rows and SQL storage capacity. It
accepts `--inventory PRIOR_TELEMETRY.json` so the same namespaces and Worker
scripts can be queried after deletion. It validates every saved namespace's
ID and resource prefix before making a query. `round2-usage.mjs` contains the
Container and AI query corrections.

The rate units are distinct. DO `duration` is already GB-seconds, and its
observed ratio to `activeTime / 1e6` is 0.128. Do not multiply it by memory a
second time. Container allocated memory is byte-seconds, divided by `2**30`
for GiB-seconds; disk is byte-seconds, divided by `1e9` for GB-seconds. SQL
counts are rows, including index writes and hidden KV-table operations, not
queries. Maximum stored bytes are a capacity sample, not byte-hours. Apply
holding time separately when estimating storage charges.

Primary references:

- [Durable Object analytics](https://developers.cloudflare.com/durable-objects/observability/metrics-and-analytics/)
- [Container analytics](https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-container-metrics/)
- [DO pricing and SQL billing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [Container pricing](https://developers.cloudflare.com/containers/platform/pricing/)

Diagnostic evidence is retained under `bench/.state/round2-analytics-*`,
`round2-storage-*`, `round2-telemetry-diagnosed.json`,
`round2-telemetry-storage.json` and `round2-usage-diagnosed.json`. Final accounting
must use a later fixed interval and retain the missing-dataset caveats.
