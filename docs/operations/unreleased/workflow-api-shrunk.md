### Workflows: gate(), sleep() and phase() are removed

A workflow script's globals are now `agent()`, `parallel()`, `job()`, `commit()`, `push()`, `log()`, `now()`,
`random()`, `args` and the base64 and text helpers. `gate()`, `sleep()` and `phase()` are gone: a script that calls one
fails on that line (`gate is not defined`). Use `log()` to mark a stage.

- The `waiting` status and the `waiting_on_gate` pause reason are gone. `GET /v1/workflows/{id}` has no `phase`, and
  `GET /v1/workflows/{id}/items` takes no `?phase=`; an item's `kind` is `agent`, `job`, `commit` or `push`.
- A workflow's gates are no longer inbox items: `POST /v1/inbox/answers` with a workflow's id answers 404, as for any
  unknown agent.
- The TypeScript and Python SDKs follow: `WorkflowItem.kind`, no `phase` on `WorkflowSummary`, `WorkflowItem` or the
  items query, and no `waiting` in `WorkflowStatus`.

At the deploy, a workflow that has not ended and waits on a gate or a timer, or whose script calls `gate()`, `sleep()`
or `phase()`, ends `failed` with the fault `script_api_retired` ("gate(), sleep() and phase() were removed: start the
workflow again without them"); its running sub-agents stop. Migration 140 closes every open workflow inbox item as
`expired`.
