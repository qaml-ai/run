# Cloud cost evidence — 2026-11-04

This is a working note for the feasibility report. It separates metered usage
from the final account bill. Measurements cover only `camelrun-proto-` resources.

## Billing access

The legacy account `billing/usage` request for `workersRequests` returned HTTP
200 with no rows. The current `billable/usage` v2 endpoint returned HTTP 403,
code 1171, `billable-usage.api.resource.insufficient_permissions`.
The account permission catalog calls the relevant permission `Billing Read`.
The error does not prove that adding that permission alone enables a restricted
alpha endpoint.

The v1 `billable-usage` endpoint did work. Its query must include the account's
billing-cycle anchor day; a query restricted to November 4 returned no rows.
The current-cycle query returned records through November 3, ending
`2026-11-04T00:00:00Z`, before this experiment. Those account-wide records cannot
establish the prototype's incurred cost. Do not label an empty query as $0.

## Published rates checked November 4

| Item | Rate before allowances |
| --- | --- |
| Workers Standard requests | $0.30 / million |
| Workers Standard CPU | $0.02 / million CPU-ms |
| Durable Object requests | $0.15 / million |
| Durable Object duration | $12.50 / million GB-s |
| SQLite rows read / written | $0.001 / million; $1 / million |
| SQLite stored data | $0.20 / GB-month |
| Container memory | $0.0000025 / provisioned GiB-s |
| Container active CPU | $0.000020 / vCPU-s |
| Container disk | $0.00000007 / provisioned GB-s |
| R2 Standard storage | $0.015 / GB-month |
| R2 Class A / Class B | $4.50 / million; $0.36 / million |
| GLM-5.3-flash input / cached input / output | $0.15 / million; $0.03 / million; $0.50 / million |

Sources: [Workers](https://developers.cloudflare.com/workers/platform/pricing/),
[Durable Objects](https://developers.cloudflare.com/durable-objects/platform/pricing/),
[Containers](https://developers.cloudflare.com/containers/platform/pricing/),
[R2](https://developers.cloudflare.com/r2/pricing/),
[GLM-5.3-flash](https://developers.cloudflare.com/workers-ai/models/glm-5.3-flash/).

Lite provisions 1/16 vCPU, 0.25 GiB RAM and 2 GB disk. Charging the full CPU
allocation continuously is an upper estimate, since actual CPU is metered:
`seconds * (0.25*0.0000025 + 0.0625*0.000020 + 2*0.00000007)`
= `seconds * $0.000002015`. Thus two lite VMs continuously active for 30 minutes
would be $0.007254 before allowances, excluding the Worker and DO.
Basic similarly costs at most
`seconds * (1*0.0000025 + 0.25*0.000020 + 4*0.00000007)`
= `seconds * $0.00000778`.

The four real model turns returned 2,319 uncached input tokens, 2,048
cached input tokens and 319 output tokens:
`2319/1e6*0.15 + 2048/1e6*0.03 + 319/1e6*0.50 = $0.00056879`.
The fourth turn intentionally streamed up to the 256-token output cap.
Pi's local cost fields agree, but are not invoice amounts.

R2 storage uses each day's peak, averaged over 30 days. A 0.567 GB backup kept
only on one day is approximately `0.567/30*0.015 = $0.0002835` before allowances;
do not prorate this down to a few minutes. Account-level billable-unit rounding
and included allotments can make the eventual invoice delta differ from the
unrounded usage calculation. The experiment did not buy another $5 plan.

## Telemetry interpretation

- Add prefixed Worker request and CPU usage at Workers rates. Do not charge
  Worker wall time as DO duration.
- Add DO requests and `durableObjectsPeriodicGroups.sum.duration` at DO rates.
  That duration already uses GB-s; do not multiply it by 0.128 again.
- An empty delayed DO dataset is unknown consumption, not zero consumption.
  A conservative fallback is independently counted object-seconds times 0.128.
- Worker and DO CPU fields are different scopes. CPU is useful operational
  telemetry; DO compute is billed by active duration, not its CPU field.
- Memory quantiles describe the whole isolate, even with an object filter.
  Neither a per-agent heap value nor available headroom follows from them.
- The benchmark's generated 567 MB fixture copies source and installed
  `node_modules` from the image. It measures directory IO, not network clone
  time. An idle VM dropping files is expected until explicit restore.
- A `Promise.all` fanout does not alone prove 100 simultaneously running turns.
  Report the overlap from server `began`/`endedAt` intervals, which the saved
  agent benchmark measures separately.

Final experiment totals belong in the feasibility report after the last
telemetry read and resource cleanup.

The final pre-cleanup sample, read at `2026-11-04T19:57:42Z`, reported:

| Observed usage | Unrounded list-rate calculation | USD |
| --- | --- | ---: |
| 1,223 Worker requests | `1223 / 1e6 * 0.30` | 0.00036690 |
| 1,555.445 Worker CPU-ms | `1555.445 / 1e6 * 0.02` | 0.0000311089 |
| 1,848 DO requests | `1848 / 1e6 * 0.15` | 0.00027720 |
| 264.291367168 DO GB-s | `264.291367168 / 1e6 * 12.50` | 0.0033036421 |
| 18 R2 Class A / 16 Class B | `18 / 1e6 * 4.50 + 16 / 1e6 * 0.36` | 0.00008676 |
| Four model calls | token arithmetic above | 0.00056879 |
| **Partial total** | | **0.0046344010** |

Container usage and R2 storage datasets still returned no rows. Their cost is
unknown in this partial total, not zero. The two backup records total
192,943,907 compressed bytes. A one-day peak of that amount costs approximately
`192943907 / 1e9 / 30 * 0.015 = $0.000096472` before allowances. SQLite operation
counts were not measured. The conservative planning envelope described below
was $1.07583 at 1,127.099 elapsed seconds; recompute its elapsed-time component
for the final cleanup boundary. This is a reserve estimate, not an actual bill.

`cost-telemetry.mjs` queries the prefixed Container application IDs and one
prefixed R2 bucket. `cost-summary.mjs` combines its latest sanitized artifact
with Worker/DO telemetry and the returned model usage. It reports empty
datasets explicitly and keeps an unrounded partial estimate separate from a
conservative planning envelope. The latter assumes at most 512 instantiated
DOs kept active throughout the experiment, two lite and two basic VMs kept
running, and explicit request/storage reserves; it is not an invoice maximum.
