# Batching queued prompts

An agent whose queue batches (`queue: {mode: "batch", windowMs?}`, `shared/queue-mode.ts`) runs the prompts that wait
while a turn runs as one next turn, each its own user message in arrival order. A burst of ten events to a lead costs
one turn instead of ten, each of which re-read the whole context. The product side is in
[Concepts](../concepts.md#batching); this is how both backends do it and why.

The idea is DeepSeek's super-agent prototype's: a thread's evaluation runs serially and merges the triggers that arrive
meanwhile into the next batch. Child endings here already batch the same way (`delegation-notifications.ts` `batch` on
Workers, `landNotice` on Node).

## Decisions

| Question | Decision | Why |
| --- | --- | --- |
| Opt-in or default | Opt-in, an agent's or definition's `queue` (`{mode: "each"}` or unset: one turn each) | It changes what a request's record says and who gets a reply: an application waiting per request must choose it |
| A key per prompt (merge only same-thread prompts) | No key: everything that may join merges | One agent is one conversation, and every turn reads all of it, so keeping threads apart costs a turn per thread for no isolation. Pi's inbox has no key either. An application that wants threads apart gives each its own agent |
| What may join | A prompt of the application's, without an `output` schema, `spendLimit` or `runLimits` of its own, for the same `actor`, `bucket` and `endUser` as the first; contiguous: the batch ends at the first that does not fit | A turn has one output schema, one budget and one set of limits, acts for one actor (identity tokens, who may answer its inputs) and is charged to one end user and bucket. Stopping at the first misfit keeps arrival order |
| Delegated and runtime prompts | Never join nor lead a batch: a prompt signed into a delegation chain (its metadata names a parent), and the runtime's own (`delegate_`, `spawn_`, `msg_`, `resume_`, `child_`, `schedule-` ids, notifications) | A delegate call waits on its turn's answer alone, and is charged for it; merged, it would get another caller's turn, and pay for it |
| Sub-agents | Never batch | Since #740 a sub-agent runs only what its parent sends, one turn per call |
| Idle agents | `windowMs` (0 to 2000, default 0): a joinable prompt that reaches an idle agent waits that long first | A burst that arrives at an idle agent would otherwise run its first message alone. Bounded small: latency added to a first message. Applications set it (camelCode: 500 ms) |
| Steers | Every steer waiting at a step's end goes in at once (Node: the host submits them all; Workers: Pi's `steeringMode: "all"`) | The same saving inside a turn |
| Merged requests' outcome | Each ends with the turn, with the turn's answer (`reply`…) and `batchedInto` naming its first prompt, on its result and its record; a `batch_taken` event marks its message going in. The first prompt's record lists `batch` and has the usage | A caller waiting on its own request gets the answer. On Workers Pi settles every input of a run with its answer, which this matches |
| Webhooks | `run.completed` per request: merged ones with `batchedInto` (and no usage), the turn's with `batch` and the usage | Every request ends; the money is on one |
| Billing | Once, on the turn's first prompt: its model calls, its active time. Merged requests carry no usage and no active time | One turn, one charge |
| Retries | A merged request's id is its record: a retry answers with it, never a second message | Idempotency is per request id, as before |
| Abort | A stop cancels the prompts still waiting (held ones on Workers); the running turn's batch ends with it; `queued: "keep"` keeps the waiting ones | As for any queue |

## Node

`ClientSessions.run` claims the batch as the first prompt begins (`batchOf`): the prompts queued behind it that may join,
in order, up to the first that may not. The journal commit that records the first prompt's `began` marks each member
`batchedInto` it; members keep their params. The host gets the first's params with `batch: [their params]` and prompts
Pi with all their messages at once (`agent-host.ts`: one `agent.prompt(messages)`, each message stamped with its own
request id). As each member's message lands (`message_end`), a `batch_taken` event says so (`batchTaken`). When the turn
ends (`batchEnded`), each member it took ends with its answer (`batchOutcome`); one it never took (the turn failed or was
stopped before the messages went in) goes back to the queue as a run of its own, or ends aborted with a stopped turn.

Exactly once: a member keeps its params until its turn ends, so a node lost at any point leaves it queued for the next
owner. There it runs as its own request, and the host, which finds a prompt's request id in the journal before it
prompts (`journal.hasRequest`), answers `taken` for one whose message landed: it ends with its turn's answer, and nothing
is said twice. One whose message never landed runs its own turn. A stop marks the running turn's members aborted with it
(`abortedAt`), and a run that finds itself so marked before it began ends aborted, so no owner runs one after the stop.

The window (`batchWindow`) sleeps on the node's clock before the run's start, while the prompt is still queued.

## Workers

Pi batches: an agent whose queue batches has Pi's `followUpMode` (and `steeringMode`) "all" (`agent-tools.ts`
`settings`), so the follow-ups waiting in Pi's inbox when a run ends are placed together and start one run, and Pi
settles each with that run's answer. A joinable prompt goes straight to Pi's inbox as a follow-up. Pi merges whatever
waits there, so the inbox must hold only prompts that may share a turn: anything that would go in beside waiting
follow-ups and may not join them is held in the Durable Object instead (`batch-queue.ts`), and so is everything after it,
in order. That is a prompt with an output schema or limits of its own, for another actor or bucket, a delegated or
runtime prompt, a notification, an agent's message taking a turn of its own, and a steer no turn could take. Once Pi has
no follow-ups waiting (`onView` reads Pi's inbox; the watchdog asks too), `release` gives Pi the first held prompt and
those after it that may join it. A release Pi keeps refusing ends that request failed after five tries, so the queue
goes on.

Which inputs shared a run is read from Pi itself, never kept by the runtime: Pi settles every input of a run with that
run's answer entry, and only the running run's inputs are `placed` (`runKey`). A batch is the prompts before the run's
first answer that share its key (`batchOf`); the first started the run and has its usage and active time (`BatchRuns`
in `batch-runs.ts` attributes the transcript so), and the others name it. A run that failed (no answer) leaves its
inputs unanswered, each alone, so it never swallows the next run. `onView` reads a batch the same way, so a restart in
the middle of one reads it as before. Holds are released by request id, which Pi's submissions make idempotent: there is
nothing of the runtime's to recover.

Known limit: a window holds a joinable prompt that reaches an idle agent, and those arriving with it, until it ends;
then the first starts a run, and the others, follow-ups by then, run together as the next. A burst at an idle agent costs
two turns on Workers, one on Node. Pi cannot start a run with several inputs; a Pi feature for it (an idle input that
queues, `whenIdle: "queue"`, then a `continue` that places them all) would make it one.
