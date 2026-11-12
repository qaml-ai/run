### Workflows: a changed argument reruns an effect; an edit cancels the queued work it dropped

Two changes to how edits treat effects already in the journal.

**Arguments count, not just keys.** An edit now keeps an effect's result only when both its key and its arguments are unchanged, as `workflow_edit` and the guide already said. Until now the runner matched effects by key alone, so an effect whose arguments changed under the same key kept its old result.
- An effect with the same key and new arguments is run again, and counts as a rerun towards `rerunConfirmPercent`.
- If the old version is still running, it is stopped.

**Dropped queued work never starts.** On an edit's first step, effects the journal still had waiting to start are cancelled if the new script doesn't ask for them. These are effects queued behind the concurrency cap, or held for a confirm. If the script asks for one later, it is issued again.

The `edited` event now records `confirm`.
