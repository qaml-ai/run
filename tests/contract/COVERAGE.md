# Contract coverage inventory

This inventory covers the agent, model, tools and history ports below. It is not a
claim of complete repository coverage or a test result. Each copied case identifies
its source file and line. `node tests/contract/list.mjs` lists the complete current
TypeScript suite; Python SDK cases are separate. `PARITY.md` records execution.

`node tests/contract/check-assertions.mjs` checks these 195 copied cases against
1,603 original public assertions. It compares assertion expressions rather than
pass counts. The table counts source cases copied here, including a case when its
public portion was copied and its implementation-only portion remains in the
original suite.

| Source under `tests/` | Copied / original cases |
| --- | ---: |
| `agent-fork.test.ts` | 11 / 11 |
| `agent-language.test.ts` | 3 / 4 |
| `agent-lifetime.test.ts` | 6 / 7 |
| `agent-links.test.ts` | 1 / 1 |
| `agent-mcp.test.ts` | 2 / 3 |
| `agent-messaging.test.ts` | 5 / 5 |
| `agent-progress.test.ts` | 10 / 10 |
| `agents-list.test.ts` | 1 / 2 |
| `agents-upsert.test.ts` | 13 / 14 |
| `agents.test.ts` | 12 / 12 |
| `api.test.ts` | 2 / 18 here; 13 more in the account/API ports |
| `attach.test.ts` | 5 / 5 |
| `background-agents.test.ts` | 6 / 7 |
| `browser-tokens.test.ts` | 4 / 4 |
| `builtins.test.ts` | 5 / 7 |
| `context-reset.test.ts` | 1 / 5 |
| `decisions-api.test.ts` | 5 / 5 |
| `definitions.test.ts` | 10 / 16 |
| `errors.test.ts` | 1 / 1 |
| `history-formats.test.ts` | 1 / 5 |
| `history-import.test.ts` | 3 / 4 |
| `history-none-ignored.test.ts` | 1 / 3 |
| `history-pages.test.ts` | 4 / 12 |
| `human-input.test.ts` | 13 / 13 |
| `idempotency.test.ts` | 1 / 3 |
| `model-settings.test.ts` | 3 / 4 |
| `multi-agent.test.ts` | 7 / 10 |
| `prompt-options.test.ts` | 5 / 5 |
| `request-wait.test.ts` | 2 / 2 |
| `run-limits.test.ts` | 5 / 5 |
| `runs.test.ts` | 13 / 13 |
| `schedule-api.test.ts` | 3 / 3 |
| `sdk-multi-agent.test.ts` | 1 / 1 |
| `sender.test.ts` | 1 / 5 |
| `service-api.test.ts` | 4 / 4 |
| `stream-deltas.test.ts` | 4 / 4 |
| `structured-output.test.ts` | 7 / 7 |
| `tenant-reads.test.ts` | 4 / 7 |
| `tool-calls.test.ts` | 7 / 8 |
| `tool-spawn.test.ts` | 2 / 2 |
| `tool-streaming.test.ts` | 1 / 4 |

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
- Service API configuration is read through `GET /v1/agents/:id`, with the same
  values asserted on public fields. Local header files stay an internal test.
- The three unported `api.test.ts` cases are startup configuration (line 527),
  direct provider-key validation (531), and direct `Accounts.recordUsage` SQL
  aggregation (546). They do not drive the public HTTP API.
- Definition migrations for channels (260, 288, 303) are out of scope. The direct
  apply, tenant-limit and description-function tests (365, 406, 423) remain in
  source. Pure language, history conversion, model policy, sender rendering,
  streaming measurement and SDK-constructor tests also remain in their sources.

## Remaining mixed public/private cases

These source cases still contain public behavior that is not fully represented
by these ports. They require additional backend-neutral setup or failure injection;
they are gaps, not passing or out-of-scope cases. No expectations were changed to
make a backend pass.

| Source | Remaining setup or observation |
| --- | --- |
| `agent-lifetime.test.ts:83` | Expired/deleted keyed agent replacement with SQL expiry setup |
| `agent-mcp.test.ts:33` | MCP prompt authorization with extra private fixture setup |
| `background-agents.test.ts:213` | Concurrent child budget reservation and tool spawn limits with SQL inspection |
| `history-none-ignored.test.ts:12` | Legacy prompt history flag plus once-per-agent log observation |
| `history-none-ignored.test.ts:51` | Legacy stored schedule history flag with private schedule setup |
| `idempotency.test.ts:35` | Secret-once replay protection plus stored-response inspection |
| `idempotency.test.ts:58` | Recovery of an abandoned keyed request and oversized request body |
| `multi-agent.test.ts:203` | Parent abort/deletion, child settlement and private cleanup inspection |
| `multi-agent.test.ts:232` | Sweep settlement of an orphaned delegate result |
| `tool-calls.test.ts:187` | Large tool detail/history/fork behavior plus private journal assertions |
| `tenant-reads.test.ts:95` | Idle-agent reads without process loading |
| `tenant-reads.test.ts:117` | Agent-load failure and bounded retry injection |
| `tenant-reads.test.ts:144` | Failed durable work-mark write and retry injection |

Channels and voice are deliberately out of scope. Other original cases not in
this inventory must be assessed separately; this document does not count them as
covered merely because a related endpoint has a case.
