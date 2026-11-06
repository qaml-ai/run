# Workers port bug audit

Audited 2026-11-05 against main `1c4b59cbf318bc0a883ab574c32106ebe5b23c18`
and integration branch `109d0aaf9a87cbc6ddc82e49f6ea8f4b9bb44964`.
Main deploys to ECS. None of this audit ran against production or AWS.

Read the bodies, review submissions, conversation comments and inline review comments for
[#647](https://github.com/qaml-ai/run/pull/647),
[#651](https://github.com/qaml-ai/run/pull/651),
[#653](https://github.com/qaml-ai/run/pull/653),
[#654](https://github.com/qaml-ai/run/pull/654),
[#655](https://github.com/qaml-ai/run/pull/655),
[#656](https://github.com/qaml-ai/run/pull/656),
[#657](https://github.com/qaml-ai/run/pull/657),
[#658](https://github.com/qaml-ai/run/pull/658),
[#659](https://github.com/qaml-ai/run/pull/659),
[#660](https://github.com/qaml-ai/run/pull/660),
[#661](https://github.com/qaml-ai/run/pull/661) and
[#662](https://github.com/qaml-ai/run/pull/662), and inspected the integration commits and
their source changes. No human review notes were returned; the two conversation notes
were CI reports about the unreleased-note format. The per-case inventories in the PR
bodies and integration measurements distinguish missing port implementations from bugs
in shared logic. Passing a port contract does not by itself prove an ECS fix is needed.

## Candidates checked directly on main

| Bug | On main? | Evidence | Fix |
| --- | --- | --- | --- |
| Agent creation acquires a second pooled connection inside a transaction | No | Port fix `88b8ada4` adds a prepared limiter for Workers' transactional caller. Node calls create admission before its transaction (`src/api.ts`, `src/client-sessions/configuration.ts`). The new one-connection probe creates a non-admin tenant's agent and deletes its account. | None |
| Account deletion acquires a second pooled connection or escapes the operator's cleanup scope | No | `src/account-deletion.ts` uses its transaction's `sql` for final deletion. Port commits `12668493` and `9af166c0` add a tenant restriction for the pilot operator, not a pool fix. The one-connection probe completes account deletion. | None |
| Recovery bills the delay after a host task completed | No | `a62ab750` changes Workers' durable host task receipt to use Pi `endedAt`. ECS executes host code directly (`src/agent-host.ts`) and has no such receipt; `src/client-sessions.ts` resets `activeSince` when resuming and `src/client-sessions/spend.ts` reports only that active interval. This conclusion is from source tracing, not a new crash fault-injection test. | None |
| Deleted agents keep spend-limit rows | No | Main's agent purge already deletes `agent_spend_limits` in `src/client-sessions.ts`. The new account-deletion probe checks the row exists before deletion and is gone afterward. | None |
| Web tools debit tenant credit without end-user attribution | No | `src/capabilities/router.ts` calls both `recordUsage` and `endUserCharge`; `src/client-sessions/spend.ts` attributes to the subject and run bucket with retry. `tests/capability-router.test.ts` checks both calls. #660 added the missing Workers adapter. | None |
| A throwing Pi hook lets a model call continue past the context guard | No | Workers correction `39f663a1` moves admission outside the hook. ECS awaits `prepareRequest` directly in `src/pi-durable/agent.ts`, before `streamFn`. Existing live and recovered oversize tests assert the coded refusal without another model call. | None |
| Queued configuration delays an end-user-change 409 | No | `reconfiguration` validates immutable subject/context before it queues configuration. New probe blocks a model call, queues two configurations, and requires the changed subject to return 409 within three seconds while that call remains blocked. | None |
| Completion is visible before billing releases the busy slot | No | Main awaits `releaseBusy` before publishing the completed request in `src/client-sessions.ts`. `tests/busy-release.test.ts` covers success, failure, abort, acceptance races and repeated next-agent admission. Port correction `39c6ade4` drains its own receipt outbox. | None |
| Credit refusals lose their structured reason through the model stream | No | `src/agent-host.ts` installs the synchronous credit-stop callback, preserving reason, bucket and end-user fields. `tests/end-user-reasons.test.ts` covers all refusal reasons and SDK propagation; `tests/end-user-runs.test.ts` covers mid-stream exhaustion and no retry. | None |
| A tenant's own decision key is treated as platform credit | **Yes: operator-configured keys** | The shared auxiliary credential helper in `src/node.ts` used `source !== "tenant"`, misclassifying `source: "admin"`. The failing-first prepaid test recorded `[responses, platformResponses, platformCost] = [1, 1, 0.012]` for a $0.01 call on the tenant's own key. Expected `[1, 0, 0]` and unchanged credit. Stored tenant keys already worked. | `codex/ecs-auxiliary-key-billing`: classify only `source === "platform"` as platform-owned. The helper also serves image, speech and transcription calls; normal model pricing is unchanged. |
| A tenant's own search key is treated as platform credit | No | Search already tests `source === "platform"` in `src/capabilities/router.ts`. `tests/web-search.test.ts` explicitly covers operator-configured tenant keys as well as stored keys and platform fallback. | None |
| Browser chat-store bundle exceeds its budget by 504 bytes | No | #651 reports 9,720 bytes after the integration-only WebSocket change `443b17cd`, against 9,216. Main has no `clients/event-transport.ts` import and its unchanged browser bundle test passes. Do not increase the budget on main. | None |

## Other fixes and findings inventoried

These rows group related port omissions from the PRs' case inventories. The cited main
tests define the behavior the port was implementing. They are not additional confirmed
main regressions. Unrelated workflow and tool-search feature commits on the integration
branch are outside this bug backport.

| Source | Bugs, missing behavior or findings in the port | Main evidence / disposition |
| --- | --- | --- |
| #647, #660 | Fixed turn reservations; omitted account, authentication, encryption, credit-hold, model-attempt and webhook services; billing adjustment, checkout, refunds, disputes, top-up, signed outbox and email adapters | Existing `accounts`, `billing`, `credit-holds`, `model-attempts`, `billing-refunds`, `auto-topup`, `webhooks` and mail suites. Workers adapters, no main backport. |
| #651, #656 | Node cases not executable in the old inventory; SDK-only cases miscounted as HTTP; incomplete assertions/results; dropped fixture storage; cancellation leaks; unnecessary baseline invalidation; slow unsupported waits and shard reporting | Test-harness defects in the port comparison, not production runtime defects. Bundle finding is checked above. |
| #653, #654 | Wrong upsert model/language/settings inheritance; virtual-model fallback; Azure deployment/protocol/errors; tenant endpoints and scoped/federated credentials; DeepSeek retry/backoff; content-filter fallback; structured output forcing/reminder/reset/result; lost catalog prices and end-user hold costs; compaction/fallback attribution | Existing `agent-language`, `default-model`, `model-settings`, `virtual-models`, `azure-models`, `model-endpoints`, `anthropic-federation`, `deepseek-replay`, `content-filter-fallback`, `structured-output`, `model-pricing-trust`, `openrouter-model` suites. #654 changes no source behavior. |
| #654 | Large 6 MiB input may exceed Durable Object row limits through duplicated fingerprints/journal records despite a passing 102 KiB compaction case | Workers storage limit; ECS uses Postgres and does not store that DO record. Port follow-up, not evidence of an ECS failure. |
| #653, #655 | Lost structured builtin results; missing schedule result/error shape; disconnected application admission/takeover details; keyed-upsert receipts/tool replacement; exposed OAuth agent token; MCP alias identity; early oversized-body refusal; missing public docs; large fork context rejection; MCP clearing/catalog differences | `builtins`, `attach`, `hosted-mcp`, `inline-mcp-servers`, `mcp`, `tool-calls`, `agents-upsert` cover Node behavior. Wrangler development-body draining was a fixture issue. |
| #653, #655, #661 | QuickJS instead of V8; missing Intl and V8 semantics; weaker CPU/parser isolation; Node drain/recovery probes unavailable against DO storage | Main retains `sandbox/v8-exec`, externally killable PDF parsing, Node HTTP drain and Postgres recovery. These are port architecture gaps or accepted differences, not ECS regressions. |
| #657 | File arguments and attachments; capped tool output; image settings/retry/receipts; search result extraction/fallback/accounting; workspace inheritance; volume idempotency; schedule email; self-host and CLI routes; journey delivery/export | `file-arguments`, `tool-files`, `request-images`, `image-generation-api`, `web-search`, `workspaces`, `volumes`, `schedule-mailer`, `selfhost`, `cli`, `journey` suites. File-argument and journey extractions preserve source behavior. |
| #658 | Lost queued definition revisions/overrides/tool changes; child message routing, wake caps and wait interruption; notification delivery during abort; parallel spawn/message order; delegated budgets/depth/cancellation; child settlement/recovery/double counting | `definitions`, `agent-messaging`, `agent-progress`, `background-agents`, `multi-agent`, `tool-spawn` suites. Fixes reside in Workers coordination. |
| #659 | Nested idempotency claims; canceled-run replay; configuration/prompt/rotation ordering; queued defaults and aborted child delivery; list/activity/history/run/SDK events; public routes; credentials; UI approvals/watchers; Python and webhook wakeups | Existing `agents-upsert`, `agent-lifetime`, `client-lifecycle`, `agents-list`, `history`, `runs`, `clients`, `webhooks` and UI suites. Node source and frozen contracts unchanged in #659. |
| #660 | Account ZIP export/deletion and ledger retention; missing end-user APIs; Access/ops authorization; storage credit/quota; provider roots; auxiliary receipts and lot/markup attribution; abandoned subscribers | `account`, `end-user-*`, `admin-site`, `ops-mcp`, `storage-limits`, `outbound-origins`, `tenant-reads` suites. Main-specific money candidates are checked individually above. |
| #660 | No periodic active-time flush, per-receipt rounding, five-minute maintenance, R2 storage accounting/deduplication gaps, retained revoked DO journals, missing deployed SES feedback/admin surfaces, local subscriber counters, weaker DNS pinning | Documented Workers behavior differences. Main has the existing batch flush, pollers, storage meter/GC, SES feedback, admin routes and outbound address pinning; no backport of those adapters. |
| #661 | Prepared model metadata/protocol overwritten; wrong unbilled administrator cost policy; stale rate-limit account policy; alias redirect origin; disconnected subscriber slot release; Python wait ended at wrong task boundary; judged-tool policy mismatch | `model-endpoints`, `model-pricing-trust`, `rate-limits`, `hosted-mcp`, `tenant-reads`, `tool-judge`, `judged-approval` and client suites. Own-key decision exception is confirmed above. Shared judge extraction preserves the source policy. |
| #661 | Schedule list raced a one-second scheduled fire | Port provenance explicitly does not establish a cause; unchanged focused and full cases later passed. No speculative main change. |
| #662 | Internal WebSocket relay/terminal close; Python closed-control handling; watcher quotas across hibernation; streamed R2 images; interrupted DO revocation; load cleanup scope, retries and sanitized diagnostics | Workers WebSocket/DO/pilot code. Node continues using SSE and its existing purge. Pool and cleanup-scope findings are checked separately above. |
| Integration | Blank public origin fallback and outbound tool credential validation | Main already uses `AGENT_PUBLIC_URL || fallback` and validates credentials. `0c6ea86c` fixes Workers fallback; source origin edit only narrows a type. No main bug. |

## Verification

All executions use isolated test Postgres and fake providers on Sprites. The requested
home-directory Sprite wrapper was absent; the repository's `scripts/sprite-test` was used.

- Main browser suite: 12/12, `rt-pool-14`, job `20261105-213038-62107-1`.
- Main context guard and credit refusal/run suites: 19/19, `rt-pool-15`,
  job `20261105-213111-66392-1`.
- Main busy-release, purge and agent-lifetime suites: 14/14, `rt-pool-15`.
- New main lifecycle probes: 2/2, `rt-pool-12`; typecheck passes.
- Decision regression before the fix: test-only commit `8672be04`, `rt-pool-12`,
  job `20261105-213218-77938-1`, fails with the platform attribution above.
- Decision fix: `0012d938`, typecheck and 43 focused tests pass on `rt-pool-14`,
  job `20261105-213308-84734-1`. Another eight media API tests pass on the same
  Sprite, job `20261105-213422-93589-1`.

Full main and fixed-branch suites, final documentation checks and PR links are recorded
below once complete. No merge or production rollout is part of this audit.
