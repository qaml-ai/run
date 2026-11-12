### Workflows: no live editing; a new workflow reuses finished results

A workflow's script can no longer be edited. To change one, abort it (or let it end) and start a new one. Its
`agent()` and `job()` calls whose arguments match a result an earlier workflow of the same owner finished are answered
from that result, at no cost: no sub-agent or container runs. See [Workflows](../guides/workflows.md#changing-a-workflow-start-a-new-one).

- **Removed:** `PUT /v1/workflows/{id}/script`, `GET /v1/workflows/{id}/diff`, `resume`'s `rerun`, the summary's
  `revision`, items' `revision` and `seenRevision`, the SDKs' `edit` and `diff`, the `workflow_edit` tool, and the
  `confirm_rerun` pause. `resume` takes no options; a body with any is 400.
- **Reuse:** the owner is the agent that started it, or the account for one started with an API key. Only finished
  results are reused, never a `commit()` or `push()`. `agent(…, { repo })` and `job({ at })` are reused only while that
  volume is unchanged since the earlier call started. `nocache: true` opts a call out. Results live 7 days from their last use, at most
  2,000 and 64 MiB per owner; one over 1 MiB is not kept.
- **Shown as:** items with `origin: "cache"` and `cachedFrom`, `counts.cached` on the summary, and the event
  `effect_cached`.
- **A fault ends the workflow:** `key_required`, `key_conflict`, `step_budget`, a thrown error and the like now end it
  `failed`, with `fault: { code, message }`, instead of pausing it for an edit. What was still running is stopped.
- **Pauses that end by themselves:** `payer_exhausted` tries again after 5 minutes, doubling to 30; `capacity_refused`
  tries again every minute; `journal_version` (a journal written by a newer runtime, during a deploy) is now a pause,
  not a fault, and goes on once a node that can read it runs it. `workflow_resume` still goes on at once.
- **Workflows already running at the deploy:** one held at `confirm_rerun` ends `failed` with the fault
  `edit_retired`; one paused for a fault ends `failed` with it. Others go on.
