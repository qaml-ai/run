# Monitors

Status: design, being built on `claude/monitors`. Short on purpose; the guide is `docs/guides/monitors.md`.

An agent often needs to wait for something outside itself: a deploy to finish, a price to cross a line, a page to
change. Today it either polls in a turn (model tokens, and on Workers an awake Durable Object) or asks for a schedule,
which wakes the model every time, mostly to find nothing. A monitor moves the waiting to the platform: a small script
polls, and the agent is woken only when the script says so.

## The model

A monitor is a durable row owned by one agent (and its tenant):

| Field | Meaning |
| --- | --- |
| `name` | 1–64 of `a-z 0-9 _ -`, unique among the agent's live monitors. Starting one under a live name replaces it |
| `everySeconds` | 60 to 86,400. The first check runs at once |
| `code` | The check: a code-mode script (an async function body), at most 16,000 characters |
| `mode` | `"once"` (default): stops after its first fire. `"repeat"`: goes on, and fires again only when `value` differs from the last value it fired with |
| `expiresInSeconds` | Default 86,400, at most 30 days. Past it the monitor stops, silently |
| `budget` | Optional `{usd}`: the spend limit of each turn a fire starts |

The check sees `state` (what its last run returned, `null` the first time) and `tools.fetch`. It returns
`{ fire: boolean, value?, state?, nextSeconds? }`: `value` and `state` are JSON of at most 4 KB each; `state` is handed
to the next check ("changed since last time"); `nextSeconds` (60 to 86,400) overrides the interval for the next check
only, which is how a check backs itself off. Anything else returned, or thrown, is an error.

```js
const r = await tools.fetch({ url: "https://api.example.com/deploys/42", headers: { authorization: "Bearer camel-vault-DEPLOY_KEY-placeholder" } });
const status = JSON.parse(r.body).status;
return { fire: status !== "running", value: { status }, state: { seen: status } };
```

When `fire` is true the platform queues one message to the agent, an ordinary prompt (request id
`monitor-<id>-<n>`), so it takes the same path as any prompt: the agent's `queue: {mode: "batch"}` merges a burst of
fires into one turn, its spend limits and run limits apply, and the turn is billed as any turn. The message frames the
value as data, not instructions. A fire with a `budget` carries it as the prompt's `spendLimit` (and so, by the batching
rules, runs as its own turn). Approvals asked in a turn a monitor started are declined, as under
`humanInput.unattended: "decline"`: nobody is there.

## What the agent gets

Builtin `monitor` adds three tools (text below is the whole model-facing surface; the session lead finalizes wording):

- `monitor_start({ name, everySeconds, code, mode?, expiresInSeconds?, budget? })`
- `monitor_stop({ name })`
- `monitor_list()`
- in code mode only, `tools.monitor_wait({ name } | { everySeconds, code }, timeoutSeconds)`: the script stops off its
  clock, as it does on `tools.delegate`, until that monitor fires (resolves `{ fired: true, value, firedAt }`) or the
  timeout passes (`{ fired: false, timedOut: true }`). An inline spec makes a `once` monitor that lives for the wait.
  While a script waits on a monitor its fires go to the script, not to the queue. Pi's tool names cannot contain a dot,
  so it is `tools.monitor_wait`, not `tools.monitor.wait`.

A wait keeps its turn open (exactly as a `delegate` wait does), so it is for waits of minutes inside a script.
`timeoutSeconds` is at most 3,600. To wait for hours, `monitor_start` and end the turn.

## API, SDK, CLI

```
POST   /v1/agents/{id}/monitors                {name, everySeconds, code, mode?, expiresInSeconds?, budget?}  -> 201 monitor
GET    /v1/agents/{id}/monitors                -> [monitor]        (live, and ended in the last 7 days)
GET    /v1/agents/{id}/monitors/{monitorId}    -> monitor          (id or name)
DELETE /v1/agents/{id}/monitors/{monitorId}    -> {stopped: true}
GET    /v1/agents/{id}/monitors/{monitorId}/checks -> last 50 checks: {at, fired, error?, durationMs}
```

A monitor reads as `{id, name, everySeconds, mode, code, status, reason?, createdAt, expiresAt, nextCheckAt, lastCheckAt?,
lastFiredAt?, fires, checks, consecutiveErrors, lastError?, value?, budget?}`; `status` is `active`, `paused` or
`stopped`, `reason` one of `stopped`, `fired`, `expired`, `errors`, `noise`, `replaced`, `agent_deleted`. No check
payload is kept: only the latest `state` and the last fired `value` on the monitor row, and the 50-row check log
(time, fired, error text, duration). SDKs: `agent.createMonitor / monitors / monitor / stopMonitor / monitorChecks`
(TypeScript), `create_monitor / monitors / monitor / stop_monitor / monitor_checks` (Python). CLI:
`camelrun monitors list|add|get|stop|checks <agent> [monitor] [--input JSON]`.

## Scheduling and cost: the agent is not touched until a fire

Monitors live in Postgres (`agent_monitors`, with an index on the due time of active rows). Nothing about an idle
monitor is in the agent's Durable Object (Workers) or session (Node), and no check loads either.

**Shared core** (`src/monitors.ts`, both backends): `scan()` claims due rows (`for update skip locked`, a lease of 60 s
and a lease token, as schedules and triggers do), runs each check, and in one conditional update (`where lease = …`)
writes the new `state`, the next due time, the counters and the log row. A lost node's lease lapses and another scan
retakes the row; the fire's request id is derived from the monitor and its fire count, so a retried fire is the same
request, never a second message.

**Node.** The existing scheduler loop (`Scheduler.also`, every `schedulerIntervalMs`, 5 s) calls `monitors.scan()`.
The check runs in the node process's v8-exec pool (a process per execution, as all code mode), at most 4 checks at a
time per node, never in the agent's host process: no session is loaded, no journal read. A fire calls the same
`submitAnywhere` a schedule does.

**Workers.** The minute cron (`* * * * *`, already there) sends one `{kind: "monitors"}` message to the existing queue
when any monitor is due (one indexed `select 1`). The queue consumer, a stateless Worker invocation, runs `scan()`:
claims in Postgres through Hyperdrive, and runs each check's QuickJS VM in the code-mode Worker's sandbox object
`monitor:<tenant>` (the same separately deployed `CodemodeSandbox` class agents use, so a busy script never blocks the
consumer; it is not the agent's object and holds no storage). `tools.fetch` runs in the consumer. The agent's Durable
Object gets a request only on a fire (`POST /requests`), on `monitor_start/stop/list` (it is already awake: it is in a
turn), and never for the HTTP API (routes go to Postgres).

**Cost, roughly.** A monitor at 60 s is 1,440 checks a day; at 5 minutes, 288.

| | Workers | Node |
| --- | --- | --- |
| Per check | 1 claim + 1 update in Postgres, about 5 ms Worker CPU, one sandbox-object request held for the check's wall time (typically 0.1 to 0.5 s of a 128 MB object: about 0.03 to 0.06 GB-s), the fetches | 1 claim + 1 update, one v8-exec process for the check (about 20 MB, tens of ms CPU), the fetches |
| Per check, list price | about $0.000001 (request $0.15/M, duration $12.50/M GB-s, CPU $0.02/M ms) | no metered unit; capacity is 4 checks at a time a node, about 500 a minute at 0.5 s each |
| A 60 s monitor, a day | about $0.0015 | – |
| Agent DO wakes while nothing fires | 0 | 0 sessions loaded |
| Model tokens while nothing fires | 0 | 0 |

For comparison, one schedule wake of an idle agent is a DO wake plus a model call over the whole context, typically
$0.01 to $0.10: a monitor that checks every minute for a day and fires once costs less than that one wake.

**Billed and not billed.** Checks are not billed in this version (no usage record, no credit hold): they are bounded
by the caps below instead. A fire's turn is billed and limited as any prompt (spend limits, run limits, end-user
credits). Charging a per-check price is an open question.

## Limits and guardrails

| Limit | Value |
| --- | --- |
| Live monitors per agent / per tenant | 20 / 200 |
| `everySeconds`, `nextSeconds` | 60 to 86,400 |
| Check CPU / wall | 2 s / 10 s |
| Fetches per check; request body; response body read | 5; 16 KB; 256 KB (longer is cut, `truncated: true`) |
| `value`, `state` | 4 KB of JSON each |
| Expiry | default 1 day, at most 30 days |
| Errors | after each failed check the next is delayed (interval × 2 per error in a row, at most 1 hour); 10 in a row stop the monitor (`errors`) with one message to the agent saying why |
| Noise | more than 12 fires in an hour pause the monitor (`noise`) with one message; `monitor_start` under the same name starts it again |
| `tools.monitor_wait` timeout | 1 to 3,600 s |
| Check log | last 50 checks per monitor; ended monitors are deleted after 7 days |

Fires count against the agent's own limits because they are prompts. A fire the agent refuses for good (402 spend
limit, 404/410 deleted or expired agent) is not retried: 404/410 stop the monitor (`agent_deleted`), others count as an
error of that check. Deleting an agent deletes its monitors (`on delete cascade`), and a scan stops those of a revoked
or expired agent.

**Sub-agents.** A sub-agent runs only what its parent sends (#740), so, as with the schedule tools (#749), it is not
offered `monitor_start`: a fire would start a turn its parent did not send. It does get `tools.monitor_wait` in code,
whose monitor is its own and stops with the wait, and so with the sub-agent. See open questions.

## Security

- **What a check can do:** compute, and `tools.fetch({url, method?: "GET" | "POST", headers?, body?})` at most 5
  times. Nothing else is in its sandbox: no model call, no `delegate`, no computer, no files, no other tool, no
  `store`. It is the same sandbox as code mode (v8-exec process with seccomp on Node, a QuickJS VM in a separate Worker
  on Workers), with its own, tighter CPU and wall limits.
- **SSRF:** every fetch goes through the backend's existing outbound guard (`Outbound` on Node, `PublicOutbound` on
  Workers): public addresses only, checked at connect time, redirects re-checked, a deadline and a byte cap. The
  agent's `networking` policy applies at check time: a `limited` agent's checks reach only its `allowedHosts`.
- **Secrets:** a check never sees a secret. It writes `camel-vault-NAME-placeholder` in a header (or query, if the
  secret's policy allows); the platform substitutes the value through the vault's `vaultRequest`, which enforces the
  secret's own `allowedHosts` and locations, HTTPS only, no redirects, and masks the value in the response. Only vault
  references already attached to the agent's configuration (its MCP/OpenAPI `auth`, its `computer.secrets` and egress
  `auth`) can be used, read at check time, so detaching or deleting a secret takes effect on the next check.
- **Prompt injection:** the fired `value` is wrapped as data (`<monitor_event>` with `<`, `>` and backticks escaped)
  under a line saying it is not instructions, as webhook triggers do; approvals in the turn are declined.
- **Tenancy:** every query is by tenant and agent; the Workers sandbox object is per tenant; checks of one tenant
  cannot see another's state.

## Migration and rolling deploys

`migrations/134_agent_monitors.sql` only creates two new tables (`agent_monitors`, `monitor_checks`) and their
indexes. It changes no existing table, column, key or index, so nodes still running the old code against the new
schema are unaffected (they never read or write the new tables), and new nodes against the old schema do not exist
(migrations run at startup, before serving). The `agent` column references `agents(id) on delete cascade`, as
`agent_triggers` does: an old node deleting an agent removes its monitors through the database. Nothing is
backfilled. Everything is additive for SDK users (camel-bots on `@camelai/run` is unaffected: new methods, a new
optional builtin).

## Open questions

1. **Charging for checks.** Free and capped now. A per-check price (or counting checks against a tenant allowance)
   would need a usage kind and holds on the scan path.
2. **`tools.monitor.wait` naming and suspension.** The dot is not expressible in Pi tool names. And the wait keeps the
   turn (on Workers the agent's object) open, like `delegate`; a true suspension (the turn ends `waiting`, the fire
   resumes the script, as code pauses for people do) would make hour-long waits free. Worth it?
3. **Sub-agents.** Should a sub-agent's `monitor_start` be allowed, its fires routed to it as runtime notifications
   (or to its parent)? Deferred with `monitor_wait` only.
4. **Secrets scope.** Attached references only (above). Should a tenant be able to attach a secret to a monitor
   through the HTTP API without attaching it to the agent?
5. **Sub-minute checks, and push.** 60 s is the floor (the Workers cron's grain). Webhook triggers already cover push;
   a monitor that long-polls or holds a socket is out of scope.
6. **Noise and error thresholds** (12 fires an hour, 10 errors) are guesses to revisit with real use.
