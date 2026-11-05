# Lifecycle and SDK gap closure

Rebased onto `codex/workers-parity` at `1e4d0335` (accounts/money PR #660,
after delegation/configuration PR #658). Tests run on local workerd in the team's
Sprites pool. No deployment or production data was used. This branch does not
change `src/`, SDK code, or frozen contract assertions.

## Scope

Of the 59 assigned failures, **57 have passing evidence; 2 remain**. This is a
focused group result, not a new 590-case scorecard.

| Assigned source cases | Count | Result |
| --- | ---: | --- |
| Agent lifetime: keyed reconfiguration, ordered upserts, missing model key, expired/deleted key | 4 | Pass |
| Agent MCP progress, retry identity, full queue | 1 | Pass |
| Agent list cursor, filters, activity and last error | 1 | Pass |
| Agent credentials, get-by-key/id, approval resume | 3 | Pass |
| Public OpenAPI | 1 | Pass |
| Tool disconnect outcome | 1 | Pass |
| Client drain after abandoned calls, or with nothing to finish | 1 | Pass |
| Public docs, skill, robots, unknown route/authentication hint | 4 | Pass |
| Machine-readable error codes | 1 | Pass |
| Node HTTP keepalive and SIGTERM drain | 1 | Fails: fixture/host contract, below |
| POST idempotency, secret responses, abandoned claims | 3 | Pass |
| Runtime and signed parent/root identity tokens | 2 | Pass |
| Oversized resumed range recovery inspection | 1 | Fails: unsupported fixture inspection, below |
| Public UI registry JSON | 1 | Pass |
| Token rotation and upsert/rotation race | 2 | Pass |
| Run messages read during completion | 1 | Pass |
| Run admission and TypeScript run API | 2 | Pass |
| Lazy/eager SDK connection ownership | 2 | Pass |
| Scoped configuration | 1 | Pass |
| UI chat approval and user/thread ownership | 3 | Pass |
| Watch: poll, SSE, large snapshot, buffered proxy and hidden turn | 5 | Pass |
| Python SDK assigned cases | 9 | Pass |
| Billing, usage and run webhook assigned cases | 9 | Pass |

## Final evidence

| Revision | Selection | Result | Sprite log |
| --- | --- | --- | --- |
| `ca5aebe9` | Lifecycle group, 3 Sprites | 100/102 pass; only the two assigned host/fixture gaps below fail; 234.5 s wall time | `rt-pool-20/21/22:~/runs/20261105-172614-23246-{1,2,3}.log` |
| `ca5aebe9` | Definitions and delegation, 2 Sprites | 49/49 pass; 214.5 s wall time | `rt-pool-5/4:~/runs/20261105-172610-22958-{1,2}.log` |
| `ca5aebe9` | Assigned Python cases | Node 9/9; Workers 9/9; both typechecks pass | `rt-pool-25:~/runs/20261105-172632-23968-1.log` |
| `ca5aebe9` | Incoming unit tests and configuration replay regression | 42/42 pass with the standard strip-only loader; both typechecks pass | `rt-pool-5:~/runs/20261105-172500-21805-1.log` |
| `ca5aebe9` | Queue, definition target, keyed source and idempotency regressions | 12/12 pass; docs build, llms 2/2 and both frozen assertion guards pass | `rt-pool-26:~/runs/20261105-172633-24142-1.log` |
| `10c8ee95` | Webhook group, 2 Sprites | 10/10 pass; 53.0 s wall time | `rt-pool-5/20:~/runs/20261105-173248-32218-{1,2}.log` |
| `10c8ee95` | Python scoped credentials, token rotation, usage and credit buckets after the test-protocol repair | Node 2/2; Workers 2/2; both typechecks pass | `rt-pool-1:~/runs/20261105-173228-31526-1.log` |
| `53cf79a8` | Model settings and external provider gateways | 7/7 pass; both typechecks pass | `rt-pool-1:~/runs/20261105-173559-35299-1.log` |
| `53cf79a8` | Lifecycle, keyed-source, target-order, idempotency and lifetime checks after validation repair | 19/19 pass; both typechecks pass | `rt-pool-4:~/runs/20261105-173615-35649-1.log` |

The checked-in reports retain their actual tested revisions:
`parity-workers-group-lifecycle.json`, `parity-workers-group-webhooks.json`, and
`parity-workers-definitions_delegation.json`. The selected Node baseline key is
`1ff65be69bdb97687bb551ad863a1ab48c42d7c4726928e25ab5efd896fabdfc`.
The Python method names are the nine failures assigned in the task.

Intermediate integration runs exposed duplicate HTTP/file idempotency claims,
cancelled-request replay, aborted child notification delivery, abrupt fixture
queue shutdown, and a scripted provider protocol mismatch. The final checks
above cover their repairs. In particular, webhook recovery now delivers the
original token counts and provider cost after restart. No failed case was
reclassified or assertion weakened. The guards retain 311 ported cases with
2,516 original assertions and 49 product declarations with 620 assertions.

Reproduce from the corresponding revision:

```sh
npm run parity -- --backend=workers --group=lifecycle --shards=3
npm run parity -- --backend=workers --group=webhooks --shards=2
npm run parity -- --backend=workers --area=definitions,delegation --shards=2
scripts/sprite-test HEAD bash backends/workers/scripts/check-lifecycle-sdk.sh --files <files>
scripts/sprite-test HEAD bash backends/workers/scripts/check-lifecycle-sdk.sh --python <method names>
```

The helper runs root and Workers typechecks before selected cases. Python runs
Node before Workers. The pool runner uses a matching green Node baseline; it
never treats a missing baseline as a pass. Raw logs are also retained in the
ignored `measurements/runs/` directories.

## Implementation

- Configuration and prompts share one durable queue. Upserts keep order, resolve
  omitted settings at application time, and preserve a definition revision
  applied ahead of them. Idle applications return their settled receipt. Spend
  assignments take effect at acceptance; retries keep consumed allowance.
- Credentials preserve token generations through rotation and recreation.
  Request views hide queue and billing internals, while exposing source errors.
  Concurrent history reads share indexing work and retain completion messages.
- SDK streams detach their exact connection. SSE remains available for custom
  fetch and buffered-proxy fallback; explicit WebSocket offers still work.
- Public documents reuse the document handler through one asset binding.
  Nested HTTP/file adapters acquire an idempotency key once. Existing console,
  end-user, account, rate-limit and billing routes retain the integrated policy.
- Webhook intent is durable beside stream events; SQL owns retry time and expiry.
  The test fixture waits for active delivery handlers on graceful shutdown and
  preserves immediate crashes. Scoped scripted providers retain their configured
  wire protocol; real external providers keep their own protocol selection.
  Configuration acceptance validates the new model and all retained settings.

## Remaining failures and decisions

1. `tests/http-drain.test.ts:15` expects Node's `Keep-Alive: timeout=365`, then
   process SIGTERM drain with `Connection: close`. Workerd has no Node HTTP
   server/process-drain hook. The unchanged case fails at the keepalive assertion;
   the fixture also does not define that host operation. Decide the equivalent
   Workers host contract before implementing its adapter.
2. `tests/pi-durable-context-guard.test.ts:107` inspects Postgres `resume_failures`
   and `resume_after`. Workers recovery is in the Durable Object, and
   `agentRecovery()` does not map that state yet. Startup and live oversized
   context cases pass. The mapping must inspect real DO recovery state rather
   than invent counters.

Production SSE active-time cost and hibernation were not measured in these
local workerd checks. The coordinator still owns the full contract run.
