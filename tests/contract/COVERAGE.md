# Contract coverage inventory

This inventory covers the shared HTTP, TypeScript SDK and Python SDK contracts.
It records source coverage, not execution results or complete repository parity.
`node tests/contract/list.mjs` and `python3 tests/contract/python.py --list` list the
current cases; `PARITY.md` records the actual backend results. A registered case
is not a pass, and a pure SDK case does not count as backend coverage. Parameterized
sources can produce more contract cases than their number of `test()` declarations.

## Product, account and billing coverage

The following cases join the agent/model/history ports documented below. Existing
source tests still own private storage assertions and direct service tests. The
shared cases drive HTTP or SDK calls, fake providers, webhook receivers and the
small backend fixture interface.

| Source under `tests/` | Registered shared cases | Public behavior retained |
| --- | ---: | --- |
| `account.test.ts` | 1 | ZIP export, redaction, authenticated deletion, immediate revocation, Stripe cleanup, identity reuse without another credit grant |
| `api.test.ts` | 15 total | Auth, provider keys, tokens, password/GitHub/Google sign-in, tenant reads, quotas, spend cap; two agent/model cases are listed below |
| `auto-topup.test.ts` | 1 | Quote amount/version, explicit consent, held amount and disable |
| `billing-alerts.test.ts` | 1 | Low/depleted webhook delivery and signatures |
| `billing-mail.test.ts` | 2 | Recipient settings, scanner-safe confirmation/unsubscribe, SES payload, low-balance mail, disabled-mail errors |
| `billing-payments.test.ts` | 1 | Portal ownership, redirects, payment-method view, checkout idempotency |
| `billing.test.ts` | 10 | Credit admission, catalog/actual/BYOK charging, active time, ledger paging, disabled Stripe |
| `computers-api.test.ts` | 7 | Both native providers, eager creation, delegated/subagent computer inheritance |
| `credential-exchange.test.ts` | 1 | Signed credential exchange, scope isolation and request authorization |
| `credit-holds.test.ts` | 1 | Public admission and credit reconciliation |
| `custom-providers.test.ts` | 5 | Provider CRUD, request formats, scoped selection and SDK behavior |
| `end-user-balance-events.test.ts` | 1 | Public balance events |
| `end-user-credits.test.ts` | 1 | Settings, users and ledger authorization |
| `end-user-history.test.ts` | 1 | History filters and paging |
| `end-user-lots.test.ts` | 1 | Credit lot behavior |
| `end-user-reasons.test.ts` | 6 | Public reasons |
| `end-user-runs.test.ts` | 6 | Run attribution, budgets and public accounting |
| `end-user-usage.test.ts` | 1 | Public usage summaries |
| `end-user-webhooks.test.ts` | 1 | End-user webhook payloads |
| `email-signup.test.ts` | 8 | Email signup, delivery, verification and admission policy |
| `file-arguments.test.ts` | 1 | File arguments across the public tool boundary |
| `files.test.ts` | 6 | Safe response headers, signed links and SDK attachments |
| `image-generation-api.test.ts` | 3 | Image generation API results, errors, usage and webhook observations |
| `image-generation-sdk.test.ts` | 1 | TypeScript image generation |
| `images.test.ts` | 2 | Uploaded/read images reach provider requests |
| `key-scopes.test.ts` | 5 | Scoped keys, rotation, gateway/header selection and isolation |
| `openapi-sources.test.ts` | 2 | Source discovery/import and public secret redaction |
| `operator-tenants.test.ts` | 1 | Operator tenant creation, secret-once replay, funding and deletion |
| `projects.test.ts` | 4 | Keyed projects, checked publications, restore/archive, pins and snapshot limits |
| `rate-limits.test.ts` | 4 | Public rate-limit responses, retry behavior and admission |
| `scope-providers.test.ts` | 2 | Scoped custom models and Anthropic bearer authentication |
| `spend-limits.test.ts` | 2 | Spend limits visible through runtime requests |
| `storage-limits.test.ts` | 1 | Credit-required uploads, 507 details and operator limit overrides |
| `tool-files.test.ts` | 5 | Tool-returned file content and SDK file boundaries |
| `usage-webhooks.test.ts` | 3 | Usage webhook delivery |
| `volumes.test.ts` | 1 | Full public REST/SDK volume lifecycle |
| `web-render.test.ts` | 1 | Shell rendering, failed-render fallback and exact billing |
| `web-search.test.ts` | 5 | Tenant/platform keys, provider order, warnings, admin accounting and codemode budget |
| `webhooks.test.ts` | 5 | Lifecycle/input/usage delivery, failed runs and legacy usage |
| `workspaces.test.ts` | 1 | Public workspace lifecycle |
| `x-search.test.ts` | 1 | Agent/stateless/codemode search, tenant/platform keys, exact charges and exhausted credit |

`node tests/contract/check-product-assertions.mjs` checks 49 product source declarations against
620 original public assertion expressions. Added setup assertions are allowed;
source assertions must remain in order. Its explicit exclusions are original
private-row checks and the account test's deliberately out-of-scope Discord
section. This audit is a subset of the whole product suite, not its pass count.

Billing setup uses public adjustments in place of direct ledger inserts when the
kind of setup entry is not itself under test. The Stripe fixture seeds only the
original primary/legacy customer references. Account signup and sessions use the
real public GitHub and password endpoints. Account row deletion, physical object
cleanup, tombstones and encrypted-at-rest checks remain in the source test; the
shared case retains the exported bytes, authorization, revocation and re-signup
assertions. The project archive probe drains its response body after
checking the same sequence number, so fixture teardown does not wait for a socket.

## TypeScript SDK and transport coverage

| Source under `tests/` | Registered shared cases |
| --- | ---: |
| `cli-api.test.ts` | 1 |
| `cli.test.ts` | 7 |
| `chatgpt-plugin.test.ts` | 2 |
| `deploy-drain.test.ts` | 6 |
| `http-drain.test.ts` | 1 |
| `sdk-lazy-connections.test.ts` | 4 |
| `sdk-multi-agent.test.ts` | 1 |
| `sdk-portable.test.ts` | 10 |
| `sdk-server.test.ts` | 9 |
| `ui-ai-sdk.test.ts` | 5 |
| `cors.test.ts` | 1 |
| `identity-tokens.test.ts` | 2 |
| `registry.test.ts` | 1 |
| `revocation.test.ts` | 3 |
| `ui-chat.test.ts` | 11 |
| `ui-handler.test.ts` | 15 |
| `ui-proxy.test.ts` | 6 |
| `watch.test.ts` | 16 |
| `webmcp.test.ts` | 2 |

The deploy/drain cases retain the SDK's public connection takeover, in-flight
tool completion, disconnect uncertainty, deadline and retry/idempotency
assertions. `http-drain.test.ts:15` also retains the HTTP keep-alive and
long-poll response assertions. Its fixture control sends the actual Node
process SIGTERM; Workers reports an unsupported lifecycle boundary rather than
pretending a local process kill is a deployed Worker drain.

All six public cases from `loop-reliability.test.ts:67,83,118,151,167,179`
are shared: hung-model run limits, stall retries/events, cancellation of queued
runs, held-message removal, consistent busy state and steering acknowledgments.
The final case at `:209` freezes an agent process with SIGSTOP and kills one
member of a two-Node cluster; that process-ownership fault remains source-only.

`selfhost.test.ts:39,48,57` retains environment-seeded tenant authentication,
missing-model-key errors, browser URL omission/override and signed link paths.
The parser and S3 configuration cases (`:12,32`) and SDK constructor helpers
(`:72,79`) remain pure source tests. The Workers fixture uses the original
tenant environment parser to express the same seed through its JSON binding.

All five `journey-server.test.ts` runtime cases (`:46,57,88,120,148`) are
shared. They retain console response/cookie behavior, browser event ingestion,
attribution delivery, agent/run milestones, account ZIP contents and signup
privacy assertions. A fixture seeds the original GitHub account and optional
journey consent row using source account logic. Empty-table checks, outbox-row
drain waits and direct consent-row assertions remain internal source checks;
delivered events and exported account data are observed through the public
boundaries. The local mail sink accepts actual Node SES or Worker email text
without synthesizing missing metadata.

The public documentation cases (`docs.test.ts:11`, `:49`, `:69`, `:104`)
cover anonymous Markdown/skill routes, redirects, crawler headers, traversal
rejection and helpful 401/404 responses. The three `ops-mcp.test.ts` cases cover
OAuth metadata, admin admission, token separation and read-only reporting tools.
`admin-site.test.ts:25` covers hostname isolation, Access JWT verification and
cross-tenant reporting with a local signing-key server. These ten cases retain
all 135 original assertion expressions.

These cover lazy connections, direct SDK calls, portability, client/server tool
protocols, token rotation, watch/reconnect behavior, CORS and UI transports. Some
cases are pure client/library behavior and are explicitly reported as `sdk-unit`.
They do not establish that either runtime served a request.

The browser bundle-size check in `ui-chat.test.ts:141` stays in the original
build suite; it does not exercise runtime or SDK protocol behavior. The integrated
WebSocket transport currently produces 9,720 gzipped bytes against its unchanged
9 KiB limit (9,216 bytes), verified by running the original source test. This
pre-existing build regression is separate from the backend contract results.
The other eleven chat projection/runtime cases are shared.

## Python SDK coverage

`tests/contract/python.py` imports the original `tests/python_sdk.py` cases and
replaces backend startup only. All 60 source cases are inventoried: 32 run against
the selected runtime, 24 are SDK/library cases and four voice/audio cases are
explicitly out of scope. The runtime cases retain agents, runs, stream deltas,
structured output, history paging/import/fork, images/files, project publication,
key scopes, usage webhooks, rotated credentials, tools and connection lifecycle.
The library cases include synchronous/asynchronous tool servers, token validation,
webhook signatures, retry hints, portable origins and version metadata.

## Exact source boundaries from the final HTTP audit

This is not a claim that every observable assertion in the repository has a
shared case. The final audit distinguishes the following concrete boundaries;
none is silently treated as a backend pass or as a channels/voice exclusion.

| Source | Shared coverage and remaining source-only observations |
| --- | --- |
| `auto-topup.test.ts:215`, `billing-payments.test.ts:170`, `billing-mail.test.ts:31,98`, `billing-alerts.test.ts:238` | Every existing HTTP/runtime case is shared. Remaining cases construct billing services directly, including reconciliation, refunds, retry/quiet periods and payment races. |
| `billing-refunds.test.ts`, `billing-disputes.test.ts`, `card-credit.test.ts`, `starting-credit.test.ts` | Respectively 5, 4, 6 and 8 direct service/SQL policy, concurrency and failure-injection cases. They contain no runtime HTTP case to copy. |
| `storage-limits.test.ts:105`, `web-search.test.ts:103,273,305,319,368`, `web-render.test.ts:47`, `x-search.test.ts:115` | Every existing HTTP/runtime case is shared. Other cases call storage/search providers or policy functions directly. |
| `storage-gc.test.ts:113,192` | Two runtime cases remain unported. They inspect local object/chunk garbage collection after delete/clone/pinning and need equivalent storage-observation fixture controls. Public lifecycle tests do not establish that physical cleanup occurred. |
| `email-signup.test.ts:233,251,264` | Private logging, pure configuration and startup rejection remain source-only; the eight public runtime cases are shared. |
| `docs.test.ts:130,148,158,167,180,190` | Packaging, generated-file/link freshness, release Compose pin, documented prices, identity-token examples and release-note assembly are repository/build checks. The four runtime HTTP cases are shared. |
| `webmcp.test.ts:24,78` | Schema annotations and absence of a browser model context are pure helpers. Both runtime-backed browser tool cases are shared. |
| `admin-mcp.test.ts:13,28,63,70,92` | Classification, registration metadata, attribution and report aggregation call functions/SQL directly. Admin-site and operations-MCP HTTP cases are shared, but do not duplicate all those report algorithms. |
| `request-images.test.ts:12,27,38,57` | Four pure request-transform tests cover provider caps, unchanged input identity, newest-image selection and PDF exclusion. HTTP image cases do not independently prove those exact 40/90-image budget boundaries. |
| `log-tail.test.ts` | All 15 cases construct log/owner/storage services. `:348` also uses an SDK against its hand-built session server; its prompt/history observations overlap shared tool/history cases, while storage-write counts, tail rows and ownership fencing remain implementation tests. |
| `compaction.test.ts` | All 21 cases construct supervisors/sessions or call model helpers directly. Shared model/data-collection/history cases exercise compaction, but the source's exact 60-image cap (`:638`), learned-window restart (`:603`), legacy journal and storage-row assertions remain source-only. |
| `anthropic-federation.test.ts:16,24,92,105,137` | Configuration, STS single-flight/refresh, direct Accounts precedence and direct `explicitKeyStream` calls remain service/provider unit tests. The real HTTP agent case at `:170` retains fallback, bearer headers, tenant/scope precedence and platform usage. Its three private log assertions remain in source. |
| `pi-durable-accounting.test.ts:25,101,127,140` | Seed effects, atomic receipt recovery/rollback and native receipt/attempt counts inspect storage and direct services. The two hosting variants at `:48` retain imported history, free import/fork/reset, provider-call count and exact public usage/spend; receipt and outbox row-count checks remain source-only. |
| `pi-durable-reclaim.test.ts:159` | This unported migration case manually writes `camel.legacy.context` and `camel.context.message` records using `PostgresPiStorage`/`commitWrites`, invokes `reclaimSession`, then tests cold-run/history/fork behavior. A portable test needs equivalent legacy checkpoint seeding and real reclamation hooks; ordinary history/fork coverage does not prove this migration. Other cases exercise reclaim SQL/CLI directly. |
| `images.test.ts:155,247,277` | Direct `createAgentHost`/Pi-storage tests inspect scaled journal bytes, 60-image hydration limits and provider rejection fallback. They do not start the public HTTP runtime. HTTP image upload/provider replay at `:112` and resize crash/retry at `:187` are shared. |
| `loop-reliability.test.ts:209` | This unported two-node recovery case freezes the agent child with `SIGSTOP`, records an abort, kills the owning node and checks takeover does not call the model again. It requires a child-freeze and two-node fixture, beyond the real whole-runtime restart hook. The other six public cases are shared. |
| `metrics-runtime.test.ts:8,58` | HTTP calls set up turns, keys and webhooks; the results under test are private structured metric records and their tenant/key-owner labels. No metrics endpoint is exercised. |
| `process-fatal.test.ts` | Both variants inject a Node process signal and assert exit code and private drain logs. Public draining/tool-connection behavior is covered separately by HTTP/deploy drain cases. |

The agent inventory below identifies other copied public portions and the
implementation assertions retained in their original tests. A related shared
endpoint case does not imply an unlisted source assertion passed.

## Agent, model, tools and history assertion audit

`node tests/contract/check-assertions.mjs` prints the current copied-case and
original-public-assertion counts. It compares assertion expressions rather than
pass counts. The table counts source cases copied here, including a case when its
public portion was copied and its implementation-only portion remains in the
original suite.

| Source under `tests/` | Copied / original cases |
| --- | ---: |
| `added-models.test.ts` | 1 / 4 |
| `admin-site.test.ts` | 1 / 1 |
| `agent-fork.test.ts` | 11 / 11 |
| `agent-language.test.ts` | 3 / 4 |
| `agent-lifetime.test.ts` | 7 / 7 |
| `agent-links.test.ts` | 1 / 1 |
| `agent-mcp.test.ts` | 3 / 3 |
| `agent-messaging.test.ts` | 5 / 5 |
| `agent-progress.test.ts` | 10 / 10 |
| `anthropic-federation.test.ts` | 1 / 6 |
| `agents-list.test.ts` | 1 / 2 |
| `agents-upsert.test.ts` | 13 / 14 |
| `agents.test.ts` | 12 / 12 |
| `api.test.ts` | 2 / 18 here; 13 more in the account/API ports |
| `attach.test.ts` | 5 / 5 |
| `azure-models.test.ts` | 3 / 7 |
| `background-agents.test.ts` | 7 / 7 |
| `browser-tokens.test.ts` | 4 / 4 |
| `builtins.test.ts` | 5 / 7 |
| `context-reset.test.ts` | 1 / 5 |
| `code-engine.test.ts` | 1 / 2 |
| `codemode-delegation.test.ts` | 4 / 4 |
| `content-filter-fallback.test.ts` | 3 / 7 |
| `data-collection.test.ts` | 2 / 3 |
| `deepseek-replay.test.ts` | 3 / 8 |
| `decisions-api.test.ts` | 5 / 5 |
| `definitions.test.ts` | 10 / 16 |
| `default-model.test.ts` | 3 / 5 |
| `deploy-drain.test.ts` | 6 / 6 |
| `docs.test.ts` | 4 / 10 |
| `end-user-usage.test.ts` | 1 / 5 |
| `errors.test.ts` | 1 / 1 |
| `history-formats.test.ts` | 1 / 5 |
| `history-import.test.ts` | 3 / 4 |
| `history-none-ignored.test.ts` | 3 / 3 |
| `history-pages.test.ts` | 4 / 12 |
| `http-drain.test.ts` | 1 / 1 |
| `human-input.test.ts` | 14 / 15 |
| `idempotency.test.ts` | 3 / 3 |
| `inline-mcp-servers.test.ts` | 4 / 4 |
| `judged-approval.test.ts` | 7 / 7 |
| `journey-server.test.ts` | 5 / 5 |
| `loop-reliability.test.ts` | 6 / 7 |
| `mcp.test.ts` | 9 / 9 |
| `model-endpoints.test.ts` | 5 / 6 |
| `model-pricing-trust.test.ts` | 3 / 5 |
| `model-settings.test.ts` | 3 / 4 |
| `multi-agent.test.ts` | 9 / 10 |
| `ops-mcp.test.ts` | 3 / 3 |
| `openrouter-hosts.test.ts` | 3 / 4 |
| `openrouter-model.test.ts` | 2 / 5 |
| `outbound-origins.test.ts` | 1 / 1 |
| `pi-durable-accounting.test.ts` | 2 / 9 |
| `pi-durable-context-guard.test.ts` | 3 / 7 |
| `prompt-options.test.ts` | 5 / 5 |
| `reasoning.test.ts` | 2 / 3 |
| `request-wait.test.ts` | 2 / 2 |
| `run-limits.test.ts` | 5 / 5 |
| `runs.test.ts` | 13 / 13 |
| `runs-busy-limit.test.ts` | 1 / 1 |
| `runs-messages-at-end.test.ts` | 1 / 1 |
| `runs-stall.test.ts` | 1 / 1 |
| `schedule-api.test.ts` | 3 / 3 |
| `sdk-multi-agent.test.ts` | 1 / 1 |
| `sender.test.ts` | 1 / 5 |
| `selfhost.test.ts` | 3 / 7 |
| `service-api.test.ts` | 4 / 4 |
| `stream-deltas.test.ts` | 4 / 4 |
| `structured-output.test.ts` | 7 / 7 |
| `tenant-reads.test.ts` | 7 / 7 |
| `tool-calls.test.ts` | 8 / 8 |
| `tool-spawn.test.ts` | 2 / 2 |
| `tool-streaming.test.ts` | 1 / 4 |
| `virtual-models.test.ts` | 4 / 10 |
| `webmcp.test.ts` | 2 / 4 |

## What stays in the original suites

Storage layout, SQL rows, journal chunks, process loading, local files, log text,
and direct policy-function assertions stay in their original tests. The shared
cases assert the HTTP, SDK, model-provider and webhook observations. In particular:

- Fork cases keep history, configuration, isolation and SDK assertions; SQL chunk
  ownership and fork log assertions stay in `agent-fork.test.ts`.
- History paging and stateless runs keep public cursors, ordering, retention and
  status assertions; private cursor rows, volume ownership and storage cleanup
  probes stay in their source tests.
- Human-input expiry uses the clock fixture instead of updating a SQL row. The
  pure `mayAnswer` policy checks and encryption-at-rest row inspection remain in
  the source. Channel policy is out of scope.
- Schedules use the fixture to set a due time and seed account state. Schedule
  delivery, authorization, suppression and response assertions are unchanged.
- Decisions observe an actual local webhook receiver instead of the Node outbox
  row. The payload assertions remain the same; Node log assertions stay in source.
- Service API configuration reads the prompt and tools through
  `GET /v1/agents/:id`. That response does not expose the thinking level, so the
  original `high` expectation is asserted on the next fake-provider request's
  reasoning effort. Local header files stay an internal test.
- The three unported `api.test.ts` cases are startup configuration (line 527),
  direct provider-key validation (531), and direct `Accounts.recordUsage` SQL
  aggregation (546). They do not drive the public HTTP API.
- Definition migrations for channels (260, 288, 303) are out of scope. The direct
  apply, tenant-limit and description-function tests (365, 406, 423) remain in
  source. Pure language, history conversion, model policy, sender rendering,
  streaming measurement and SDK-constructor tests also remain in their sources.

## Private setup replaced by fixture controls

- Keyed-agent expiry waits for its public TTL. The source's restart and edited
  `expires_at` row are not needed for the public replacement assertions.
- Agent MCP authorization obtains its OAuth token through the public password,
  consent and token endpoints; anonymous, cross-agent, cross-tenant and OAuth
  assertions remain unchanged.
- Legacy schedule history and an abandoned idempotency lock are seeded by small
  fixture controls. Tests still use the production scheduler and API handlers.
- The orphaned-child case resets the original settlement fields through a fixture
  control, then observes the parent's public `spendLimit.spent`, including the
  original $0.60 assertion. It waits for the idle owner to release before reading
  the durable settlement, because Node caches the owner's spend. A backend lacking settlement state reports a fixture
  failure; the control never simulates successful product behavior.
- The concurrent child case retains public spawn, limit validation and SDK
  expectations. Its exact reservation-row amounts remain an internal SQL check.
- Secret-once replay, parent abort/deletion, tool-result history and forks, and
  idle-agent reads retain their public assertions. Secret storage, settlement
  provenance, journal representation and process ownership stay internal.

## Model and MCP observations

Workflow scripts, their SDK entry point, child linkage and progress now run through
the same fixture. MCP cases cover direct/code execution, scoped credentials,
list-change notifications, definition refresh, legacy SSE, tool schemas, progress
coalescing/timeouts and inline MCP servers. SQL copies of sealed credentials stay
an internal check; public responses still must not disclose them.

Default-model cases cover tenant and key-scope selection, platform fallback,
upserts and definitions preserving existing choices. Virtual-model cases cover
fallback before output, no fallback for client errors, alias persistence and
recovery on the next prompt. Provider requests and public usage identify the model
that ran; the original fallback log record stays internal. End-user charges are
read through the public ledger; SQL holds and reconciliation markers stay in the
source suite. Endpoint tests retain wire-format, identity, signature replay,
compaction, error and billing observations for Anthropic, Responses, Bedrock and
Codex-compatible endpoints.

The added provider cases retain DeepSeek 1017 reasoning, request limits and
OpenRouter host selection (including `:nitro` and `:morph`), uncatalogued-model
lookup and its end-user admission price, Azure deployment selection, request
formats, cached usage, billing and error responses. The custom-provider origin
exception is checked independently from `web_fetch` restrictions. Code-engine
coverage retains V8 output and the public limits API's rejection of removed
engine settings. Exact stored model metadata, Node startup diagnostics and
metric-only assertions remain in their original files; no model-routing result
is synthesized by a fixture.

`model-pricing-trust.test.ts:27`, `:51` and `:95` retain the model-object
refusal, catalog billing, missing-usage estimation and admin usage expectations.
The legacy-model case restarts Node through a fixture, installs the exact
historical model with its free cost metadata and current fake-provider URL, and
runs the original assertions, including diagnostic-derived estimate checks.
Workers reports an explicit unsupported fixture failure if it has no equivalent
legacy stored model to restore; the adapter never simulates billing or estimates.
The direct catalog/estimator cases at `:108` and `:127` stay pure policy tests in
the source suite.

## Recovery faults tested through fixtures

The two recovery cases from `tenant-reads.test.ts:117` and `:144` now run through
explicit fixture controls, retaining their original assertions. The Node adapter
injects the original corrupt-header state and one failed pending-work write. The
Workers adapter must reproduce the fault at its actual persistence boundary or
report an unsupported fixture failure; it cannot fabricate the expected response.
These cases therefore remain visible on the scorecard even before equivalent
Workers recovery state exists.

| Source | Injected fault | Assertions |
| --- | --- | --- |
| `tenant-reads.test.ts:117` | Make a released agent unreadable with pending work, then control persisted recovery count/time | State and listing expose matching failures; retry intervals grow and cap at one hour |
| `tenant-reads.test.ts:144` | Fail the first durable pending-work update | Failed admission is not accepted; the same request ID can be retried and completes |

The audit also covers content-filter fallback, data collection, judged approval,
reasoning, DeepSeek replay, stalled/busy runs, final-message visibility and public
end-user usage. The content-filter case keeps provider, HTTP, history and webhook
assertions; its internal `model_cost` log wait remains in the source. DeepSeek's
runtime cases remain here, while direct `explicitKeyStream()` unit cases stay in
the original suite and are not counted as backend passes.

Channels and voice are deliberately out of scope. Other original cases not in
this inventory must be assessed separately; this document does not count them as
covered merely because a related endpoint has a case.


The shared context-guard cases cover first-load rejection, a live context crossing
its byte bound and crash/restart recovery. The last case uses an actual process
crash and the same persisted state; its coded outcome, readable history, abort
admission and no extra model call keep the source expectations. The resize retry
fixture kills the first real Node parse job and lets the next job run normally.
Workers reports a setup failure if no equivalent parse-job or federation exchange
boundary exists; the fixture never manufactures the expected image or token.

The ChatGPT plugin cases execute the original client script against the selected
base URL, including the separate issuer origin variant, password sign-in, consent,
MCP tools, refresh and revocation. Temporary client password files stay outside
the backend. The audit also retains deployment tool handover, drain behavior,
journey HTTP events, self-hosted configuration and public stop/stall/steer cases.
