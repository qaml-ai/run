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
- Each speaker's audio is cut into utterances (`silenceMs`, default 800, of no packets or of quiet ones under -45 dBFS,
  as senders that never stop send encoded silence; quiet beyond 200 ms on each side trimmed and not billed; at most 30 s
  each; under 300 ms of speech dropped),
  packed as Ogg Opus (packets decoded only for their level, never re-encoded), and transcribed as `POST /v1/transcriptions` is: the same model and price per
  second, recorded as usage of the session's `subject` (`usage.recorded`, with `context.voiceSession`). Each transcript
  goes out as a `voice.utterance` webhook and, with `deliver.agent`, as a prompt to that agent from the speaker. A
  tenant out of credit ends the session (`budget`). Audio is never written anywhere; a session needs a transcription key.
- With end-user credits, a session's `subject` pays from its `bucket`: a subject with nothing left is refused at create
  (402 `END_USER_CREDIT`), each utterance's transcription is held before it is sent and settled with its cost, and
  running out ends the session (`budget`, `limit: "end_user"`, `endUserReason`).
- Discord's voice connections run on @discordjs/voice 0.19.2 with @snazzah/davey 0.1.12 for DAVE (a native module,
  prebuilt for linux arm64 and x64), loaded only when `AGENT_VOICE=true`; off by default. Endpoints must be Discord's
  (`*.discord.media`). A dropped voice socket is resumed or rejoined with the same credentials; a kick (4014, 4022) or
  credentials Discord no longer takes (4004, 4006, 4009, 4011) wait 15 s for new ones.
- SDKs: `agents.voice` (`runtime.voice`): `create`, `get`, `list`, `update`, `end`, in TypeScript and Python; the
  `voice.*` events in TypeScript's `WebhookEvent`. See [Voice calls](../guides/voice-calls.md).
- The simulator holds voice calls for some seeds (a simulated transport), checked by I23: every open session ends up
  held by its owner alone, on one connection, and an ended one by none.
- Migration 070.
