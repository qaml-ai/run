### Voice sessions

- camelRun can hold a Discord voice call for a tenant's bot: the tenant's app joins (OP 4 on its own gateway) and
  forwards what Discord answers to `POST /v1/voice/sessions`; camelRun connects and listens. `PATCH` hands it new
  credentials when Discord moves the call, `DELETE` ends it and answers the OP 4 that leaves the channel, `GET` reads
  one or lists them. One live session per bot and server; 10 live per tenant (`AGENT_VOICE_SESSIONS_PER_TENANT`).
- One node holds each session (actor `voice:<id>`); a retiring or draining node hands its calls to a peer, which
  connects again with the same credentials; a fenced node's calls are taken once its heartbeat expires. At most 200 per
  node (`AGENT_VOICE_SESSIONS_PER_NODE`).
- Sessions end on their own after `maxMinutes` (240), `idleMinutes` without speech (30), `emptySeconds` alone in the
  call (60), or when Discord stops taking their credentials and no new ones come within 15 s. Webhooks
  `voice.session.started` and `voice.session.ended` (with `reason`). The credentials are sealed and dropped at the end.
- Migration 070.
