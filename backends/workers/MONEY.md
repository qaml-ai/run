# Workers accounts and money

This is an experimental parity track, not a production release. Postgres remains
the authority for identity, credentials, credit, usage and delivery intent.
Durable Objects hold the agent's pending receipts and retry their acknowledgement.
No production database, AWS credential or live Stripe key was used.

## What moved

The source implementations of Accounts, Billing, BillingPayments, AutoTopup,
CardCredit, BillingAlerts, EndUserCredits, ModelAttempts, Workspaces,
Webhooks, Stripe, Tenants, KeyScopes, ModelProviders, ConsoleAuth, OAuth,
EmailAccounts, Passwords, RateLimits and BrowserTokens now run against the Workers
database adapter. Generated copies change host imports; scripts reject source
drift. Source model-stream accounting, token estimates, provider cost parsing,
transaction retry policy, outbound response bounds and HTTP idempotency are reused.

The HTTP adapters expose signup/login, password/reset, console sessions, OAuth,
API tokens, provider keys, custom providers, key scopes, tenant configuration,
end-user credit, billing adjustments, checkout/portal, payment history, Stripe
webhooks, billing alerts, usage, webhook endpoints and workspace membership.
Provider secrets use the same AES-256-GCM records and associated data as `src/`.
API tokens have the source's tenant authority; a named key scope selects provider
credentials. This does not invent per-token permission scopes absent from source.

Platform model calls for prepaid tenants admit with positive spendable credit,
including the free hourly allowance and dispute checks. Admitted calls settle in
full and may leave a negative balance. End-user holds still determine the output
budget when applicable. Duplicate model finishes and turn receipts do not debit
twice. Subject, actor, bucket, request and workspace attribution travel through
the available prompt/child paths.

Native account and billing mail uses [Cloudflare Email Sending](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/). It has the
simplest Workers interface and needs no AWS access key or SigV4 implementation.
Source templates and single-use links remain intact. Configure an `EMAIL`
binding, a verified sending domain and `AGENT_ACCOUNT_EMAIL_FROM`/`EMAIL_FROM`.
Actual delivery and domain setup were not exercised; tests use a local receiver.

Stripe construction rejects every key except `sk_test_` or `rk_test_`. An API
override is permitted only for a loopback fake in `TEST_MODE`. The source payment,
refund, dispute, signature, funding and auto-top-up tests use that fake.

## Scorecard and verification

The original 146-case compatibility inventory remains **50 pass, 57 fail,
39 not applicable**; five passes reach workerd. Money services were not in that
inventory. This track adds **166 original source service-policy tests**, plus
Workers adapter and integration tests. The exclusions remain explicit in
`test/money-policy-port.json`, `test/billing-policy-port.json`,
`test/billing-core-policy-port.json` and `test/webhook-policy-port.json`: 39 cases
remain excluded for ECS/cluster, migration, storage or log-tail fixtures. They
are not counted as passing. Direct service tests
cover their financial/delivery policies, but do not establish every HTTP contract.

The three image-generation cases now pass the billing-adjustment prerequisite.
All four image API/SDK cases still fail at the existing upload/generation route;
no competing image path was built.

Validation commands, run from `backends/workers` unless specified:

| Check | Result |
| --- | --- |
| `npm test` | 217/217 pass; 91.8 seconds; subsequently expanded core billing file 13/13 pass |
| `node --import ./test/sdk-deps.mjs --experimental-strip-types --test --test-concurrency=1 --test-timeout=90000 test/*.integration.ts` | 40/40 pass; 91.0 seconds |
| `npm run test:compat` | 50 pass / 57 fail / 39 N/A; expected nonzero exit |
| `npm run typecheck` | Pass |
| `npm run build` | Dry-run Worker and codemode bundles pass |
| `node scripts/reuse-{sql,money,security,accounts,billing,http}.mjs --check` | Pass, run each script separately |
| `node scripts/port-{money,billing,billing-core,webhook}-tests.mjs --check` | Pass, run each script separately |
| Root `npm run docs` and `node --experimental-strip-types --test --test-name-pattern=llms.txt tests/docs.test.ts` | Pass, 2/2 docs tests |

Local tests use actual workerd and isolated Postgres databases/schemas with all
migrations. Their fake model and Stripe endpoints are loopback-only. The native
container test uses its own migrated fixture. The DO crash test kills/restarts
workerd after the Postgres debit and before receipt deletion, then checks one
debit and eventual acknowledgement. Other tests cover concurrent overspend,
rollback, changed-receipt rejection, expiry, one-time secrets, secret rotation,
webhook leasing, both outboxes, and billing mail.

## Deployed probe and spend

`measurements/money-cloud-probe.json` records the live experiment. Two deployments
of `camelrun-proto-money-20261105-keys` made eight HTTP probes. Actual deployed
Workers verified source AES-GCM interoperability and default scrypt
(`N=32768,r=8,p=1`), including password Unicode normalization. Two SQLite DOs
verified a crash after a fake financial-authority commit: replay kept one charge
and removed the pending receipt. The fake authority was not Postgres.

The Worker and its DO namespaces were deleted and absence verified. No cloud
resource remains. Estimated incremental spend is **under $0.01**, not an invoice.
There was no real deployed Hyperdrive/Postgres, Queue-delivery or email E2E run.
Local `Date.now()` readings during native crypto did not measure CPU; the 519 ms
password request is client wall time including networking, not a throughput claim.

## Known differences and remaining work

These are acceptance gaps, not implied passes from source reuse:

1. **Execution accounting.** Model calls on the implemented prompt and child
   paths are metered. Unsupported execute/continue/stateless-run/tool APIs need
   their owners to call the same services. Image/decision/search/computer usage
   and child-spend roll-up into a parent's budget are not all wired. Pi's provider
   boundary does not identify compaction; its calls are charged but labelled
   `response`. Background compaction may lack a request id.
2. **Active runtime time.** A turn's terminal receipt charges elapsed time since
   its observed start. Source reports active time every minute and stops counting
   while waiting for a person. Workers still needs periodic durable active-time
   receipts, pause/resume exclusion, and crash/restart time accounting. The
   current path can charge a human wait or downtime and can defer charges until
   completion. It must not handle paid production traffic yet.
3. **Agent/run budgets.** Available model calls enforce account/monthly and
   per-agent/per-request budgets. Agent budget reset uses attempt start time;
   source counts committed usage after a reset, including a call started before
   it. `model_attempts.finished_at` is not populated by source, so that boundary
   needs an explicit commit-time field or owner journal. Child/tool spend and
   complete stopped-result fields need agent-track integration.
4. **Admission.** Source pricing, usage tiers, tenant overrides and shared SQL
   create/run counters are applied. Per-address API buckets are per isolate,
   as source buckets are per node; this is not a global rate limiter. The tenant
   DO counts admitted requests instead of source busy agents. Its rows need
   leased recovery/reconciliation across a crash between admission and accepted
   work, and multiple queued requests for one agent must share a busy slot.
5. **Model surface.** Credentials resolve by scope/custom/tenant/platform order,
   but the current model registry supports Workers AI and the fake provider.
   Actual custom-provider and BYOK model execution awaits the agents track.
   `/v1/me.defaultModel` still uses the deployment model rather than the tenant's
   usable-model resolver. Browser-token child access/WebSocket projection also
   awaits that track.
6. **Account lifecycle.** Account/tenant export and deletion with retained
   financial records and asynchronous file cleanup are not implemented. Runtime
   identity tokens for downstream tools need the agents/platform wiring.
   Journey analytics callbacks and some source audit events remain unset.
7. **HTTP surface.** The adapters reuse core validation but are not the entire
   source router. Some key/custom-provider body-size limits, response details,
   successful rate-limit headers, unknown-route handling and configuration
   projection differ. Experimental `/v1/api-keys`, `rotate-secret`, account-email
   and credit-transfer routes remain extra aliases/features. Source deliberately
   removed tenant CORS-origin management: `/v1/cors-origins` remains 404 and its
   browser-token CORS policy is reused.
8. **Delivery maintenance.** Queues/cron call the source SQL leasing/outbox
   service. Bounded cron passes replace process-local polling, changing latency
   and requiring backlog monitoring. Run lifecycle webhook events are not yet
   emitted on every agent path. StorageUsage is available, but periodic R2 byte
   metering/charging is not connected. Email bounce/complaint suppression input
   and real sending-domain/deliverability verification remain open.
9. **Networking.** Native fetch preserves source redirect, deadline, size and
   address rules, but cannot pin the approved DNS address to the connection as
   Node's dispatcher does. DNS rebinding resistance needs a Worker-compatible
   egress boundary. Source operator origin exceptions are not exposed outside
   test mode. This matters before allowing untrusted custom endpoints.
10. **Operational proof.** Hyperdrive pooling, multi-region fan-out, encrypted
    secret rotation, concurrent/high-cost historical scrypt hashes, live Queue
    retries, and full deployed account-to-charge E2E still need isolated cloud
    qualification. The default scrypt probe is not a load test. Live Stripe is
    intentionally unavailable in this experimental backend.

The CTO decisions are whether native Email Sending is the permanent mail
transport, which egress boundary will replace address pinning, and whether the
remaining account/agent/storage work is worth a migration. The current evidence
supports continuing the experiment, not moving production money.
