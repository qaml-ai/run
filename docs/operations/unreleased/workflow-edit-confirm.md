### Workflows: a confirmed edit goes on; new work beside kept results is not a rerun

A real-model pilot run got stuck. Its script faulted with `key_required`, and the fix added one keyed `commit()` after
three finished agents. That edit counted as a 33% rerun and paused at `confirm_rerun`. The next edit, sent with
`confirm: true`, stayed paused for good.

- **What counts as a rerun:** a new effect issued while a finished result goes unused, its key dropped from the script.
  New effects beside finished results that are all still used are new work, and never pause an edit.
- **An edit replaces one held at `confirm_rerun`:** the new edit is checked for its own reruns.
- **`confirm`:** `PUT /v1/workflows/{id}/script` and the SDKs' `edit` take `confirm` to go ahead. `workflow_edit`'s
  `confirm` now confirms the edit instead of raising its threshold to 100%.
