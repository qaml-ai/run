# Workflow simplification: no live editing, a smaller script API, endings on the delegation path

> **Superseded in part (Miguel, 2026-11-14): there are no jobs.** Agents compute through one `bash` tool backed by
> one VM per agent per branch; `job()`, `job_run` and the `computer` tool family are gone, and parallel work runs as
> child agents, each with its own `bash` VM. The current design is [camel-fs-compute.md](camel-fs-compute.md) §2
> and §6. What this document says about jobs is the record of the replaced design.

Status: design, approved cuts (Miguel, 2026-11-12). Supersedes the "Edits and revisions", "Gates", "Timers" and
"Notices" parts of [swarm-workflows.md](swarm-workflows.md). camelRun has no external users: the code goes, not a
compatibility layer. Storage stays expand/contract (nothing dropped in the deploy that stops writing it), and a workflow
in flight at the deploy ends cleanly, as a fault or an abort, never hangs.

## What stays

The durable journal and its replay (`workflow_effects`, `workflow_steps`, snapshots), budgets and the ledger, capacity
(`WorkflowCapacity`), billing and usage roll-up (#820, #830, #846), `job_run`, `job()`/`commit()` on forks
(workflow-jobs.ts, workflow-branches.ts, workflow-forks.ts), the job-hosts work (#837–#851, #856, #857), the owner model,
the `workflows` builtin's `workflow_start`, `workflow_status`, `workflow_items`, `workflow_abort`, `workflow_budget`.

## Why: the bug fixes of #815–#858, by the feature that caused them

| PR | What it fixed | Feature | After the cuts |
|---|---|---|---|
| #815 | Owner notices retried from a `setTimeout` in `waitUntil`: lost on eviction, unbounded; one alarm for runner + notices + forks | Separate notices system (`workflow-notices.ts`) | **Gone** (cut 3): the ending outbox already has durable retries, backoff and give-up (`ending-outbox.ts`) |
| #817 | `gate()` asks a person through the inbox; expiry on the alarm; answer routing by `wf_` prefix | Gates | **Gone** (cut 2): workflow-gates.ts, `answerGates`, the `wf_` branch in `index.ts`, `mayAnswer` hooks |
| #818 | Children never started without `AGENT_PUBLIC_URL`; refusals answered as values | Children's origin | Stays (not caused by a cut feature) |
| #822 | `script_error` at start (`checkScript` before create and before an edit); guest TextEncoder/base64 | VM guest; edit | Stays; the pre-edit check goes with edit |
| #823 | A failed cancel retried at the end; `nextAlarm()` returning `now` for an uncancelled row woke every second | Runner alarm (cancels, timers, gates) | Stays for cancels; the alarm loses three of its deadlines (timers, gate expiry, notice retry) |
| #824 | 92 workflows' notices took the owner's 32 request slots (305 `Too many requests queued`); notices wait while busy and batch 20 per turn | Separate notices system | **Gone** (cut 3): child endings already wait for the owner and batch (`delegation-notifications.ts`) |
| #841 | A confirmed edit stayed paused forever; 33% "rerun" for one new commit beside kept results | Live editing: revisions, rerun threshold, `confirm` | **Gone** (cut 1) |
| #842 | Notices and `workflow_status` dropped `fault.message`; the `next` ladder (edit / resume / confirm / inbox / budget) | Notices + the six pause reasons | **Mostly gone**: a fault is an ending with `{ code, message }`; `next` has two lines left (budget, abort-and-restart) |
| #844 | The revision table matched by key only (stale result under changed args); an edit's dropped effects still ran as paid work | Live editing: kind/args matching across revisions | **Gone** (cut 1); the kind+args identity moves to the result cache's key, where it is the whole point |
| #846 | A workflow's children rolled up under `wf_…`, not the owner | Usage attribution | Stays |
| #848 | 15k `Agent deleted` RPCs at 5/s for hours: child endings, progress, **workflow notices**, cancels, wakes | Every sender; notices were one | Stays; one sender class fewer, and the ending outbox's `gone` answer already covers endings |
| #858 (B3) | A cold owner's startup waited on its own `notifications.drain()` (the notice's `receiveAgentMessage` → `send`), reset every 30 s, 107 s late or never | Notices on `receiveAgentMessage` | Stays as a general fix; workflow endings no longer take that path at all (`receiveEnding` stores a row and never sends inside startup) |

Of the 13 workflow fixes in the range, 7 (#815, #817, #824, #841, #842, #844, and the workflow half of #848/#858)
were the cost of features that go. What remains is children, jobs, cancels, origin and billing — the parts we keep.

## Cut 1: no live editing; a result cache instead

### Removed

- Runner: `edit()`, `revise()`, `resume({ rerun })`, `nextAttempt(…, "rerun")`, `diff()`, the rerun threshold
  (`WORKFLOW_LIMITS.rerunConfirmPercent`, `reruns = min(issued, finished − kept)`), `confirm_rerun`, the edit-time and
  first-step cancels of dropped work (#841, #844), `seen_revision`'s role, `delivered_step = 0` (table took it).
- VM: `adopt(table)`, kind/args adoption, `reused` on an issued effect, `settle()`'s "kept as if from the table". The
  VM still gets `settle()` for results a replay delivers: that is the journal, not a revision.
- Object: `edit`, `checkScript` before an edit (stays before create).
- Routes: `PUT /v1/workflows/{id}/script`, `GET …/diff`, `rerun` on `POST …/resume`.
- Tools: `workflow_edit`; `rerun` on `workflow_resume`; the `revision` field of every brief.
- SDKs: TS `Workflows.edit`, `Workflows.diff`, `WorkflowEdit`, `WorkflowDiff`, `revision` on `WorkflowSummary`,
  `rerun` on `resume`; Python `edit`, `diff`, `resume(rerun=)`.
- Tables (contract deploy, one release later): `workflow_revisions`, `workflow_revision_table`; columns
  `workflow_state.revision`, `workflow_effects.revision`, `seen_revision`, `workflow_steps.revision`.

### Storage, expand/contract

- Expand (this deploy): `workflow_state` gains `code TEXT`; on object start, `code` is backfilled from
  `workflow_revisions WHERE revision = (SELECT revision FROM workflow_state)` when NULL. The new runner reads `code`
  only. The revision tables are neither read nor written by it; they stay for one release and a later migration drops
  them. `workflow_effects.revision`/`seen_revision` are written as constants (1) until dropped.
- `workflow_effects` gains `cached_from TEXT` (the source `workflow:key:attempt`, null for a run result) and its
  `origin` gains the value `'cache'`.

### The replacement: abort, start again, reuse

To fix a workflow the owner aborts it and starts a new one. Finished effect results are reused from a cache, so a
restart pays only for what the old script never finished.

**Key.** `(scope, kind, canonical args)`; the args are the VM's canonical JSON, which already keys an effect's
identity (`key_conflict`). A repo-valued `agent()` or `job()` adds the resolved base tree to the key.
A string-valued job `at` still adds the volume's seq. A changed tree gets a different key.

**Scope.** The owner agent: `(tenant, owner.id)`; a workflow started through the API with no owner scopes to
`(tenant, "api")`. Reasons: the owner is who aborts and restarts, so that is where the repeats are; prompts are rarely
byte-identical across agents; and within one owner the payer and bucket are the same, so a hit never charges anyone
differently than a run would have. Cross-agent sharing can be added by widening the scope string later; nothing else
changes.

**Cacheable kinds.** `agent` and `job` outcomes that landed `ok: true` (an agent's `{ text, output, fork }`, a job's
`{ exitCode, stdout, stderr, outputs }` whatever the exit code: a failing test run is a result). Never: failed, refused,
aborted or cancelled outcomes; `commit` and `push` (they change a volume or a branch: effects, not results); anything
whose args carry `nocache: true` (the script's opt-out, for a prompt that must run again).

**Forks.** A landed agent result retains `{ repo, version }` through `cache/<keyhash16>`, owned by
`cache:<tenant>:<owner>`, for 3 days. A hit creates the receiving workflow's own branch from that version.
A missing version is a cache miss. Workflow end deletes only refs owned by that workflow, retrying held refs.

**`commit()` is idempotent, not cached.** It merges the fork ref into its base ref. Success answers
`{ committed: true, version, changed, files? }`; merging it again answers `changed: false`.
Conflicts answer `{ committed: false, conflicts }`. A fork of a bare version has no base ref to merge into.

**Lifetime and size.** An entry lives 7 days from its last hit, at most 2,000 entries and 64 MiB per scope (LRU on
`last_hit_at`); a result larger than 1 MiB is not cached (the workflow still gets it; only the restart pays again).
A hit refreshes `last_hit_at`.

**Where it lives.** A new Durable Object, `WorkflowResults` (binding `WORKFLOW_RESULTS`, `getByName(scope)`), SQLite:
`results (kind, args_hash, args, source, body, bytes, fork, created_at, last_hit_at, PRIMARY KEY (kind, args_hash))`.
Not the owner agent's storage (an API-started workflow has none, and the owner's SQLite is already the hot path of
#858) and not Postgres (workflows are Workers-only; no node reads them).

**Runner hooks.** Two seams in `workflow-runner.ts`:
1. At issue (`advance()` → before `executor.start`): for a cacheable kind, `results.lookup(kind, args)`; on a hit the
   effect is journaled as `origin = 'cache'`, `cached_from = source`, and landed in the same transaction with the stored
   outcome and `usage = { costUsd: 0 }`; `counts.cached` increments; the event `effect_cached` records the source. No
   capacity slot is taken and no child starts. Storage errors throw and leave the effect pending for retry.
2. At landing (`land()`), retain the cached fork version before journaling the result. A storage error throws, so the
   child row stays unlanded and retries. The journal remains the source for replay.

A hit is deterministic for replay: the journal row carries the outcome, so a replayed step delivers it from the journal
and never asks the cache again.

**Tool and API surface.** `workflow_items` shows `origin: "cache"` and `cachedFrom`; `workflow_status` counts gain
`cached`. No new tool. The owner's instruction (in `workflow_start`'s description, model-facing, exact):

> To change a running workflow, abort it and start a new one: finished agent() and job() results with the same
> arguments are reused, not paid for again.

### Pauses after the cuts

`PauseReason` today: `user | payer_exhausted | confirm_rerun | waiting_on_gate | capacity_refused | <fault code>`.
After: `confirm_rerun` and `waiting_on_gate` go with their features; a fault is no longer a pause (nothing fixes it in
place) but an ending: `status: failed`, `fault: { code, message }`, running effects cancelled as `abort()` does. Left:

| Stop | Who goes on | Change |
|---|---|---|
| `budget_exhausted` (status) | `workflow_budget` / `POST …/budget`; the runner goes on by itself above spent | As today |
| `paused` / `payer_exhausted` | The payer's credit | **Self-resuming**: the alarm re-checks every 5 minutes (backoff to 30) instead of waiting for `workflow_resume` |
| `paused` / `capacity_refused` | Another workflow ending | **Self-resuming**: re-open on the alarm every minute; `WorkflowCapacity` already answers `granted: false` cheaply |
| `paused` / `user` | `workflow_pause` → `workflow_resume` | Kept, without `rerun`. Recommendation: keep (two one-liners, in the API and both SDKs); drop later if unused |

The `waiting` status (only timers and gates open) goes with timers and gates: `running | paused | budget_exhausted |
completed | failed | aborted`.

## Cut 2: the script API is `agent`, `parallel`, `job`, `commit`, `push`

Removed from the prelude (`codemode/workflow-vm.ts`): `gate()`, `sleep()`, `phase()`. Kept: `agent()`, `parallel()`,
`job()`, `commit()`, `push()`, `log()`, `now()`, `random()`, `args`, TextEncoder/base64 (#822). `push()` stays: it is a
`job()` variant (~60 lines in workflow-jobs.ts, no bug history), the only way a workflow's tree reaches GitHub without
the owner doing it, and camel-code (a GitHub project agent) is the first intended caller; it is cut later if the
repositories work replaces it.

- Runner: `dueAt()`, the due-effects loop in `alarm()` (lines ~1040–1110), `expire()` on `EffectExecutor`,
  `WORKFLOW_LIMITS.gateSeconds`, `due_at`'s index use, the `waiting` status, `phase` on summary/items/log (the columns
  stay, written NULL, dropped with the contract migration).
- Object: `WorkflowGates` wiring, `answerGates`, the `gate_opened` notice, `gates` from `byKind`.
- `index.ts`: the `wf_` branch of `POST /v1/inbox/answers`; `agent-runtime.ts`/`agent.ts`: the workflow `mayAnswer`
  hook. Open gate rows in `agent_inputs` (`owner_kind = 'workflow'`) are closed `expired` by a one-off migration in the
  same deploy so no inbox shows a question nothing will read.
- Protocol: `IssuedEffect.phase`, `logs[].phase`, the `phase` bridge op, `options` for `gate`/`sleep`.
- Tools: `workflow_items` says "its agents, jobs, commits and pushes"; `workflow_start` loses the gate sentence (and
  the "finishes a phase or opens a gate" clause of its reporting sentence, which #855 rewrites; see External effects).
- SDK: `WorkflowItem.kind` is `"agent" | "job" | "commit" | "push"`; `phase` leaves `WorkflowItem`, `WorkflowSummary`,
  `WorkflowItemsQuery`; `WorkflowStatus` loses `waiting`; `WorkflowPauseReason` is `"user" | "payer_exhausted" |
  "capacity_refused"`. Python the same.
- Docs: the guide's table rows for `gate`, `sleep`, `phase`; `human-input.md`'s workflow-gate paragraph;
  `multi-agent.md`'s mention; `docs/operations/unreleased/workflow-gates.md` is deleted (never released).

The VM's prelude hash is part of the snapshot fingerprint, so every existing snapshot is refused and replays once from
the journal, which is the designed path (#822 did the same).

## Cut 3: a workflow's ending is a child ending

Today a workflow talks to its owner through its own notice system: `workflow-notices.ts` (rows, backoff, give-up, one
alarm with the runner, #815) → `receiveAgentMessage` → the owner's notification outbox (waiting while busy, batching
20, #824) → `<workflow_notification>`. Delegation already has every one of those parts for children, hardened by
#848 and #858. The workflow becomes, to its owner, a background child.

(wf-exchange, who implements this cut, proposed the shape below; it is adopted with one change, the budget and payer
stops, explained there. Tracked in #859.)

**Registration.** `workflow_start` from an agent writes a child row in the owner's children table before it creates
the workflow (the tool runs in the owner, so this is the owner's own storage, in the tool call's commit as `delegate`
does): `DelegatedChild { id: wf_id, key: wf_id, requestId: <the owner's run id>, parentRequestId: run.id, toolCallId,
name, background: true, made: true, workflow: true, status: "running", depth: place.depth + 1 }`, so the workflow is
an ordinary background child. `workflow: true` is a new flag on the row; it keeps `cancelRemote` off the agent path
(abort goes to `WORKFLOWS`) and picks the rendering. An API-started workflow has no owner and registers nothing, as now.

**Ending.** The workflow object keeps a `ChildOutbox` (ending-outbox.ts, unchanged) in its own SQLite on its single
alarm, instead of `WorkflowNotices`. A terminal end (completed, failed, aborted) stages a `ChildEnding` in the same
commit as the end: `WorkflowObject.told()` becomes `outbox.stageEnding(owner, { agentId: wf_id, requestId, record })`
inside the status transaction. On wake, a terminal end not yet staged is staged then (`workflow_state.ending_staged`
records it; the outbox's `INSERT OR IGNORE` on the request id makes a repeat harmless). The alarm flushes
(`outbox.flush()` → `AGENTS.getByName(owner).receiveEnding(...)`), with the outbox's backoff, 7-day give-up and `gone`
answer. The one-alarm seam stays (`alarmAt(runner, outbox.deadline(), forks.retryAt())`). The record:

```ts
record: { state: "completed", status: "completed" | "failed" | "aborted",
  outcome: { result: { reply: <one line>, output: { workflowId, status, result?, error?, fault?: { code, message }, counts, spentUsd, budgetUsd }, usage: { costUsd: 0 } },
             error?: <fault or error message> } }
```

`usage.costUsd` is 0: the children bill their own usage and already roll up into the owner (#846), so the row's
`spent` must not count it again. `reply` is the model-facing line, exact: `Workflow <name> completed.` /
`Workflow <name> failed (<code>): <message>` / `Workflow <name> was aborted.` The result or fault message in `output`
is cut at 16,000 characters as today (`workflow_status` has it whole).

**Stops.** wf-exchange proposed every non-terminal stop (budget, payer, capacity) as `receiveProgress`. Progress rides
on the owner's *next tool result* (delegation-progress.ts, `workers-progress-every-result`); it never wakes an idle
owner. An owner that ended its turn to wait for the notification (#855 tells it to) would then never hear that its
workflow stopped for budget, and the workflow would sit until the owner's next unrelated turn. So:
- `capacity_refused` and a user pause are **progress** (nothing for the owner to do; one waits for the account, the
  other is the owner's own act). `workflow_status` shows both.
- `budget_exhausted` and `payer_exhausted` **end the row's current attempt**: the same ending record with
  `status: "stopped"`, `outcome.result.stopped: "budget_exhausted" | "payer_exhausted"`, which gives the owner a turn
  through the ordinary child notification. `workflow_budget` (and `workflow_resume`) re-open the row as the next attempt
  (`attempt: n+1`, request id `<run id>:<n+1>`), which delegation already supports (`resumedRun`, `attempt`). A
  self-resumed payer stop re-opens the row from the workflow side: its next stage carries `attempt: n+1` and the
  owner's `resumedRun` adopts it. If `resumedRun` does not fit, the fallback is one row per stop (`key: wf_id:n`),
  never progress.

**Owner side.** `receiveEnding` → `complete()` → `finishChild()` → `host.notify()` → the ending outbox-and-batch of
`delegation-notifications.ts`: waits while the owner is busy, batches with other children's endings, dedupes on
`(agentId, requestId)`. The `workflowNotice` special cases in `delegation-notifications.ts` (`CARRIED_WORKFLOW`,
`WORKFLOW_NOTICE_BATCH`, `noticeSeq`, the "latest only, endings never folded" grouping) are deleted. `sender.ts` keeps
the `<workflow_notification workflow= name= status=>` block name (prompts and evals know it) but produces it from the
row's `workflow` flag, through the same `noticeBlock` as `<agent_notification>`.

**Rolling deploy.** A workflow started before the deploy has no child row on its owner, so `receiveEnding` answers
`accepted: false`. For that answer only, the workflow falls back **once** to the old notice (`WorkflowNotices.check`
of the ending, delivered through `receiveAgentMessage` as today) and drops the outbox row; a throw stays a retry. So
`workflow-notices.ts` survives this deploy as the fallback only: its `stage`, `gate_opened`, `phase` and pause events
are removed with their features, and a later contract PR deletes the file, its test and the `workflow_notice_state`
and `workflow_notices` tables.

**Deleted now.** `NoticeSummary`'s pause/phase fields, `noticeEvent`'s stop and phase branches, `workflowNext` (its
two surviving lines move into `workflow-tools.ts` as `next` on the brief: "Its budget is spent: raise it with
workflow_budget." and "To change it, abort it and start a new workflow: finished results are reused."); the
`workflowNotice` special cases in `delegation-notifications.ts`. `receiveAgentMessage`'s `metadata.kind === "workflow"`
handling goes with the contract PR.

**Facts kept.** Finished (with result), failed or fault (with code and message), aborted; spend and counts; the
budget/payer stop. Lost on purpose: `phase` and `gate_opened` (their features), `pauseReason: user`.

## What happens to in-flight workflows at the deploy

Everything below runs in `WorkflowObject`'s first `wake()` or alarm under the new build (`WORKFLOW_RUNNER_VERSION`
goes 1 → 2; the version is stamped on `workflow_state`), once, in one transaction, and then the normal path runs.

| Found | Done |
|---|---|
| `workflow_state.code` NULL | Backfilled from the current revision's row |
| `status = paused`, `pause_reason = confirm_rerun` | Ended `failed`, `fault: { code: "edit_retired", message: "Editing was removed: start the workflow again; finished results are reused" }`; pending effects cancelled, `cancelEnded` runs |
| `pause_reason = waiting_on_gate`, or any current `gate`/`sleep` effect pending | Ended `failed`, `fault: { code: "script_api_retired", message: "gate() and sleep() were removed: start the workflow again without them" }`; its open inbox rows closed `expired` |
| A script that calls `gate`/`sleep`/`phase` but has no such effect pending | Nothing now; the next step replays the script against the new prelude and faults `script_error` (ReferenceError), which is the same ending by the normal path |
| `status = paused`, `pause_reason` a fault code | Ended `failed` with that fault (a fault is an ending now) |
| `revision > 1` and running | Keeps running: the journal has every result; the current code is what it replays. No edit can follow, which is the new rule |
| Rows in `workflow_notices` not yet taken | Delivered by the old path, which stays this release as the fallback; rows whose event is a removed one (`phase`, `gate_opened`, a pause) are dropped and logged `workflow_notice_dropped reason=retired` |
| The owner has no child row for it (every pre-deploy workflow) | `receiveEnding` answers `accepted: false`; the workflow falls back once to the old notice (cut 3, "Rolling deploy"), so the owner still hears the ending. No new RPC |

Nothing loops: every branch either ends the workflow or leaves it on the normal path, and `runAlarm`'s loop guard
(#834, #835) is unchanged.

## Tool surface after the cuts (model-facing text, exact)

| Tool | Description |
|---|---|
| `workflow_start` | #855's text, minus the gate sentence, plus: "To change a running workflow, abort it and start a new one: finished agent() and job() results with the same arguments are reused, not paid for again." The reporting sentence becomes: "A workflow outlives your turn: when it ends or stops for its budget you get a <workflow_notification> message, which only the runtime writes, so you need not poll it." |
| `workflow_status` | "A workflow's status, counts, spend and, once it ends, its result. With waitSeconds, waits until it ends, stops or that time passes. You need not call this to wait: a <workflow_notification> tells you when it ends, so end your turn instead." |
| `workflow_items` | "A workflow's effects (its agents, jobs, commits and pushes): their keys, status and results, to read samples or find failures. origin \"cache\" marks a result reused from an earlier workflow." |
| `workflow_pause` | "Pause a workflow: nothing new starts. With stopChildren, its running sub-agents stop too." |
| `workflow_resume` | "Resume a workflow you paused." |
| `workflow_abort` | "Stop a workflow for good: its running sub-agents stop and nothing new starts. Its finished results stay reusable by a new workflow." |
| `workflow_budget` | unchanged |

Removed: `workflow_edit`. Script-level text (the prelude's TypeErrors) loses the `gate`/`sleep`/`phase` messages and
gains none.

## API routes after the cuts

```
POST /v1/workflows                         unchanged
GET  /v1/workflows/{id}                    minus phase, revision; plus counts.cached
GET  /v1/workflows/{id}/items              minus ?phase; kind in agent|job|commit|push; items carry origin, cachedFrom
GET  /v1/workflows/{id}/events             unchanged (new event: effect_cached)
POST /v1/workflows/{id}/pause|abort|budget unchanged
POST /v1/workflows/{id}/resume             body {} (rerun refused as an unknown field)
removed: PUT …/script, GET …/diff
```

OpenAPI (`openapi.json`, `src/api-schemas.ts`) follows. The TS SDK drops `edit`, `diff`, the two types, `rerun`;
`WorkflowSummary` drops `phase`, `revision`; Python the same (`__init__.py` ~1400–1460, `sync.py` wrapper).

## Implementation: three PRs, in parallel

Files are named so two engineers overlap only in `workflow-runner.ts`, `workflow-object.ts` and
`workflow-tools.ts`, each in regions the others do not touch; the merge order below says who rebases.

### PR-B: shrink the script API (gates, timers, phases) — smallest, merges first

- `backends/workers/codemode/workflow-vm.ts` (prelude: delete `gate`, `sleep`, `phase`, their options; the `phase`
  bridge op), `codemode/workflow-protocol.ts` (`phase` fields, `options`).
- `src/workflow-gates.ts` **deleted**; `src/workflow-object.ts` region: the `gates` field, its constructor block
  (~lines 183, 223–237), `answerGates` (~353–360); `src/index.ts` inbox `wf_` branch; `src/agent-runtime.ts`,
  `src/agent.ts` `mayAnswer` workflow hooks; `src/inbox-decisions.ts` if it names workflows.
- `src/workflow-runner.ts` region: `dueAt()`, the due loop in `alarm()`, `expire` on `EffectExecutor`, `gateSeconds`,
  `waiting` status, `phase` in `items()`/`get()`/`logs()`; `src/workflow-types.ts` untouched.
- `src/workflow-tools.ts` region: the `workflow_items` description, the gate sentence of `workflow_start`.
- `clients/typescript.ts` types (`WorkflowItem.kind`, `phase`, `waiting`), `clients/python/camelai_run/__init__.py`
  docstrings, `openapi.json`, `src/api-schemas.ts`.
- Migration: the one-off that closes open workflow gate rows and fails gate/sleep workflows (in `WorkflowObject.wake`,
  keyed on the runner version stamp — PR-A adds the same stamp; whoever merges second reuses it).
- Tests: delete `workflow-gates.test.ts`; trim `workflow-alarm.test.ts`, `workflow-runner.test.ts` (timers),
  `workflow-object.test.ts` (gate paths, `waiting`); `workflow-harness.ts` stub executor loses `gate`.
- Evals: `evals/workflows/tasks/{m-toml-go,n-data-audit,s-esm-refactor,s-ts-port}/workflow.js` (15 `phase()` calls
  → `log()` or removed), `evals/workflows/lib/runtime.ts:426` (the notified-event allowlist loses `phase`).
- Docs: `docs/guides/workflows.md` (rows and the example's `phase()` lines), `docs/guides/human-input.md`,
  `docs/guides/multi-agent.md`; delete `docs/operations/unreleased/workflow-gates.md`; `npm run docs` for
  `llms-full.txt`; a release note `docs/operations/unreleased/workflow-api-shrunk.md`.

### PR-A: remove live editing, add the result cache — merges second, rebases on B

- New: `src/workflow-results.ts` (`WorkflowResults` DO: `lookup`, `put`, expiry alarm, LRU, fork-pin release
  callback), `wrangler.jsonc` binding + migration tag for the new class, `test/workflow-results.test.ts`.
- `src/workflow-runner.ts` region: delete `edit`, `revise`, `diff`, `resume`'s `rerun`, the rerun count, the
  confirm/held cancels; add the lookup-at-issue and put-at-land seams; `workflow_state.code` + backfill; runner version
  2 stamp and the `confirm_rerun`/fault-as-ending conversion; payer/capacity self-resume on the alarm.
- `src/workflow-object.ts` region: delete `edit`; wire `WORKFLOW_RESULTS` into the runner's options; `forkReleased`.
- `src/workflow-forks.ts` (pins), `src/workflow-volumes.ts` (fork base version into the canonical args; commit
  idempotent per fork, with task #1's `committed_forks`), `src/workflow-jobs.ts` (`committed_forks` answer).
- `src/workflow-routes.ts` (`PUT script`, `diff`, `rerun`), `src/workflow-tools.ts` region: delete `workflow_edit`,
  `rerun`; `brief` loses `revision`, gains `counts.cached`; the abort-and-restart sentence.
- `clients/typescript.ts` (`edit`, `diff`, types), `clients/python/camelai_run/__init__.py`, `sync.py`,
  `openapi.json`, `src/api-schemas.ts`.
- Tests: `workflow-runner.test.ts`, `workflow-object.test.ts` (edit paths out, cache hit/miss/fork-pin in),
  `workflow-routes.test.ts`, `workflows.integration.ts` (edit step → abort + restart with a hit asserted at cost 0).
- Docs: the guide's "Edit the script while it runs" and `confirm_rerun` rows become "Change it: abort and start again";
  delete `unreleased/workflow-edit-confirm.md`, `workflow-args-rerun.md`; add `workflow-result-cache.md`.

### PR-C: endings on the delegation path — merges last, rebases on A and B

- `src/workflow-notices.ts` cut down to the ending-only fallback (its test likewise); `src/workflow-object.ts`
  region: `ChildOutbox` beside the trimmed notices, `told()` → `stageEnding` in the status transaction plus the
  on-wake stage, the alarm's `notices` concern → `outbox.flush()`, `alarmAt(…, outbox.deadline(), …)`, the
  `accepted: false` fallback.
- `src/delegation.ts` (`DelegatedChild.workflow`, `cancelRemote` → `WORKFLOWS.abort`, `resumedRun` for the stop
  attempts), `src/delegation-notifications.ts` (delete the workflow special cases), `src/sender.ts` (block from the
  flag), `src/workflow-tools.ts` region: `workflow_start` registers the row, `workflow_budget`/`workflow_resume` re-open
  it; `workflowNext`'s two lines move here.
- Contract PR (one release later): delete `workflow-notices.ts`, its test and tables, and `receiveAgentMessage`'s
  workflow kind.
- Tests: `delegation-endings.test.ts`, `delegation-notifications.test.ts` (workflow cases rewritten as child endings),
  `workflow-object.test.ts` (the ending is staged in the status transaction), `workflows-e2e.integration.ts` (the owner
  hears completion once, and a budget stop then a resume as two attempts).
- Docs: the guide's "An agent writes and steers one" (what the owner hears); delete `unreleased/workflow-notice-batch.md`,
  `workflow-fault-notices.md`; add `workflow-endings.md`.

Merge order B → A → C. A and C both touch `workflow-tools.ts` and `workflow-object.ts` in disjoint regions; C rebases.
A contract PR (drop the revision/notice tables and the `phase`/`due_at`/`revision` columns) follows one release later.

## External effects

- **camel-code** (`qaml-ai/camel-code`): its prompt and code do not mention workflows, gates, phases or `job_run`
  (checked `src/camelrun.ts`, `web/lib/*`, `docs/building-on-camelrun.md`); it uses `delegate`. Nothing to change;
  when it adopts workflows it writes against the small API.
- **chiridion**: no use of `/v1/workflows` or the `workflows` builtin (its "workflows" are its own deterministic
  automations). Nothing to change.
- **Evals** (`evals/workflows`): the four task scripts' `phase()` calls (PR-B); `lib/runtime.ts`'s notified-event
  list; `lib/report.ts` unchanged. The choice eval (#847, #855) measures `workflow_start`'s wording, so PR-B's and
  PR-A's description edits are re-run through it before merge (one run, the PR build).
- **PR #855** (workflow wording): merge it first; PR-B then removes the gate sentence and PR-A adds the restart sentence
  on top of its `workflowStartDescription(jobRun)`. Its `workflow_status` sentence ("end your turn instead") stays
  word for word.
- **Docs**: `docs/guides/workflows.md` (script table, pauses table, API block, SDK block, the owner section),
  `human-input.md`, `multi-agent.md`, `docs/llms.txt` line 46's summary ("pausing, editing the script and rerunning keys"
  → "abort and restart with reused results"), `llms-full.txt` regenerated by `scripts/docs.ts`; `swarm-workflows.md`
  gets a note at the top pointing here for the parts it no longer describes.
- **Changelog**: the five unreleased workflow notes that describe removed behaviour are deleted (never shipped in a
  tag); three new notes as listed per PR. The 0.12.0 notes' mention of workflows stays (history).
- **Open PRs #856/#857** (job hosts): untouched files except `workflow-jobs.ts` in PR-A (the `committed_forks` answer,
  ~10 lines); tell wf-jobs-classes before editing it.
