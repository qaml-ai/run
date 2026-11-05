# Lifecycle and SDK gap closure

This branch was rebased onto `codex/workers-parity` at `5370128b` (files/platform PR #657, after fast harness PR #656).
The evidence below comes from local workerd on the team's Sprites pool. No cloud
deployment or production data was used. `src/`, the SDKs, and frozen contract
assertions are unchanged by this branch.

## Scope

The assigned list contained 59 observed failures: **57 now have passing evidence;
2 remain**. Results are cumulative focused runs, not a new 590-case scorecard.
The coordinator still owns the full run.

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

## Evidence

Tests ran through `scripts/sprite-test <revision> ...` or the new
`npm run parity` Sprite-pool wrapper. Static assertion checks ran in the same
leased Sprite checkout using `sprite exec`.
`backends/workers/scripts/check-lifecycle-sdk.sh` installs the Python and Workers
dependencies, runs both TypeScript checks, then runs the selected contracts.
`--files` selects unchanged TypeScript cases; `--python` selects the named
cases through the harness's isolated Python runner and runs Node before Workers.

| Revision | Selection | Result | Sprite log |
| --- | --- | --- | --- |
| `38021ff7` | Lifetime, list, idempotency, scoped configuration, agents, registry, errors, spend and 2 new regressions | 33/33 pass | `rt-pool-21:~/runs/20261105-161147-33055-1.log` |
| `7e1a6b18` | Runs, watch, lazy connections, rotation, history units | 39 pass; completion stress timed out | `rt-pool-2:~/runs/20261105-160520-2610-1.log` |
| `7e1a6b18` | Auth and UI ownership | 4/4 pass | `rt-pool-5:~/runs/20261105-160524-3308-1.log` |
| `83f54946` | Completion stress, MCP full queue, token revocation | 3/3 pass; completion stress 44.8 s | `rt-pool-2:~/runs/20261105-161042-29106-1.log` |
| `7e1a6b18` | Transport, identity, UI chat and handler | 33/34 pass; tool disconnect failed | `rt-pool-23:~/runs/20261105-160457-99653-1.log` |
| `7e8e242a` | Post-rebase lifecycle and cancellation smoke | 13/13 pass | `rt-pool-3:~/runs/20261105-161631-53676-1.log` |
| `7e8e242a` | HTTP, errors and webhooks | Node 15/15; Workers 15/15 pass | `rt-pool-29:~/runs/20261105-161657-55673-1.log` |
| `7e8e242a` | 13 focused Python cases, including all 9 assigned failures | Node 13/13; Workers 12/13; credit error timing fixed below | `rt-pool-5:~/runs/20261105-161636-53997-1.log` |
| `bed84579` | Python end-user credit, refusal code and bucket attribution | Node 1/1; Workers 1/1 pass | `rt-pool-23:~/runs/20261105-163027-5029-1.log` |
| `076160e6` | All 6 deploy-drain contracts plus synchronous-tool regression | 6/7 pass; explicit detach was delayed, prompting the native-pipe repair | `rt-pool-3:~/runs/20261105-161857-65506-1.log` |
| `bed84579` | 6 lifecycle regressions: queue/hash, spend, cancellation, omitted fields, refused file input, remount | 6/6 pass | `rt-pool-22:~/runs/20261105-163025-4865-1.log` |
| `015f851a` | Native-pipe cancellation, synchronous tool deadline and lazy connections | 10/11 pass; cutoff still timed out through the development proxy | `rt-pool-2:~/runs/20261105-163220-11266-1.log` |
| `d53c256c` | Public HTTP/errors/registry and document units | All 7 assigned cases and 2 document units pass; Node keepalive and missing-console fallback fail | `rt-pool-2:~/runs/20261105-163804-27951-1.log` |
| `661da5d2` | Missing-console fallback, document units, docs build and source llms checks | 3/3 focused checks, docs build and 2/2 llms checks pass | `rt-pool-5:~/runs/20261105-164050-36816-1.log` |
| `99625556` | Lifetime/list/idempotency/scoped configuration and 8 integration regressions | 23/23 pass; Workers typecheck passes | `rt-pool-4:~/runs/20261105-163904-30898-1.log` |
| `4bb82fab` | Python image and end-user credit cases after final files/platform rebase | Node 2/2; Workers 2/2 pass; both typechecks pass | `rt-pool-4:~/runs/20261105-165504-68986-1.log` |
| `57340d01` | Console journey routing and concurrent delivery after final rebase | 4/4 supported journey cases plus flush regression pass; both typechecks pass | `rt-pool-4:~/runs/20261105-165719-74137-1.log` |
| `e2dab3bd` | Public HTTP/console/docs and frozen assertion guards after final rebase | Public cases pass; docs build, 2/2 llms checks and both assertion guards pass | `rt-pool-2:~/runs/20261105-165315-65706-1.log` |
| `e2dab3bd` | Final files/platform rebase: lifecycle regressions, keyed sources, lifetime and schedules | 18/18 pass; root and Workers typechecks pass | `rt-pool-3:~/runs/20261105-165315-65720-1.log` |
| `99625556` | All 9 assigned Python cases after the tools/MCP rebase | Node 9/9; Workers 9/9 pass; both typechecks pass | `rt-pool-3:~/runs/20261105-163853-30385-1.log` |
| `47cb10b2` | Scheduled-email sender and recipient policy | 3/3 pass; Workers typecheck passes | `rt-pool-4:~/runs/20261105-164602-50961-1.log` |
| `41a5e3b7` | Blocking-tool regression after TCP close repair | 1/1 pass; Workers typecheck passes | `rt-pool-2:~/runs/20261105-164202-40957-1.log` |
| `41a5e3b7` | Cached-baseline lifecycle group, 3 Sprites | 98/102 pass in 250 seconds; 2 assigned host/fixture gaps and 2 additional scheduled-email gaps | `parity-workers-group-lifecycle.json` |
| `41a5e3b7` | Cached-baseline webhook group, 2 Sprites | 10/10 pass in 84 seconds; report merged separately after supplying local inventory dependencies | `parity-workers-group-webhooks.json` |

The final group runs reuse the checked-in green Node baseline
`37fe8ceacf3bc0cd00210c288964a3d85119933e53516aa4392d3f40854b56dc`.
Their reports retain the tested revision and complete case identities. The
lifecycle report was merged in a clean checkout of its tested revision after
the schedule follow-up began. No test was repeated to repair report collection.
Older hashes above name the actual tested snapshots before rebasing. The group
artifacts predate the final files/platform merge; the final overlap checks above
cover that merge. This is cumulative evidence, not a new full-suite result.

The initial complete Python area comparison at `ebf29e6c` had Node 56 pass and
4 out of scope, and Workers 49 pass, 7 fail and 4 out of scope. It also includes
pure SDK unit cases; those do not count as backend passes. Subsequent focused
runs cover every one of those seven failures, with passing evidence for each.

The earlier transport count of 34 includes 10 pure SDK unit cases. The source
disconnect case was first repaired with active-call pings, then reviewed and
replaced with explicit connection detachment: a synchronous tool must retain
its declared timeout. The final regression blocks the SDK loop for 3.5 seconds
under a 10-second tool deadline. The cutoff case finally passes after the test
TCP proxy propagates a client close to its upstream socket. The old relay left
that half-open and hid the disconnect from workerd.

Reproduction commands (at the listed tested revision; a changed Node source
key first needs the selected Node baseline with `--backend=node`):

```sh
npm run parity -- --backend=workers --group=lifecycle --shards=3
npm run parity -- --backend=workers --group=webhooks --shards=2
scripts/sprite-test HEAD bash backends/workers/scripts/check-lifecycle-sdk.sh --python <method names>
scripts/sprite-test HEAD bash backends/workers/scripts/check-lifecycle-sdk.sh --files <contract files>
```

The Python method names are the nine assigned `PythonSDKTest` failures.
The exact selections and outputs are retained in the Sprite logs above.

## Implementation

- Configuration requests share durable ordering with prompts. Omitted model and
  language resolve when the upsert is applied. Replacement defaults also resolve
  against the preceding queued configuration. Idle upserts return their completed
  receipt; busy upserts stay queued. Spend assignments take effect at
  acceptance, and replay does not reset consumed allowance. Cancelled or refused
  deferred prompts release their admission.
- Key generations survive rotation and keyed recreation. Public request views
  omit internal accounting and queue fields. Lists retain activity and failures.
- Public documents reuse the existing document handler through one generated
  static asset binding. POST idempotency and error
  handling match the source API. End-user routes use the existing SQL service.
- Console assets still pass through the existing account/journey handler. A
  coalesced follow-up flush delivers events enqueued during an active send;
  Workers do not have the source process's polling timer.
- Webhook intent is durable beside stream events. SQL controls retry timing and
  expiry; a new Worker restores a missing queue wake-up.
- Concurrent history readers share in-flight indexing. The fixture preserves
  Worker environment identity until tenant configuration changes, while reading
  that configuration on every request. No authentication result is cached by
  this change.
- The public Worker explicitly detaches the exact Durable Object SSE connection
  on cancellation. The internal connection header is removed before delivery.
  The test TCP proxy now closes its upstream when its client closes.

The broader lifecycle group also exposed two scheduled-email cases outside the
assigned list. `47cb10b2` maps the source sender setting in the fixture and uses
the same configured-tenant exemption as the source runtime, while retaining
recipient verification and suppression checks. Its three focused schedule
contracts passed. The final files/platform rebase already includes the same
runtime repair; the branch retains the fixture setting translation.

## Remaining failures and decisions

1. `tests/http-drain.test.ts:15` expects Node's `Keep-Alive: timeout=365`, then a
   process SIGTERM drain with `Connection: close`. Workerd has no Node HTTP
   server or process-drain hook. The unchanged case fails at the keepalive
   assertion; the fixture's drain operation is also explicitly unsupported.
   Decide the equivalent Workers host contract before implementing its adapter.
2. `tests/pi-durable-context-guard.test.ts:107` asks the fixture to inspect
   Postgres `resume_failures` and `resume_after`. Workers recovery lives in the
   Durable Object; `agentRecovery()` currently rejects this inspection. The
   startup and live oversized-context cases pass. A recovery-state mapping
   needs to inspect actual DO state, rather than inventing passing counters.

Dual SSE/WebSocket offers currently select SSE so SDK custom fetch and buffered
proxy fallback remain observable. Explicit WebSocket offers still work. This
restores the SDK contract but does not validate production SSE active-time cost
or hibernation behavior.

A final integration check also retains the files/platform track's known
`tests/journey-server.test.ts:120` account-export gap: `GET /v1/account/export`
returns 404. It is outside the 59 assigned failures. Console journey routing
and event delivery are checked separately. The final concurrent-flush
regression preserves delivery when the fixture keeps its environment identity.

The frozen assertion checks passed (311 ported cases / 2,516 assertions and
49 product declarations / 620 assertions). No source assertion was weakened
and no unsupported case was marked passed.
