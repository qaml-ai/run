### Workflows: gate() asks a person in the inbox

On the Workers backend, a workflow's `gate({ title | question, body?, options?, recommended?, reason?, expiresInSeconds?,
onExpire? })` now works. Until now it failed at once. It creates a decision in the account's inbox (`GET /v1/inbox`),
owned by the workflow (`owner_kind = 'workflow'`, `agent` = the workflow's id), and the workflow waits durably. Answer
it with `POST /v1/inbox/answers`, naming the workflow's id as `agent`. The answer lands on the gate exactly once, and
`gate()` returns the chosen label (or the person's own words); a decline returns `null`.

At its expiry (the workflow's own alarm), a gate with `onExpire: "recommended"` takes its recommendation, and its item
leaves the inbox as expired. Any other gate pauses the workflow (`waiting_on_gate`), and its item stays answerable for
30 more days: the answer lands, and a resume goes on. Aborting or editing the gate away withdraws the item. The agent
that owns the workflow gets a `<workflow_notification>` with event `gate_opened` (the gate's key, item id, title and
expiry).
