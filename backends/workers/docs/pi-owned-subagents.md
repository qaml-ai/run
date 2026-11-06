# Pi-owned subagents: design note and spike

Status: a design note and a spike, measured on 2026-11-06. Nothing here changes production. The spike sits behind
`AGENT_PI_SUBAGENTS=1`, which is off by default. With it off, the Workers unit and integration suites and the
delegation contract group stay green.

## Summary

camelRun's subagents today are separate agents: `delegate`, the `agents` builtin (`spawn_agent`, `wait_agent`,
`list_agents`, `send_message`, `interrupt_agent`, `report_progress`), code mode's `delegate`, and `camelrun/spawn`. Each
child has its own id and its own node or Durable Object, and we keep our own bookkeeping for it: child rows, HTTP starts,
result delivery, sweeps and wake budgets. That is about 1,500 lines on ECS and 1,100 on Workers. Every recent bug in this
area lived in that layer: double starts (#690), a row left running after a failed lookup (#674), and an answer that never
reached its parent (sim I21).

pi-durable has its own model for this. The calling tool's task owns a child conversation. A stable request id makes a
rerun find the same child. An abort cascades from the bottom up. The parent is idle only once its children are. Background
children hang off anchor tasks, and reporter tasks deliver their answers.

**What we measured.** We ran children in one agent Durable Object, against a fake model streaming 50 tokens/s:
2,000-token answers, three tool rounds, and contexts of a few tokens or 100k.

- **Memory is not what limits this.** No object was reset, even with 100 children at 100k-token contexts. The heap a
  child needs, measured in Node, is about 0.2 MB at a short context and 1.7 MB at a 100k one.
- **What limits this is outbound connections.** One object streams **about 8 model responses at once** when nothing but
  its alarm and its first request wakes it. Above that, children wait their turn:
  - 25 children took 2.9 minutes instead of 44 s.
  - 100 children did not finish within 8 minutes (88 of 100 answered).
  - Incoming requests (a UI polling every 5 s) open more connections. With them, 100 children took 3.6 minutes.
- **The knee is 6 to 8 concurrently streaming children per agent object.** Below it, in-object children cost nothing in
  latency. Above it, latency grows linearly.

**The middle ground.** The parent's Pi task owns the child, and the conversation runs in a Durable Object of its own.
100 children finished in 52 s (child p50 44.9 s, max 48.9 s). Starting a child took 0.35 to 1.6 s at p50. A reset of the
parent mid-run changed nothing for its children: there were no duplicate starts or inputs, and every result came back
exactly once.

**Recommendation: split by kind.**

- **Delegate children, and spawned scratch children, run in the parent's object by default (pure Pi).** Their concurrency
  is capped at the object's connection budget: `maxParallel` defaults to 4 and is at most 16.
- **Remote child tasks run in their own object** for these cases:
  - overflow past that budget;
  - persistent named agents (`spawn_agent` / `camelrun/spawn` to an existing agent id, or `agent:` targets);
  - definition targets whose tools, MCP servers or computers the parent object does not have.
- **Ownership, abort, waiting and exactly-once are Pi's in both cases.** No `agent_children` table, sweep or outbox
  remains.
- **Each child gets its own computer**, forked from its parent's by a Pi fork task. The computer is keyed
  `<agent>~<owning task>` and released by a lease task's abort handler (section 3a). This works in the parent's object.
  But computer calls share its connection budget, so many computer-heavy children are another reason to run them
  remote.

The rest of this note gives the numbers, the middle-ground design, what callers depend on, billing, ECS, the spike's
contract results, the code it deletes, and a migration plan.

## 1. All children in the parent's object (pure Pi)

### Setup

The setup is a throwaway Worker `camelrun-spike-pi-subagents`, with its fake model `camelrun-spike-pi-subagents-model`.
Both ran on the pilot's account (`85bbd288051330fb51ee1c86031a299b`) with their own script names, never the pilot or
production. Both were deleted after the runs.

The code is in `spikes/pi-subagents/`:

- The object hosts one pi-durable 1.5.0 Harness on its SQLite, following the README's Durable Object host pattern
  (`onWake` with a 60 s alarm heartbeat).
- It has a replay-safe `subagent` tool, pi-durable's example 21: a child owned by the call's task and found again by
  `scanConversations({ ownerTaskId })` and a stable `requestId`.
- It uses an OpenAI-compatible model over `fetch` to the fake model Worker, which streams one SSE chunk per token.
- The parent answers `fanout n=N` with N parallel `subagent` calls. Each child makes three rounds of 50 tokens plus a
  `work` tool call, then a 2,000-token answer: 2,159 streamed deltas a child, about 43 s.
- Retries are off unless stated.
- CPU, outcomes and wall time come from `wrangler tail` per invocation. Stream latency, loop lag, concurrency and SQL
  statements are recorded inside the object. Raw summaries are in `measurements/pi-subagents.json`.

Two limits are platform facts:

- The Worker runs with the pilot's `cpu_ms: 30000`.
- workerd does not report heap size. Heap was measured by running the same harness, tools and fake model in Node 22
  (`node-bench.ts`), as the live heap after a forced GC mid-run.

### Short contexts, a driver polling the object every 5 s

| N | wall | child p50 / max | first token p50 / max | most streaming at once | stream latency p50 / p99 / max | loop lag max | CPU total, µs per delta | most CPU in one invocation | SQL statements | SQLite size | errors |
|---:|---:|---|---|---:|---|---:|---|---:|---:|---:|---:|
| 1 | 48 s | 43.3 / 43.3 s | 70 ms | 1 | 59 / 100 / 100 ms | 0 | 1.8 s, 839 | 0.4 s | 832 | 0.16 MB | 0 |
| 5 | 48 s | 43.4 / 43.4 s | 30 / 50 ms | 5 | 59 / 100 / 100 ms | 0 | 8.1 s, 755 | 1.4 s | 2,969 | 0.26 MB | 0 |
| 10 | 89 s | 44.1 / 83.4 s | 40 / 994 ms | 9 | 59 / 100 / 100 ms | 0 | 9.5 s, 439 | 1.3 s | 5,705 | 0.38 MB | 0 |
| 25 | 130 s | 87.3 / 127.4 s | 1.2 / 3.2 s | 19 | 59 / 100 / 107 ms | 16 ms | 20.7 s, 385 | 1.5 s | 13,902 | 0.77 MB | 0 |
| 50 | 177 s | 92.3 / 173.9 s | 3.2 / 5.8 s | 22 | 57 / 164 / 1,518 ms | 1.5 s | 60.2 s, 559 | 3.3 s | 27,720 | 1.45 MB | 0 |
| 100 | 219 s | 85.0 / 212.9 s | 6.3 / 11.9 s | 55 | 58 / 100 / 1,425 ms | 1.3 s | 63.5 s, 295 | 3.6 s | 53,707 | 2.76 MB | 0 |

### The same, with nothing polling: only the start request and the alarm open invocations

| N | wall | child p50 / max | most streaming at once | most CPU in one invocation | result |
|---:|---:|---|---:|---|---|
| 25 | 241 s | 89.0 / 169.1 s | 13 (8 almost throughout) | 9.4 s (start request, 807 s of wall), 8.4 s (alarm) | 25 done |
| 100 | over 480 s | 278 / 478 s | 13 (8 almost throughout) | 11.7 s (start request), 8.4 s (alarm) | 88 of 100 done when the driver stopped |
| 50, 100k context | 241 s | 99.5 / 179.6 s | 11 | 11.1 s (start request), 8.4 s (alarm) | 32 done, 18 fake-model 502s (below), no reset |

### 100k-token contexts (each child's first message holds the history), polling every 5 s

| N | wall | child p50 / max | most streaming | SQLite size | errors | resets |
|---:|---:|---|---:|---:|---|---:|
| 1 | 47 s | 43.3 s | 1 | 0.56 MB | 0 | 0 |
| 5 | 47 s | 43.7 s | 5 | 2.3 MB | 0 | 0 |
| 10 | 47 s | 44.1 / 44.3 s | 9 | 4.4 MB | 2 model errors | 0 |
| 25 | 94 s | 48.7 / 88.8 s | 17 | 10.7 MB | 8 model errors | 0 |
| 50 | 100 s | 52.5 / 93.7 s | 20 | 21.4 MB | 14 model errors | 0 |
| 100 | 141 s | 91.3 / 136.9 s | 36 | 42.4 MB | 35 model errors | 0 |

The model errors are the fake model's own `502`. 400 KB request bodies, arriving 20 to 36 at a time, overran that one
small Worker. They are not the agent object's errors: its CPU, memory and storage stayed within limits, and no invocation
was reset (`exceededMemory` and `exceededCpu` both stayed at 0). camelRun retries a model error, so the spike ran with
retries off to keep it visible.

### Heap per child: the same code in Node (live heap after a full GC, mid-run)

| N | short context | 100k context | peak heapUsed at 100k |
|---:|---:|---:|---:|
| 1 | 21.4 MB | 22.9 MB | 35.6 MB |
| 5 | 24.4 MB | 31.9 MB | 44.2 MB |
| 10 | 26.0 MB | 41.3 MB | 56.4 MB |
| 25 | 29.4 MB | 67.5 MB | 115.8 MB |
| 50 | 34.4 MB | 106.0 MB | 169.2 MB |
| 100 | 39.4 MB | 191.9 MB | 278.3 MB |

That is about 21 MB of base cost. Each concurrently streaming child adds 0.2 MB at a short context and 1.7 MB live
(about 2.6 MB at peak) at a 100k one. Node streams every child at once: there is no connection cap there.

So 128 MB would hold about 60 concurrently streaming 100k-context children by live heap, and about 40 by peak heap. On
Workers, the connection budget caps concurrent streams far below that. That is why no reset was seen.

The resident cost is not the transcript. It is each streaming request's serialized body and the partial answer. A child
that waits for a connection holds little: its committed entries live in SQLite.

### What the numbers mean

- **Connections are the knee.**
  - A Workers invocation holds at most six simultaneous outbound connections, and the platform queues the rest.
  - An agent object that nothing calls is driven by its first request and its alarm. It streamed at most 8 model
    responses at once: 6 per invocation context, as `concurrency` in the raw data shows.
  - Each incoming request (here, a stats poll every 5 s) adds connections. With polling, 100 children peaked at 55
    concurrent streams.
  - Children past the budget wait for a connection: first-token time grows to seconds, and total time grows in waves of
    about 43 s.
  - In production, what opens invocations is the parent's own SDK and browser traffic, which varies. The guaranteed
    budget is the floor of about 6 to 8.
- **CPU is not the knee.**
  - Pi's per-delta cost on Workers was 295 to 839 µs. That covers the SSE parse, the 100 ms partial commits and their
    deferred SQLite writes.
  - Background work is billed to whichever invocation is open. The heaviest single invocation used 11.7 s of CPU in about
    11 minutes, against the 30 s limit, because the connection cap also caps CPU.
  - At full parallelism (Node, 100 children) the same work is about 0.45 s of CPU per second of wall time. That would be
    27 s per 60 s alarm cycle, close to the limit. So if Cloudflare ever lifted the connection cap, the 30 s CPU limit per
    invocation would be the next knee, at about 100 streaming children.
- **Latency of the stream is Pi's batching.**
  - Pi commits partial answers every 100 ms. The p50 from a delta's arrival to a watch seeing it was 57 to 59 ms, and
    the p95 was 100 ms.
  - Tails reached 1.4 to 1.7 s only at 50 to 100 concurrent streams, where the event loop lagged up to 1.7 s.
- **SQLite**:
  - About 540 statements a child (deferred partial commits batch into them).
  - 27 KB a child at a short context, 420 KB at 100k.
  - That is negligible against the 10 GB object limit, and $0.001 per 1,000 rows written.
- **Evictions hit every child at once.** Resetting the parent object 20 s into a 10-child run interrupted all ten model
  streams. With camelRun's retries on (2 retries), Pi re-requested each interrupted response from its last checkpoint.
  All 10 tool results arrived exactly once, with no duplicate children, but the run took 80.6 s instead of 44 s. The
  streamed partials were regenerated and paid for again. A remote child loses nothing when its parent restarts
  (section 2).

## 2. The middle ground: Pi owns the child, the conversation runs in its own object

### Design

- **Ownership.** The delegate tool (`replay: "safe"`) creates a `RemoteChild` task with
  `ownership: { kind: "task", taskId: api.taskId }`, memoizes its id (`api.memo`), and waits with `api.waitForTask`. The
  call owns the task, so Pi's rules apply unchanged:
  - aborting the call, or the parent's run, aborts the task first, bottom-up;
  - the parent is idle only once the task is terminal;
  - `waiting` with `allSettled` or `failFast` works across several of them.
- **The child object** is named deterministically: `<parent agent>-t<task id>`, or an existing agent's own object for a
  persistent target. It runs the conversation as its root:
  - `childStart(requestId, task)` submits with the stable `requestId` (`subagent:<task id>`), so a repeated start finds
    the same submission;
  - `childWait(requestId, timeoutMs)` long-polls the answer;
  - `childAbort(requestId)` aborts it.
- **RemoteChild's phases:**
  - `start` RPCs `childStart`, then commits `{ phase: "wait" }`.
  - `wait` long-polls up to 20 s. On an answer it commits the terminal outcome. Otherwise it commits a new checkpoint
    (`polls + 1`; Pi faults a phase that returns without durable progress) and runs again.
  - The task's `abort` handler RPCs `childAbort`. Pi runs abort handlers durably, so an abort that lands while the
    parent is evicted still reaches the child when the parent wakes.
- **Exactly once across objects:**
  - The parent side is exactly once because Pi commits the task's terminal outcome once, and the tool's result once.
  - The child side is exactly once because the child's Pi dedupes the submission by request id.
  - A crash between `childStart` and the `wait` commit reruns `start`, which finds the existing submission.
  - A crash during `wait` reruns the poll. Nothing is started twice, and nothing is delivered twice.
- **Getting the answer back:**
  - The spike polls, which also covers parent eviction: the alarm heartbeat resumes the `wait` phase.
  - A production version adds a callback: the child calls the parent's `childDone(taskId)` when its submission settles.
  - Pi has no "wake this task now" API. The callback can resolve the in-memory long-poll when the parent is resident, and
    otherwise just opens an invocation, whose alarm resumes the phase.
  - That keeps a poll interval only as a fallback. It does not cost an RPC every 20 s per running child in the steady
    state.
- **Background children** use the same task under a background anchor, and a reporter task posts the answer as the
  parent's follow-up input (example 22). It is the same as in-object children; only the conversation's location differs.

### Measured (deployed, same fake model, short contexts)

| N | parent wall | child p50 / max | start overhead p50 / max | duplicated starts or inputs |
|---:|---:|---|---|---:|
| 1 | 48 s | 43.6 s | 351 ms | 0 |
| 10 | 47 s | 43.9 / 44.1 s | 521 / 689 ms | 0 |
| 25 | 47 s | 44.0 / 44.5 s | 646 / 1,126 ms | 0 |
| 100 | 52 s | 44.9 / 48.9 s | 1,576 / 2,783 ms | 0 |

The raw data also keeps a first remote round, which faulted. That was a spike bug: the `wait` phase re-committed an
unchanged checkpoint, which Pi faults by design. The table above is the rerun with the fix.

The start overhead covers creating the child object, opening its Harness and committing the submission. It grows with N
because the parent opens the starts through its own connection budget. 100 of them queue behind 6 to 8 RPCs at a time,
which still costs only about 1.6 s.

**Parent reset 20 s into a 10-child run:**

- The children kept streaming in their own objects.
- After the reset, the parent's `wait` phases resumed and took every answer: 10 objects, 10 starts, 10 inputs, 0
  duplicates, 10 tool results, 0 errors.
- Ten long-poll RPCs showed as `canceled`, which is the reset itself.

### What it removes, compared with pure Pi

Both remove the `agent_children` rows, sweeps, wake-claim landing, the notification outbox for children and the HMAC
chain signature:

- Pi's task tree carries depth and chain.
- Pi's task outcome is the delivery.
- Pi's ownership is the cancellation cascade.

The middle ground keeps a small RPC surface: start, wait, abort and an optional done callback, about 100 lines per
backend. It also keeps the `RemoteChild` task, about 60 lines. Section 7 has the line counts.

## 3. What callers rely on today

There are two kinds of children:

- **Persistent named agents** are real agents before and after a spawn: `{ agent: "<key>" }` delegate targets,
  `spawnAgent({ agent: <id> })` and `camelrun/spawn` workers.
- **Scratch children** are the ones the runtime makes from instructions or a definition. Only scratch children would
  lose an agent of their own in a pure-Pi design.

Lines are at origin/main. They are the merge base for camelRun (`0fc73242`), camel-bots `504d1489` and chiridion
`acebceb6d`.

### chiridion: no dependency

- Runtime threads use only `web_fetch`, `web_search` and `ask_user`:
  - `scripts/lib/eval-runtime.mjs:56`
  - `scripts/selfhost-agent-runtime.mjs:126`
  - `plans/agent-runtime-migration.md:156,325`: "Subagents: dropped for launch"
- Browser tokens carry no `children` scope (`workers/main/src/agent-runtime/thread-runtime.ts:579-584`).
- `watchAgent` runs without `subagents` (`src/lib/use-runtime-thread.ts:301`).
- Usage is keyed by thread, not agent id (`workers/main/src/agent-runtime/usage.ts:84-96`).

### camel-bots: persistent workers only, plus claims

- The builder's workers are persistent named agents, and they stay agents:
  - `src/api/builder.ts:2163`: `spawnAgent({ agent: worker })`.
  - `src/api/bot-workers.ts:167-173`: worker upsert, with key `bot-worker-<bot>`.
  - `src/api/bot-workers.ts:192-198,216,225,230`: GET, abort and DELETE by id.
- These parts need to keep working for spawned persistent workers:
  - `src/app/builder-dm.ts:1496,1515-1517,1612-1625,1640`: `subagent_start` carrying `agentId` = worker id and
    `requestId` = its run, and the `child_<request>` notification run on the builder.
  - `web/src/api/builder-chat.ts:46`, `web/src/lib/workers.ts:16`, `web/src/lib/chat-rows.ts:185`: `agentNotice().agentId`
    = worker id.
  - `src/api/builder.ts:633-634` with `web/src/pages/discord/chat/chat-log.tsx:180-200,227`: the `children` browser-token
    scope reading the worker by id.
  - `src/api/builder.ts:325-331`: `abort children: "keep"`.
  - `src/api/builder.ts:1994`: worker tools require the `par`/`root` identity claims.
  - `src/ops/triage.ts:468,547`: triage refuses sub-agents by those claims. This is a security check: a child running
    inside its parent must still carry distinct `par`/`root` claims to tool servers.
- Cost readers only sum `usage.subagentCostUsd`; keep the field:
  - `src/app/agents.ts:746`
  - `src/app/ai.ts:616`
  - `src/app/turns.ts:90`
  - `src/ops/spend.ts:231-234`
  - and others

### camelRun console

These break for scratch children: there are no rows or pages unless child conversations are listed under their parent.

- `console/web/pages/agents.tsx:28-38,47,174`: the nested agent tree by `parentAgentId`, and `subAgents=only`.
- `console/web/pages/agent.tsx:357`: "sub-agent of".
- `console/web/pages/ops/usage-tab.tsx:30,36,208` with `src/admin-usage.ts:24,180`: admin top-agents rows per child.

### SDKs

- These need a synthetic id that resolves to the child conversation:
  - `subagent_*` stream parts carry `agentId`: `clients/types.ts:117-126`, `clients/agents.ts:80,260-264,597-600`.
  - `clients/watch.ts:45-63,333-347` keys `state.subagents` by tool call id, so it is mostly unaffected; its `agentId`
    field needs the same synthetic value.
  - `clients/typescript.ts:238` (`agentNotice().agentId`).
  - `clients/typescript.ts:869`: `toolCalls[].agentId`, with the documented `agents.get(call.agentId).history()`.
  - `clients/typescript.ts:1755-1762`: the `children` token scope.
  - `clients/typescript.ts:39-42,56`: `parentAgentId`/`rootAgentId` from the `par`/`root` claims.
- The Python SDK mirrors all of these:
  - `clients/python/camelai_run/__init__.py:157-158,189,299-309,954-955,1675-1679,2722-2725,3400-3406`
- React, registry and Studio render by call and name, so they are unaffected.

### Docs and OpenAPI

- `docs/guides/multi-agent.md:5-8,65,80-99,145-163,257-260,280-281,385-390,426-429,476-480` states that "a sub-agent is
  an agent of its own", and covers its history, mounts, computer, a one-day TTL, deletion and the `children` scope.
- `openapi.json`: `parentAgentId` (3612), `parentRunId` (4738), the `children` scope (5487), abort `children` (5550),
  `subagentCostUsd` (10517), the `subAgents` filter (15318), `?subagents` (15781), and computer `subagents` inheritance
  (21047-21205).

### Contract cases that need a child agent id

These fail for scratch children unless an adapter serves them:

- `multi-agent.contract.test.ts:48-56,106,136-160,177,195-203,218-232`
- `background-agents.contract.test.ts:54,65,135`
- `agent-messaging.contract.test.ts:61,88-187`: a child's `ask_user` answered at `/v1/agents/{child}/inputs/{id}`.
- `agent-progress.contract.test.ts:194,218,247`
- `codemode-delegation.contract.test.ts:15-21`
- `agents-list.contract.test.ts:78-88`
- `platform.test.ts:54-78`: a child's own computer.
- `identity-tokens.transport.contract.test.ts:120-143`

### Conclusions

- Nothing outside camelRun needs a scratch child to be an agent.
- camel-bots needs persistent workers to stay agents. They stay agents under the recommendation: remote child tasks into
  their own object.
- Every scratch-child dependency is camelRun's own surface: API reads by child id, the console tree, SDK fields, docs and
  tests. Two options cover it:
  - **A thin adapter.** A synthetic id `<parent>-c<conversation>` resolves to the parent's child conversation, for
    history, events and inputs. It is listed under `GET /v1/agents/{parent}/children`.
  - **A documented API change.** Children are not agents; their transcripts are under the parent.
- In either case the identity claims must keep `par`/`root` for child tool calls.

## 3a. A computer for each child

### Today

There are two kinds of computer, and both are keyed by agent id:

- **Native.** The `computer` tool (`src/computers/tool.ts:46-61`) calls
  `COMPUTER_CONTAINERS/COMPUTER_SANDBOXES.getByName(agentId)`. The container or sandbox is a Durable Object of its own,
  named by the agent id. It has named snapshots: a whole-filesystem snapshot for a container, a directory backup to R2 for
  a sandbox.
- **Attached provider computers** use rows in `computer_connections (tenant, agent)` with leases and daily seconds. A
  child agent gets a copy of its parent's connection (`inheritComputer`, `src/computers/service.ts:171-179`). The cron
  sweep (`sweepComputers`, `:182-193`) closes leases whose agent is gone, by joining `agents`.

A Pi child conversation has no agent id, so in the spike it has no computer: `computer` is not in a child's tool set.
camelCode needs each subagent to have its own computer, forked from its parent's: snapshot the parent, then start the
child from that snapshot.

### Design

- **Identity.**
  - The child's computer key is `<parent agent id>~<owning task id>`. A delegate child is owned by its call's task, and a
    background child by its anchor.
  - The task id is stable across replays and unique per child. The conversation id would do as well; the task id also
    names the snapshot.
  - The key is stored in the child's `camel.subagent` document.
  - The `computer` tool resolves its key per call: from `api.conversationId`, the child's key when the conversation is a
    child, and the agent id otherwise. That is about 10 lines: a resolver instead of the fixed `agentId` argument.
- **Fork, as a Pi task.**
  - `camel.computer-fork` is owned by the call that creates the child, and created in the same commit as the child
    conversation.
  - Phase `snapshot`: an RPC to the parent's computer object takes snapshot `fork-<task id>`. That is idempotent by name,
    so a rerun after a crash finds it.
  - Phase `start`: an RPC to the child's computer object (`getByName(childKey)`) restores from the parent's snapshot.
    That is idempotent too: the object records which snapshot it was started from.
  - Its terminal outcome records the key.
  - The delegate tool or the reporter submits the child's first input only after the fork task is done (`waiting` on it,
    or `api.waitForTask`).
  - A parent with no computer forks nothing. The child starts without one, or with a fresh one if its definition asks
    for one.
- **Release, as a Pi task's abort handler.**
  - `camel.computer-lease` is owned by the child's owner task. It sleeps until its deadline (the parent's lease seconds).
    Its `abort` handler stops the child's computer and deletes the fork snapshot.
  - Pi runs abort handlers durably: a crash mid-release reruns the handler. Ownership makes it run bottom-up before its
    owner ends:
    - **Delegate child:** the call aborts its lease task just before it returns its result (`api` aborts its own child
      task), and Pi aborts it anyway if the call fails or is aborted.
    - **Background child:** the lease hangs off the anchor. Unlike example 22's anchor, this anchor sleeps until the
      child's lifetime ends, which today is the one-day `childTtlSeconds`. Stopping the child (`interrupt_agent`, the
      parent's `abort` with children) or the deadline aborts the anchor, and with it the lease.
  - Deleting the parent agent deletes its children's conversations. It must also release their computers: the agent
    purge walks `camel.subagents` and stops each child key. That is the only release that is not a Pi task outcome,
    because the Harness is going away.
- **Attached provider computers.** `inheritComputer` writes the child's row with the child's key instead of a child
  agent id. The sweep's join on `agents` would read an unknown key as a deleted agent and close the lease. It needs a
  `parent` column, or the key's `<agent>~` prefix, so it checks the parent agent's state instead. Leases and daily
  seconds stay per row, so per-child limits and billing work as today. Managed computers bill credits per row, with the
  parent's tenant and bucket.

### In the parent's object, or the middle ground?

It works in the parent's object. Every computer operation is already an RPC to the computer's own Durable Object (or to
a provider), keyed by name. Nothing about a computer needs the child to live in a different agent object.

It does lean on the knee in section 1, though:

- Each computer call from an in-object child is one more outbound connection from the parent's object, competing with
  the children's model streams for the same 6 to 8. A long `exec` holds one for its whole duration.
- Snapshot and restore take seconds: a container's whole filesystem, or a sandbox's R2 backup. They delay the child's
  first turn by that much in either design.

So the rule from the recommendation tightens. Children with computers count against the in-object budget at the rate of
their open computer calls, and a parent whose children all work on computers at once should run them as remote child
tasks. A child whose computer outlives a run (a persistent named worker) is already remote: its computer stays keyed by
its own agent id, as today. The fork and lease tasks are the same in both designs. In the middle ground they are owned by
the `RemoteChild` task in the parent, and the child object only uses the key it is given.

## 4. Billing and limits

- **Per-child spend.** Pi keeps `pi.usage` per conversation: tokens and cost per `provider/model`, failed attempts
  included.
  - The spike reads it per child and rolls it up into the parent run's `subagentCostUsd`, through the children's own
    children.
  - A delegate child's cost counts in the run that called it. A background child's cost counts in the run that took its
    answer: the `wait_agent` run, or the `child_<request>` notification run. This mirrors today's charge-on-landing.
  - The contract case "a child's spend is charged to its parent when its notification lands, and a parent at its spend
    limit gets no turn" passes with the flag on.
  - A remote child reports its own `pi.usage` with its answer.
- **Money.** In-object children's model calls go through the parent's metered provider (`meterProvider`). Every call is
  charged to the tenant and to the agent's spend as it happens, on the parent's current run.
  - So there is no per-child spend line in Postgres. The child's cost is visible only as the parent's
    `subagentCostUsd` and in `pi.usage`.
  - A remote child keeps its own line, as today.
  - End-user credits are charged per call with the run's bucket, so they are unchanged.
  - Credit holds: the metering hold is per model call, so in-object children need no per-child hold.
- **Budget shares.**
  - Today `holdBudget` splits a run's remaining spend limit across the children of one response, and passes each share as
    the child's own `spendLimit`.
  - In-object children's calls already count against the parent run's limit (`limits.check()` runs before each child
    request). So the run as a whole stops at its limit with no shares at all.
  - The per-child share matters only to stop one runaway child from starving its siblings. Keep it as a check before
    each child request, against that child's `pi.usage`.
- **maxParallel.**
  - The spike admits a child in the same Pi commit that creates it: count the running rows, then create or wait.
  - A delegate past the limit waits its turn. A `spawn_agent` past it is refused, as today.
  - **Size the default to the object's connection budget.** Keep 4 by default and cap in-object concurrency at about 6.
    Anything above goes remote.
- **maxDepth** comes from the child's own document (depth, max depth), set when the child is created. There is no prompt
  metadata or HMAC.
- **Wake cap.** Notifications still count against the chain root's hourly wake cap. The two wake-cap cases pass with the
  flag on.

## 5. ECS

The same design applies to ECS's Pi harness (`src/pi-durable/agent.ts:438`, one Harness per agent, on Postgres). The
differences:

- **No connection cap.** A Node process streams every child at once. Node measured 100 children in 44 s with 39 MB of
  live heap at a short context, and 192 MB at 100k. The knee on ECS is node memory and the agent slot count
  (`AGENT_MAX_AGENTS`, 8 per node), not connections.
  - Today a child is its own hosted agent, so it takes a slot, and it can land on another node when the parent's node is
    full (`handBack`, drain, retire, lease takeover).
  - An in-harness child shares its parent's process and slot. That gives more density, but a parent with many
    large-context children concentrates memory and CPU on one node, and memory retirement of the parent takes its
    children with it.
  - Use the same split: in-harness up to a per-parent budget (count and an estimated context size), and remote child
    tasks to a child agent otherwise. The remote path reuses `submitAnywhere`/`requestAnywhere`, which stay because
    schedules and channels use them.
- **Storage is Postgres.** Pi's deferred partial commits are batched about once a second per streaming conversation. At
  100 streaming children that is about 100 storage commits a second per parent, against today's same commits spread over
  100 agents. This is the same load, concentrated on one lease holder's connection.
- **What goes:**
  - `agent_children` and its five migrations (75 lines; a drop migration);
  - `sweepChildren` and `AGENT_CHILD_SWEEP_MS`;
  - the `agent_wakes` landing;
  - `childOutcome` cross-node polling;
  - the HMAC chain signature;
  - `stopDelegates`/`abortBackground`.

## 6. The spike behind `AGENT_PI_SUBAGENTS`

### What it is

- **Module.** `src/pi-subagents.ts` (about 450 lines) implements every delegation tool on Pi child conversations:
  `delegate`, `spawn_agent`, `wait_agent`, `list_agents`, `send_message`, `interrupt_agent` and `report_progress`. It is
  installed in place of `delegation.ts`'s tools when the flag is on.
- **Ownership.** A delegate child is owned by its call's task. A background child is owned by an anchor task created in
  the same commit. A reporter task delivers each message and lands its answer, through the existing notification outbox,
  so a notification is still a `child_<request>` run with its wake cap.
- **Bookkeeping.** All of it lives in two Pi documents: `camel.subagents` on the root, with the rows, landing and progress,
  and `camel.subagent` per child, with the name, depth, settings and output schema. A replayed call finds its row by the
  call's task id.
- **Model hooks** receive the conversation's provider session id. A child's stream is relayed as `subagent_event`, never
  projected into the parent's run, and a child's request skips the root's context-range check.
- **Prompt and tools.** A child renders its own system prompt section. It gets the parent's file tools, code mode, the
  builtins its configuration names, and the delegation tools of its own builtins.
- **Aborting the parent** needs no code for delegate children: Pi's ownership aborts them. Background children are
  aborted through their conversations.

### Delegation contract group with the flag on

These are the Workers results, on one Sprite (`--local --backend=both`, Node baseline 38 of 38). With the flag off, both
backends pass 38 of 38.

**11 of 38 pass with the flag on**, at commit `317f26f4`. The 27 failures fall into three groups.

**Pass (11):**

- spawn_agent's notification arrives once, with its source and marker;
- wait_agent takes an ending, so no notification follows, and list_agents lists the child;
- the wake cap (`agent_loop_limit`) for notification loops;
- a child's spend is charged when its notification lands, and a parent at its limit gets no turn;
- children started together share the parent's limit, and limits alone bound tool spawns;
- delegate calls run at once, at most `maxParallel` together, and one answers in its output schema;
- a child's message joins its parent's running turn;
- inline children share the parent's files;
- scripts waiting on children hold no code slot;
- an unauthenticated spawn directive is refused;
- workflow input is refused.

**Expected API differences: the child is not an agent of its own (15).** Each of these reads the child through
`GET /v1/agents/{child}`, lists it by `parentAgentId`, deletes it by id, uses the `children` browser-token scope, or
lands it with the sweep fixture:

- delegate from a definition links the child to its parent;
- the depth limit and spend limit, read through the grandchild's run;
- parallel children share the run's limit;
- children run one after another share the run's limit;
- prompt metadata cannot move a run in the chain;
- aborting the parent: the stream shows its children;
- aborting the parent charges the child and deleting it deletes the child;
- the sweep lands an unread ending;
- spawn_agent's limits, through the nested child's run;
- the `children` browser scope;
- a parent messages its finished child, read through the child's own runs;
- code mode's three delegates, by `parentAgentId`;
- instructions as the first message, read through the child's run;
- `camelrun/spawn` of a persistent worker: the spike leaves existing-agent targets to `delegation.ts`;
- the SDK watcher's sub-agent transcript: the watcher follows the child by id.

These pass only with the adapter in section 3, or with the persistent-target path (remote child tasks), or they change
as a reviewed difference.

**Spike gaps, not API differences (12):**

- `send_message` does not end a parent's `wait_agent` early (2 cases).
- `untilProgress` waits are not implemented (1).
- `report_progress` is not relayed as the delegate call's progress and as `subagent_progress` to watchers (2).
- A report over 500 characters is not refused by the schema the way the case expects (1).
- `interrupt_agent` and a messaged worker's second turn are not followed through the reporter (3).
- A script that returns without awaiting its delegate does not stop the child. Pi aborts the nested call, but the case
  waits for both children's run records (1).
- A child waiting on a person cannot be answered: inputs are answered by agent id (1).
- "Aborting a parent while a notification waits" passed on the previous run and timed out on this one (1). This is a
  timing dependence of the spike's reporter, which sleeps in 250 ms steps until the parent's turn ends.

None of the gaps needs anything Pi lacks. Each is a missing piece of `pi-subagents.ts`, or of the adapter.

**With the flag off:** the delegation group passes 38 of 38 on both backends, and the Workers suites pass: typecheck,
and the unit and integration suites (652 passed, 0 failed), on four Sprites at the same commit.

## 7. Code deleted

| | ECS | Workers |
|---|---:|---:|
| Subagent-only source deleted | ~1,137 (`children.ts` 799, most of `delegation.ts` 398) | ~974 (`delegation.ts` 589, `agent-delegation.ts` ~200, `delegation-notifications.ts` 134, small files 37) |
| Mixed-file lines deleted | ~250 | ~130 |
| SQL | 75 (+ a drop migration) | — |
| Kept as policy | ~450 (`multi-agent.ts`, schemas, sender markers, `holdBudget`, target and placement checks) | ~366 (`multi-agent-policy.ts` generated, `delegation-policy.ts`, `child-config.ts`) |
| New code, pure Pi | ~450 (the spike's module, ported) | ~450 (`pi-subagents.ts`) |
| New code, remote child tasks | +~160 | +~160 (RPC surface and the task) |
| **Net, split design** | **about −850** | **about −500** |
| Tests | ~1,660 lines; the behaviour tests become contract tests, and the cluster, I21 and sweep tests go | ~494 lines go |

The larger win is the bug class. Child lifecycle, delivery and cancellation become Pi task state, committed with the
parent's other state in one storage. There is no second store to reconcile. #690, #674 and I21 cannot happen in that
form: the starts replay by request id, there is no external row to leave running, and delivery is a task outcome.

## 8. Recommendation and migration plan

**Recommendation: split by kind and size.**

- **In-object (pure Pi)** for delegate children and scratch background children, up to about 6 concurrently streaming
  per agent object on Workers, or a per-parent budget on ECS.
- **Remote child task** for:
  - overflow beyond that;
  - persistent named agents and `camelrun/spawn`;
  - definition targets that need tools, MCP servers or a computer the parent does not have.
- **The same Pi ownership in both.** Abort, idle, waiting and exactly-once come from Pi, never from our own rows.

**Migration plan:**

1. **Identity and API first.** Decide between the adapter (a synthetic child id resolving to the child conversation:
   history, events, inputs, a children listing) and a documented change. Keep `par`/`root` claims for child tool calls,
   which camel-bots' triage relies on. Keep `subagentCostUsd`, `subagent_*` events and `child_<request>` notifications.
2. **Workers, behind this flag.**
   - Finish the gaps in section 6: messages ending `wait_agent`, `untilProgress`, the identity claims, and human input
     for children through the parent's inputs.
   - Add remote child tasks for persistent targets and overflow.
   - Give each child its own computer, forked from its parent's, with the fork and lease tasks of section 3a. The
     `computer` tool gets a per-call key resolver, and the computer sweep learns child keys.
   - Run the delegation group green with the flag on, accepting reviewed differences.
3. **ECS.** Port the module to `src/` (shared policy stays generated). Use the same flag, and keep the remote path on
   `submitAnywhere`.
4. **Cutover.**
   - New runs use Pi children. Existing child rows drain under the old code: sweeps stay until no `agent_children` row is
     running, then go.
   - No live child moves.
5. **Delete.**
   - Workers: `delegation.ts`, `agent-delegation.ts`'s child half, `delegation-notifications.ts`.
   - ECS: `children.ts`, most of `delegation.ts`, and the `agent_children` migrations' table (a drop migration).
   - The sim's I21 checker, and the cluster and sweep tests.

Each step is reversible by the flag until the deletion step.

## Reproduce

From `backends/workers`:

```sh
# Node heap (no deployment)
zsh spikes/pi-subagents/node-sweep.sh 0          # or 100000
# Deployed (a throwaway Worker of its own; delete it afterwards)
node_modules/.bin/wrangler deploy -c spikes/pi-subagents/wrangler.model.jsonc
node_modules/.bin/wrangler deploy -c spikes/pi-subagents/wrangler.jsonc --var MODEL_URL:https://<model>.workers.dev/v1
node_modules/.bin/wrangler secret put SPIKE_TOKEN -c spikes/pi-subagents/wrangler.jsonc
SPIKE_URL=https://<spike>.workers.dev SPIKE_TOKEN_FILE=<file> zsh spikes/pi-subagents/sweep.sh out.jsonl
python3 spikes/pi-subagents/analyze.py out.jsonl tail.jsonl     # with `wrangler tail --format json` captured
node_modules/.bin/wrangler delete -c spikes/pi-subagents/wrangler.jsonc
node_modules/.bin/wrangler delete -c spikes/pi-subagents/wrangler.model.jsonc
# Contract group with the flag on (repository root, on a Sprite)
scripts/sprite-test HEAD env AGENT_PI_SUBAGENTS=1 bash tests/contract/sprite-shard.sh --backend=both --group=delegation
```
