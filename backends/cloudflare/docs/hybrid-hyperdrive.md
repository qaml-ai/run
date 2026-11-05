# Local Hyperdrive binding and credits transaction

Measured November 5, 2026. Code: `spikes/hyperdrive/`. Raw samples and the
post-migration catalog: `hybrid-hyperdrive-results.json`.

This verifies a real local workerd Worker calling a SQLite Durable Object,
which uses `pg` through `env.HYPERDRIVE.connectionString` to execute real
Postgres transactions. All **112** repository migration files applied unchanged
to a fresh PostgreSQL **16.15** container. Its catalog has **109** live tables
created by migrations, plus the runner's `schema_migrations` bookkeeping table.
No production connection, database, AWS API or Cloudflare resource was used.

**The local binding is not the deployed Hyperdrive proxy.** Cloudflare documents
that `localConnectionString` connects directly and does not use its connection
pool or query cache. These numbers establish local API/driver/schema feasibility,
not network latency, pool saturation or regional placement in Cloudflare.
[Local development](https://developers.cloudflare.com/hyperdrive/configuration/local-development/).

## Transaction and failure evidence

The DO opens one client per operation, starts `BEGIN`, locks the tenant's
`credit_accounts` row, and checks the durable receipt before modifying credit.
The receipt stores a SHA-256 of tenant, call ID, reservation and final cost;
changed immutable payloads are rejected. Input amounts must be positive safe
integer micro-USD and the final cost must not exceed the requested reservation.
Those validation rules and the account lock enforce the fixture's paid-balance
bound. They are not a production pricing, authorization or account quota system.
The `charge` operation reserves credit and settles it in that same transaction:

1. Read available balance minus live `credit_holds`; refuse if insufficient.
2. Insert the hold, append `credit_ledger` and update `credit_accounts` together
   using a data-modifying CTE.
3. Update `credit_spend_minutes`, insert the UUID into `usage_flushes`, and
   remove the hold; `COMMIT` all these changes or `ROLLBACK` all of them.
4. Close the client in `finally`. No client lives in a DO instance field.

This is a narrow paid-credit proof derived from `src/credit-holds.ts`,
`src/billing.ts:postLedger/accrueUsage` and `src/accounts.ts:flushUsage`.
It is **not** a copy or replacement of the complete billing implementation:
free-credit hourly limits, end-user lots, funding surcharges, pricing, usage
rollups, webhook enqueue and auto-topup remain outside the spike. A production
adapter should reuse those policy contracts and retain one transaction for
their Postgres writes. It must also bind tenant, agent generation, reservation
and receipt identity; the local unauthenticated fixture does not implement that
authorization layer.
The spike's `usage_flushes` row proves transactional deduplication only; it does
not exercise the native Pi usage pipeline. That pipeline distinguishes tracked
`model_attempts` from untracked `pi_usage_receipts`: usage with a
`billingAttemptId` must not be billed again through the receipt path.

| Test | Result |
| --- | --- |
| 60 sequential charges, 7,000 micro-USD each | Balance and sum of ledger both 580,000; spend counter 420,000; no holds left |
| 20 different DOs, same 100,000 balance, each requesting 15,000 | Exactly six committed, fourteen refused, balance 10,000; no overspend |
| 12 different DOs replaying one receipt concurrently | One committed, eleven duplicate results; one debit |
| Same receipt with different cost or reservation | Rejected as payload mismatch |
| Inject exception after ledger, balance, spend, receipt and hold writes | Entire transaction rolled back; retry committed |
| Commit succeeds, then an application error suppresses its acknowledgement | Retry found the receipt and returned duplicate without a second debit; this does not inject a network failure during COMMIT |
| Separate reserve and settle requests | Durable hold between calls; zero idle Postgres transactions; final settlement committed |
| DO A reserves 15,000 of 20,000, DO B requests 10,000 | B refused; failed A settlement preserved the hold; successful 10,000 settlement released the unused 5,000 |

The last test models the useful production boundary: reserve in a short
transaction, commit that reservation, run the provider outside Postgres, then
settle with another short transaction. Never hold an account lock over model
inference. Journal the pending settlement with the canonical DO model entry and
retry its immutable receipt until Postgres acknowledges it. A crash after
Postgres commits but before the DO records its acknowledgement is handled by
that same receipt. This is at-least-once delivery plus deduplication, not an
atomic transaction spanning SQLite and Postgres. Reservation renewal, expiry
versus late settlement, reconciliation after long outages, stale generation
fencing and provider uncertainty still require production design and tests.

## Latency

Thirty samples per cohort. Milliseconds; percentiles use nearest rank. The
same DO still opens and closes a new `pg.Client` per request. “New DO” means a
fresh named object, not a guaranteed cold Worker isolate. Node client elapsed
time includes HTTP, Worker routing, RPC and JSON. DO elapsed time includes
Postgres connection, SQL and close; the local Worker clock has millisecond
resolution. The database runs in Docker on the same laptop.

| Cohort | Client p50 / p95 | DO total p50 / p95 | Connect p50 / p95 | Transaction + close p50 / p95 |
| --- | ---: | ---: | ---: | ---: |
| New DO name per request | 14.31 / 20.39 | 11 / 16 | 2 / 3 | 9 / 14 |
| Same DO name | 12.19 / 15.75 | 10 / 13 | 2 / 3 | 8 / 11 |

These are one run's raw observations, not a performance SLA. More than ten
sequential SQL round trips per charge will expose inter-region latency if the
DO sits far from the database. The production adapter should combine SQL where
correct, measure placement, and compare its p95 with the existing service.

## Limits and costs that change the decision

Current published limits are approximately **100 origin connections per paid
configuration**, approximately 20 free, a 15-second connection timeout,
10-minute idle connection timeout and 60-second statement limit. Distributed
pools can occasionally exceed the connection target. Workers client connections
are not capped by that origin count. Keep each transaction short and add
bounded admission/retry; this local test does not load the deployed pool.
[Hyperdrive limits](https://developers.cloudflare.com/hyperdrive/platform/limits/).

Hyperdrive is included in Workers Paid with unlimited queries and no separate
pool/cache or Hyperdrive egress charge. Free has 100,000 queries per day. That
does not remove Postgres instance, storage, backup or database-provider egress
charges, nor Worker/DO compute. We did not request billing access or measure
database-provider egress. A private production database would need a reviewed
private connectivity design; this experiment does not expose it publicly.
[Hyperdrive pricing](https://developers.cloudflare.com/hyperdrive/platform/pricing/).

Hyperdrive uses transaction pooling. Do not carry session-dependent behavior,
long-lived `LISTEN` connections, or per-agent persistent clients over unchanged.
For DOs specifically, Cloudflare warns that persistent database connections
can consume the pool; this spike closes them after each operation.
[Connection lifecycle](https://developers.cloudflare.com/hyperdrive/concepts/connection-lifecycle/).
Financial reads should bypass query caching or stay within the locking
transaction; a cached balance is never permission to spend.

## Reproduce and cleanup

From `backends/cloudflare`, after the backend's `npm ci`:

```sh
cd spikes/hyperdrive
npm ci
npm test
npm run typecheck
WRANGLER_LOG_PATH=.wrangler/logs ../../node_modules/.bin/wrangler deploy --dry-run --outdir dist
```

The runner requires local Docker and creates only a uniquely named
`camelrun-proto-hybrid-pg-*` container bound to loopback, with local trust
authentication. It refuses external database URLs, generates the
Hyperdrive local override internally, and never saves that override. Workerd
logs live in its temporary directory and are deleted. The first attempt with
password-free local trust failed because Wrangler requires a password in the
binding URL; no transaction ran in that attempt. The successful runner uses a
fixed non-secret dummy password which local trust authentication ignores. It
has no credential security significance and is never used against a remote
database. Diagnostics redact connection URLs.

On success and failure, `finally` closes the PG client, stops the spawned
workerd process group, removes the owned container and removes local state.
The completed run recorded `localWorkerStopped: true`,
`localPostgresRemoved: true`, `cloudResourcesCreated: 0`. No snapshot or cloud
resource remains from this spike. The dry run and isolated TypeScript check
also passed. Remote Hyperdrive performance, failover behavior, private database
connectivity and the complete account/billing policy are explicitly unverified.
