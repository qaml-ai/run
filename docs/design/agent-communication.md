# Agent communication: camelRun against Claude Code and Codex

Status: design note, 2026-11-06. It covers how agents talk to each other and to
their clients. It does not cover who owns a sub-agent: that is the Pi-owned
sub-agents spike (qaml-ai/run#696), which is on hold. Where #696 would change
something here, this note says so.

The question: Claude Code and the Codex app-server both run a lead agent that
starts workers, steers them and gets their results back. What do they do that
camelRun does not, and which of those things would help camelRun's users,
camelCode first?

The short answer is that camelRun's model-facing tools already match Codex's
collaboration tools almost one for one, and in places go further: durable
exactly-once notifications, a signed parent chain, spend sharing, a wake cap.
The gaps are at the edges:

- **Clients can't see the tree.** There is no way to list an agent's children
  or ask "is anything in this tree still working?".
- **A message can't cut in.** A message to a busy worker waits until its
  running tool call ends.
- **Workers and Node differ** in two places.

## 1. Claude Code and the Claude Agent SDK

Sources:

- The docs at code.claude.com: sub-agents, agent teams, hooks, headless, and the
  Agent SDK reference.
- `@anthropic-ai/claude-agent-sdk` 0.3.x: `sdk.d.ts` and `sdk-tools.d.ts`.
- `claude-agent-sdk-python`: `types.py`.
- The Claude Code CHANGELOG.

### 1.1 Sub-agents

The `Agent` tool takes `{description, prompt, subagent_type, model?,
run_in_background?, isolation?: "worktree" | "remote", name?}`.

**Background by default.** The tool returns at once with
`{status: "async_launched", agentId, outputFile}`. A foreground call returns
`{status: "completed", content, totalToolUseCount, totalDurationMs,
totalTokens, usage, worktreePath?}`.

**Only the final message comes back.** "Intermediate tool calls and results stay
inside the subagent." Recent builds add an explicit hand-back tool
(`SubagentHandback({message})`): only that report reaches the caller, and the
call ends the run. It "is not a messaging channel": it isn't meant for progress
or questions. The report is scanned before the parent reads it. Harness tags in
it are neutralized and a `[harness: …]` marker is prepended, so a child can't
forge a notification.

**Fresh context.** A sub-agent sees only its prompt. The exception is
`subagent_type: "fork"`, which inherits the whole conversation and the prompt
cache. A fork can't fork again.

**Bounds** are environment caps:

- spawn depth (default 3)
- concurrent sub-agents (default 20)
- `maxBudgetUsd`

At the depth limit the `Agent` tool is withheld.

### 1.2 Talking to a running child

`SendMessage({to, message, summary})`:

- **Addressing.** `to` is a name, an agent id, or `"main"` (the parent).
  Names stay addressable after the agent ends. A message to an ended agent
  resumes it from its transcript, in the background, and its new report goes to
  whoever resumed it.
- **Delivery.** Messages "enqueue and drain at the receiver's next tool round": a
  running tool is never interrupted. An idle receiver starts a turn.
- **Recent change (CHANGELOG 2.1.317).** A message to a busy background agent
  now "arrives earlier: its running command moves to the background, without
  being stopped". The message cuts in, and the work in flight survives.
- **The SDK's input priority.** `SDKUserMessage.priority` gives the same three
  levels:
  - `next` (default): read after the running tool calls.
  - `later`: held until the turn ends.
  - `now`: running work is backgrounded, or the turn interrupted.

  `interrupt()` returns a receipt listing what is still queued.

`TaskStop({task_id})` stops a task. `ListAgents` lists agents, teammates and
sessions.

### 1.3 Waking the parent

**Ending.** A background agent's ending is injected into the parent as a user
turn marked as an automated event, never as the person. It is delivered between
turns or mid-turn, and carries:

- status: `completed`, `failed` or `stopped`
- a summary
- the output file
- usage: tokens, tool uses, duration

In the SDK this is `system/task_notification` `{task_id, status, summary,
output_file, usage}`, with `origin: {kind: "task-notification"}` on the
injected message. The docs tell consumers to trust the origin, not the text.

**Lifecycle events.** The SDK stream also has:

- `task_started {task_id, description, subagent_type, spawn_depth,
  parent_task_id}`
- `task_progress {usage, last_tool_name, summary}`
- `task_updated {patch: {status}}`
- `background_tasks_changed {tasks[]}`: a **level** signal with replace
  semantics, "unlike the task_started/task_notification edge bookends". A
  client that missed an edge still converges on the right set of running
  tasks.

Every frame of a sub-agent's activity carries `parent_tool_use_id` (and
`agent_id`), so one stream shows the tree.

**Headless runs.** In `-p` mode Claude stays open until background agents finish.
The result's `queued_turn_count` tells a consumer that more turns follow.

**Other wake sources.** A `Monitor` tool turns each stdout line of a watched
process into a notification, and a background shell's exit re-invokes the
model. Hooks can keep a worker working: `SubagentStop` with `decision: "block"`,
`TeammateIdle` and `TaskCompleted` with exit 2.

### 1.4 Agent teams (experimental)

Teams add:

- a lead and teammates that are full sessions
- a file mailbox per agent
- a shared task list with dependencies and claim locks
- protocol messages: `shutdown_request/response` and
  `plan_approval_request/response`

Teammates message each other directly, not only the lead. Peer messages
"never carry user authority".

## 2. Codex app-server

Sources: openai/codex at `e6bf88ae`: `codex-rs/app-server-protocol` (v2),
`app-server`, `core/src/agent`, `core/src/tools/handlers/multi_agents*`, and
the app-server docs.

### 2.1 Protocol

JSON-RPC over stdio, WebSocket or a unix socket.

**Thread.** `{id, sessionId, parentThreadId?, forkedFromId?, source, status,
agentNickname?, agentRole?}`. `status` is one of:

- `notLoaded`
- `idle`
- `systemError`
- `active {activeFlags: [waitingOnApproval | waitingOnUserInput]}`

**Turn.** `{id, rootTurnId, items, status: inProgress | completed | interrupted
| failed, error?}`.

**Item.** A tagged union with a stable `id`. The variants include
`userMessage`, `agentMessage`, `reasoning`, `commandExecution`, `fileChange`,
`mcpToolCall`, `dynamicToolCall`, `collabAgentToolCall`, `subAgentActivity`,
`webSearch` and `contextCompaction`.

**Methods:**

- `thread/start`, `thread/resume`, `thread/fork {lastTurnId?}`,
  `thread/list {parentThreadId?, ancestorThreadId?}`, `thread/read`
- `turn/start`: steers into the active turn if there is one.
- `turn/steer {expectedTurnId}`: a precondition. A turn that isn't the
  expected one refuses, as do review and compact turns.
- `turn/interrupt {turnId}`: the turn completes `interrupted`.

**Notifications:**

- `thread/started`, `thread/status/changed`
- `turn/started`, `turn/completed`
- `item/started`, then deltas keyed by `itemId`, then `item/completed`. The
  completed item is authoritative.
- `thread/tokenUsage/updated`
- `error {willRetry}`

**Server-to-client requests.** These cover command and file-change approvals
(`accept`, `acceptForSession`, `decline`, or `cancel`, which interrupts the
turn), `requestUserInput`, MCP elicitations and dynamic tool calls. A request
that stops mattering is cleared with `serverRequest/resolved`. Pending requests
are replayed when a client reconnects.

**Recovery.** There is no transport-level resume. A client re-reads with
`thread/resume`, then turns and items paged by id. Because live items and
history have the same shape, one renderer serves both.

### 2.2 Multi-agent

There are two tool versions.

**V1** (default on, deprecated):

- `spawn_agent {message, agent_type, fork_context}`
- `send_input {target, message, interrupt}`: `interrupt: true` redirects the
  agent now; otherwise the input queues, as a steer.
- `wait_agent {targets, timeout_ms}`: statuses only; minimum 10 s, maximum
  1 h.
- `resume_agent`
- `close_agent`: closes descendants too.

When a child reaches a final status, a notification fragment is injected into
the parent, and that doesn't start a turn.

**V2** (stable, opt-in):

- **Path addressing.** Agents are named by hierarchical task paths
  (`/root/task1/task_3`).
- **`spawn_agent {task_name, message, fork_turns: "all" | "none"}`.** Forking
  the conversation is a parameter here, not a separate agent type.
- **Two kinds of message.** `send_message` queues mail and does not start a
  turn. `followup_task` starts one if the target is idle, and otherwise is
  delivered at the next boundary.
- **`wait_agent`** returns only "Wait completed / interrupted / timed out". The
  mail itself lands in context as a message with a fixed envelope:
  `Message Type: FINAL_ANSWER / Task name / Sender / Payload`.
- **`interrupt_agent`, `list_agents {path_prefix}`.**

Common to both versions:

- **Each child is its own thread.** It has
  `source: subAgent{parent_thread_id, depth, agent_path, agent_role}`, is
  listed with `thread/list {parentThreadId}`, and its turn and item events
  reach every connected client, so the client renders children with the same
  code as the lead.
- **Mirrored items.** The lead's own stream carries `collabAgentToolCall` items
  with `{tool, senderThreadId, receiverThreadIds, agentsStates: {threadId:
  {status, message}}}`, and `subAgentActivity {kind: started | interacted |
  interrupted | completed}`.
- **Defaults.** V1 has depth 1 and 6 threads; V2 has 4 concurrent threads.
  Children inherit sandbox and approval policy, and V2 children refuse direct
  client input.
- **Delivery** goes through durable per-thread mailboxes. A message counts as
  consumed once it is in history. Codex itself calls result delivery "best
  effort" and measures it with a metric.

## 3. Others, briefly

- **OpenAI Agents SDK.** It has handoffs (the conversation moves to another
  agent) and `agent.as_tool()`. camelRun has `as_tool` (`delegate`) and no
  handoffs, by choice (see the multi-agent guide).
- **A2A protocol.** Tasks with states (`submitted`, `working`,
  `input-required`, `completed`, `failed`, `canceled`), streamed status and
  artifact updates over SSE, and push notifications. It is the closest public
  standard to camelRun's notification plus `input_required` model. A camelRun
  agent could be exposed as an A2A server later, as it is already exposed as an
  MCP server.
- **Pi's own sub-agent design (#696).** It moves a child into the parent's Pi
  task, or into its own Durable Object, behind Pi ownership. It keeps the model's
  tool surface and the `subagent_*` events, and proposes
  `GET /v1/agents/{parent}/children` for scratch children that would lose their
  own agent id. On hold.

## 4. camelRun today

See [Multi-agent](../guides/multi-agent.md) and [Events](../reference/events.md)
for the full contract.

### Model tools

- **`delegate`** is synchronous: the answer is the call's result.
- **The `agents` builtin:**
  - `spawn_agent` starts a background child.
  - `wait_agent` waits for an ending, a message, or (with `untilProgress`) a
    progress report.
  - `list_agents`, `send_message`, `interrupt_agent`.
- **Children** get `report_progress` (status that never starts a turn) and
  `send_message` to `"parent"`.

### Endings

An ending is a durable notification, a prompt `child_<request>`. It lands
exactly once, even if a node is lost, and either wakes the parent or queues
behind its running turn. It reads as:

```text
<agent_notification name status>…</agent_notification>
```

It also carries `source` and `metadata` with the status, output, usage and
inputs.

### Messages

A message to a busy agent steers its running turn: it is taken after the
current tool calls. A message to an idle agent starts a turn that keeps its
history.

### Progress

Progress rides on the parent's next tool result as `<agent_updates>`, latest
report only. Watchers see it at once as `subagent_progress`.

### Clients

- **Event stream.** The stream is Pi's event stream (`message_start/update/end`,
  `tool_execution_*`) with run frames, cursors, replay, snapshots and
  `?request=`. With `?subagents=1` it adds `subagent_start`, `subagent_event`,
  `subagent_end`, `subagent_message` and `subagent_progress`.
- **Children's own API.** Each child is an agent of its own, with its own
  stream, history and inputs, and a browser token with the `children` scope
  reads them.
- **Steering and stopping.** `POST /v1/agents/{id}/prompt` takes `whileRunning:
  "queue" | "steer"`. `POST /v1/agents/{id}/abort` takes `queued` and
  `children`.

### Safety

These are what neither Claude Code nor Codex has in this form:

- a signed delegation chain
- the parent's spend limit shared among its children, with `subagentCostUsd`
- a per-chain wake cap, so agents that keep waking each other stop
  (`agent_loop_limit`)
- neutralized sender blocks
- endings delivered exactly once

## 5. Comparison

| Capability | Claude Code | Codex app-server | camelRun |
| --- | --- | --- | --- |
| Start a background worker | `Agent` (background default) | `spawn_agent` | `spawn_agent` |
| Synchronous sub-call | `Agent` with `run_in_background: false` | — (spawn + wait) | `delegate` (also in code mode) |
| Result back to parent | Injected notification (status, summary, usage, output file); explicit hand-back tool | Mailbox message `FINAL_ANSWER` (no turn by default) + `subAgentActivity` item | Durable `<agent_notification>` that wakes or queues (exactly once), status/output/usage in metadata |
| Structured result | — (text) | `outputSchema` per turn | `output` JSON Schema per spawn |
| Wait | Parent is woken; no wait tool | `wait_agent` (statuses, ≥ 10 s) | `wait_agent` (answers, messages, `untilProgress`) |
| Message a running child | `SendMessage`: next tool round; 2.1.317 backgrounds the running command so it arrives at once | `send_input` / `followup_task`; `interrupt: true` redirects now | `send_message`: after the running tool calls; **no way to cut in** |
| Child to parent | `SendMessage({to: "main"})` | mail to parent path | `send_message({to: "parent"})` steers the parent |
| Progress | `task_progress` (SDK); none to the model | — | `report_progress` → `<agent_updates>` on the next tool result + `subagent_progress` |
| Interrupt / stop | `TaskStop`, `stopTask()` | `interrupt_agent`, `close_agent` (cascades) | `interrupt_agent`; abort cascades (`children: "keep"` opts out) |
| Peer to peer (siblings) | Teams: mailbox per teammate | V2 paths: anyone in the tree | Parent ↔ child only |
| Fork the conversation into a child | `subagent_type: "fork"` | `fork_context` / `fork_turns` | Not supported: the task text only (`computer: "fork"` forks the disk) |
| Client: list children | `ListAgents`; SDK `task_*` events | `thread/list {parentThreadId}` | **None**: `GET /v1/agents?subAgents=only` lists every child of the tenant, without `parent` or status |
| Client: tree state as a level signal | `background_tasks_changed` (replace semantics) | `thread/status/changed` per thread | **None**: edge events only (`subagent_start`/`_end`), and a background `subagent_end` comes only when the notification lands |
| Client: child activity on the parent's stream | `parent_tool_use_id` on every frame | Child threads' events reach every client; `collabAgentToolCall` items | `?subagents=1` relays `subagent_event` (Node: only while on the parent's node) |
| Steer precondition | — | `expectedTurnId` | — (steer joins whatever turn runs) |
| Loop and cost guards | Depth, concurrency, budget caps | Depth, thread caps | Depth, `maxParallel`, shared spend, wake cap, messages per turn |
| Durability | Local transcripts | Rollout files; delivery "best effort" | Durable rows / DO storage; exactly once across node loss |

## 6. Ranked improvements

Ranked by value to camelCode and other leads, over cost. S, M and L are rough
sizes on both backends, tests included.

### 1. List an agent's children, with a tree summary (S–M) — built: see PRs

**Why.** camelCode's scripts poll history every 3–5 s. They guess "done" by
counting spawn results against notification messages, and find children by
scraping `GET /v1/agents?limit=200` for `parentAgentId`. The same need comes
up for any UI that shows workers, and Codex (`thread/list {parentThreadId}`)
and Claude Code (`background_tasks_changed`) both answer it.

**Shape.**

```http
GET /v1/agents/{id}/children
→ { children: [{ agentId, name, kind: "spawn" | "delegate", status, requestId,
     toolCallId, startedAt, endedAt?, progress?, progressAt?, error? }],
    running: <how many are running> }
```

- **What's listed.** The children that the agent's `spawn_agent` and `delegate`
  calls started (and spawn directives), latest first, deduplicated by child.
  `status` takes the values `list_agents` uses: `running`, `completed`,
  `failed`, `aborted`, `input_required`.
- **Who can read it.** An API key; a browser token with the `children` scope.
- **SDKs.** `agent.children()` (TypeScript) and `agent.children()` (Python).
- **Idle check.** "Is the tree idle" is `!state.running && running === 0` for
  the lead, recursively if the client wants grandchildren.

**#696.** It already proposes this endpoint as the adapter for scratch children
that lose their own agent id, so it outlives the spike either way.

### 2. Fix two Workers/Node differences (S) — built: see PRs

- **The documented abort value.** `POST /v1/agents/{id}/abort {children:
  "abort"}` is the documented default (OpenAPI, Node, both SDKs), but Workers
  answers 400 "children is cancel or keep". Both backends should accept `abort`
  and `keep`. Workers can keep `cancel` as an alias.
- **Progress on every tool result.** On Node, a background child's progress
  rides on the parent's next tool result of any tool, as documented. On Workers
  it rides only on the delegation tools' own results (`send_message`,
  `list_agents`…), so a lead busy with `computer` or MCP calls never sees its
  workers' progress until it calls one of them. (Not built yet: it needs a hook
  in Workers' generic tool-result path. Next after 1 and 2.)

### 3. A message that cuts in: `send_message({…, interrupt: true})` (M–L)

**Why.** A camelCode worker spends most of its time inside one `computer` exec:
tests, installs, up to 10 minutes. A correction from the lead ("wrong branch",
"stop, the user changed their mind") waits for that call to end. Today the only
fast path is `interrupt_agent` followed by `send_message`. That ends the worker's
turn `aborted`, wakes the lead with an aborted notification it has to read and
ignore, and takes two calls and a race.

Codex has `send_input {interrupt: true}`. Claude Code moved the same way in
2.1.317, by backgrounding the running command rather than killing it.

**Shape.** `send_message({to, text, interrupt?: boolean})`.

- `interrupt: true` to a running child aborts the turn's in-flight tool calls.
  They are answered as interrupted, which Pi's step boundary already supports
  for aborts. The message then starts the child's next turn, keeping its
  history.
- The interrupted turn's ending is folded into the message's row, so the parent
  gets no `aborted` notification. It gets the notification of the turn the
  message started.
- Its cost still lands on the parent's spend limit, through the folded row.
- At the HTTP level this is `whileRunning: "interrupt"` on
  `POST /v1/agents/{id}/prompt`, which a person's client can use too (an
  "interrupt and send" button). Codex's `turn/interrupt` + `turn/start` in one
  call.

**Cost.** This touches the exactly-once and spend paths on both backends: Node
`agent_children` folding, and the Workers delegation outbox. It needs Opus
review and a sim run, and is the one to build after Miguel agrees with the
shape.

**#696.** A Pi-owned child would get this nearly free: aborting a Pi task's
step and submitting input is one Pi transaction, with no row folding.

### 4. Tree state on the parent's stream as a level signal (M)

**Why.** The `subagent_*` events are edges. A watcher that connects late, or
crosses a replay gap, can't tell which children are running. A background
child's `subagent_end` arrives only when its notification lands, which can be
long after it ended while the lead is busy.

**Shape.**

- The `snapshot` frame gains `subagents: [{agentId, name, status, progress?}]`
  (the same rows as improvement 1).
- `subagent_end` for a background child is emitted when the child's run ends,
  with `delivered: false`. The landing then emits a `subagent_delivered`.
- The browser watcher (`@camelai/run/watch`) folds both into `state.subagents`.

**Depends on** improvement 1.

### 5. Richer hand-back envelope (S, but a prompt change)

**Why.** The model sees only `<agent_notification name status>text`. Claude
Code shows the parent the usage and duration; Codex shows the task and sender.
A lead deciding whether to retry a worker benefits from knowing it ran 9
minutes and spent $0.80, or hit `turn_limit`.

**Shape.** Attributes on the block: `duration="9m12s" cost="$0.80"`, and
`stopped="turn_limit"` when set. The structured `output` is already rendered.

**Cost.** Small in code. It changes what every lead's model reads, so it needs
the builder/eval canary that model-facing changes get.

### 6. Steering preconditions (S)

**Shape.** `POST …/prompt {whileRunning: "steer", expectedRequest: "<the turn's
request id>"}`. If that turn has already ended, it is refused (409) instead of
starting a turn of its own.

**Why.** It is Codex's `expectedTurnId`. A UI that shows "steer the current
answer" should not start a new turn when the answer just ended. Low priority:
the 202's `steer: "queued"` already tells the client.

### 7. Peer messages between siblings (M; product decision)

**Shape.** `send_message({to: "<sibling name>"})` within one parent's children,
with the wake cap applying.

**Why.** Codex V2 and Claude Code teams allow it. camelCode doesn't need it yet:
the lead relays. Decide alongside #696, since #696 changes what a sibling is.

### 8. Conversation fork into a child (M–L; product decision)

**Shape.** `spawn_agent({context: "fork"})`: the child starts with a copy of the
parent's history, as Claude Code's `fork` and Codex's `fork_turns: "all"` do.

**Trade-offs.** It is cache-friendly and needs no briefing. But it multiplies
context cost, and it blurs the "a sub-agent sees only its task" rule that the
spend and safety model leans on. With `computer: "fork"` the disk is already
shared, and camelCode briefs workers in the task. Not recommended now.

## 7. What was built

| PR | What | State |
| --- | --- | --- |
| this one | This note | draft |
| see the PR list in the description | 1. `GET /v1/agents/{id}/children` and the SDKs' `children()` | see the PR |
| see the PR list in the description | 2. Workers accepts `children: "abort"` | see the PR |

## 8. Decisions for Miguel

1. **Improvement 3.** Is `send_message({interrupt: true})` (and
   `whileRunning: "interrupt"`) the shape we want? Should it wait for #696,
   which would make it much cheaper?
2. **Improvement 7, peer messages.** Allow them now, or leave them to #696?
3. **Improvement 5.** Change the notification envelope the model reads, with
   an eval canary?
4. **Improvement 8, conversation fork.** Keep it out?
