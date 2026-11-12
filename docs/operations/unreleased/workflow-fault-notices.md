### Workflow notices say what a stop waits for, and a fault's message

`<workflow_notification>` bodies and `workflow_status` now carry two new fields:

- `fault`: `{ code, message }`, when the script itself went wrong.
- `next`: one line saying what a stopped workflow waits for and which tool goes on.

A fault reads "The script failed (key_required): fix it with workflow_edit…". The stops read as follows:

| Stop | `next` points to |
| --- | --- |
| a confirm | `workflow_resume`, or `workflow_edit` with `confirm` |
| a user pause | `workflow_resume` |
| a payer pause | `workflow_resume` once there is credit |
| a gate | answer it in the inbox, then `workflow_resume` |
| capacity | `workflow_resume` once another workflow ends |
| a spent budget | `workflow_budget` |

Before this, a fault's message was left out. On the pilot, an agent read `key_required` as "awaiting your approval".
