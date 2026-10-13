### Email channels: where replies go, and trusted forwarders

- An email channel takes `settings.replies`: `"sender"` (the default, as before), `"none"` (nobody is mailed; a turn's
  reply is read from the agent's history, which is how an agent drafts answers for a person to send) or
  `{"to": "<address>"}` (every reply, file, question and notice goes to that one address, saying whose message it
  answers; never to the person who wrote). A fixed address gets mail only after it has written to the channel's address
  once, with a From SES proves; the channel then shows `account.verifiedReplyTo`.
- `settings.forwarders` (addresses or `@domain`) lets a mailbox forward into a channel. A forward is accepted on proof
  of the forwarder (SES's SPF verdict passing for an envelope sender at a listed domain), never on headers;
  `access.allow` is asked about the forwarder; and the original sender reaches the agent marked unverified
  (`from.id` `email:unverified:<address>`), cannot answer a pending input, and is never mailed: a channel with
  forwarders must set `replies` to `"none"` or `{"to"}`, or opt in with `settings.replyToForwarded: true`.
- Nothing changes for existing channels. `email_inbound` logs now also record what was accepted (`direct` or
  `forwarded`); `email_outbound` records replies not sent. Migration `066_email_thread_forwarded.sql` adds a column to
  `email_threads` ([Email](../guides/channels.md#email)).
