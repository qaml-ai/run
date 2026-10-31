### Filter a channel's messages with a decision model

A channel can now have a `filter`: one yes/no question (`instructions`, optional `criteria`, `threshold`) that Jev answers
about each message before it starts a turn. A message below the threshold makes no agent and starts no run. It works on
every channel type, through `POST`/`PATCH /v1/channels` and the console's channel dialog.

Each verdict is recorded (`channel_seen.verdict`, no content) for 14 days, and a filtered message is kept as a
`filtered` channel item for as long. `GET /v1/channels/:id/events` and the console's **Activity** list them;
`POST /v1/channels/:id/events/:event/deliver` sends a filtered message on, once. If the decision fails or takes over 15
seconds the message goes on (`reason: "decision_failed"`), logged as `channel_filter` with no content. Decisions bill as
usual, with `actor: "channel:<id>"`, and do not count against the run rate limit.

A filter is a convenience, not a security control: an email's body can argue its way past it. Deleting a channel or an
account deletes its filtered messages and verdicts, in one transaction per channel. They are not in the account export. A
large email's stored copy lasts 7 days, so one delivered later goes without the attachments that were only there.

Migrations `105` and `106` add the column and a partial index, built concurrently.
