# Release notes

Each runtime release is a `runtime-v<version>` tag, and the image `ghcr.io/qaml-ai/run:<version>`
(`latest` is the newest). Upgrade a self-hosted runtime by changing `AGENT_RUNTIME_IMAGE` and running
`docker compose up -d` (see [Self-hosting](self-host.md#upgrade)); read the notes for every version
between yours and the new one first.

## Unreleased

Changes on main since the last tag are in [unreleased/](unreleased/), a file for each change (so changes merged in
any order never conflict here), gathered into a version's notes when it is tagged: `npm run release-notes` shows them
together, and `npm run release-notes -- <version>` writes them here and removes the files.

## 0.11.3 (runtime-v0.11.3, 2026-10-19)

The published self-host image is 0.11.1 plus the image build fixes
([#292](https://github.com/qaml-ai/run/pull/292), [#293](https://github.com/qaml-ai/run/pull/293)):
use the Google mirror for base images and lock the shared Cargo registry cache during platform builds.
The 0.11.1 and 0.11.2 images failed to publish; self-hosted installations should use 0.11.3.

## 0.11.1 (runtime-v0.11.1, 2026-10-19)

End-user balance events for auto top-up and receipts, the Grok realtime voice provider, and concurrent index migrations for credit history. The TypeScript SDK 0.22.1 and Python SDK 0.18.1 use it ([SDK reference](../reference/sdk.md)).

**Before upgrading a self-hosted runtime:** migrations 075 and 076 run on start. Migration 075 builds the partial
`end_user_ledger_entries` index concurrently: it scans the whole ledger once while writes continue. The first new
node waits for the build before serving (up to 10 minutes); other starting nodes wait for the migration lock, and
nodes already running keep serving. Keep them available while the new nodes migrate. A file marked
`-- migrate: concurrently` now runs outside the migrations' transaction under a session advisory lock, between the
files before and after it. Runners poll for that lock without holding a blocking snapshot; an interrupted build's
invalid index is dropped and rebuilt on the next start. Migration 076 adds nullable or constant-default columns for
balance thresholds and allowance warnings without rewriting rows. Realtime voice stays opt-in; Grok needs `grok` in
`AGENT_VOICE_REALTIME` and an `xai` provider key (see [configuration](configuration.md)).

### Concurrent index migrations; an index for end users' credit history

- A migration whose first line is `-- migrate: concurrently` builds its indexes with `CREATE INDEX CONCURRENTLY`,
  outside the migrations' transaction, so a large table keeps taking writes while it builds
  ([architecture](architecture.md)). The runners' lock is now taken by polling, so a node waiting for it holds no
  snapshot that a concurrent build would wait for.
- Migration 075 builds `end_user_ledger_entries`, a partial index on `end_user_ledger (tenant, end_user, id)` for
  entries other than usage, that way: a person's credit history (`ledger?kind=grant,refund,adjustment`) and the entries
  in `GET /v1/end-users/{id}/days` read from their few entries however much usage they have. The first node of the
  release to start builds it before it serves; the build reads the whole ledger once.

### End-user balance events for auto top-up and receipts

- A person's own low-balance threshold: `PATCH /v1/end-users/{id} {"lowBalance"}` (null: the tenant's), shown in
  `GET /v1/end-users/{id}` as `lowBalance` and `overrides.lowBalance`. `GET /v1/end-users?belowLowBalance=true` lists
  the people under theirs. Migration 076 adds columns (nullable, or with constant defaults) and rewrites no rows.
- `end_user.balance.low` and `end_user.credit.exhausted` (`balance`) carry a `cause`: `usage`, `usage_correction`,
  `grant`, `refund`, `adjustment`, `refusal` or `threshold_changed`, with the ledger `entryId` (which orders a
  person's events), the tenant's `entryKey` and the run's `requestId`.
- Re-arm rules, now written down: a grant or a positive adjustment that leaves the balance short re-arms the event,
  so the first debit after a top-up that left someone under their threshold fires `balance.low` again. Setting a
  threshold above someone's balance fires it once (`threshold_changed`). Refunds stay silent. See
  [When balance events fire](../guides/end-user-credits.md#when-balance-events-fire).
- New events: `end_user.credit.granted`, `end_user.credit.refunded`, `end_user.credit.adjusted` (once per entry the
  tenant posts) and `end_user.allowance.low` (spend past the tenant's new `allowanceWarningPercent` of a bucket's daily
  allowance, once per person, bucket and day; off by default).
- A new guide: [Auto top-up on end-user credits](../guides/end-user-auto-top-up.md). The SDKs take `lowBalance` on
  `endUsers.update`, `belowLowBalance` on `list` and `allowanceWarningPercent` on `configure`/`amend`, and type the
  new events.

### Grok realtime voice provider

- Realtime voice sessions can choose `brain: "realtime"` with `realtime: {provider: "grok"}`, using `grok-voice-latest` by default (also
  `grok-voice-3.0`). Grok uses the shared OpenAI-compatible protocol, native transcripts and xAI voices; session
  voices are mapped to the nearest xAI voice. Turn-taking stays with camelRun and only its function tools are enabled.
- Enable `grok` in `AGENT_VOICE_REALTIME`; the provider uses the tenant's `xai` key, set through
  `PUT /v1/providers/xai/key`, or `platformKeys.xai`. `AGENT_GROK_REALTIME_URL` overrides the endpoint for a proxy or
  test. Usage settles against credit holds, and unpriced realtime models are refused. See
  [configuration](configuration.md).

## 0.11.0 (runtime-v0.11.0, 2026-10-19)

Voice sessions that speak (speech providers, a realtime brain in beta, browser calls, turn-taking and latency work), POST /v1/speech, and end-user credits ready for a credit page: per-bucket paid limits, refunds that never overdraw, write-offs past a call's hold, one reason code on every refusal path, ledger filters and per-day totals. The TypeScript SDK 0.22.0 and Python SDK 0.18.0 use it ([SDK reference](../reference/sdk.md)).

**Before upgrading a self-hosted runtime:** migrations 071 to 074 run on start (voice speech counts, per-bucket limits, model attempts' input estimates, end-user write-offs). Voice stays off unless `AGENT_VOICE=true`; the realtime brain is off by default. A queued run refused for a limit now ends with a coded result (`end_user_credit` or `spend_limit`) instead of `outcome.error` text, and the account's prepaid-credit 402s say `INSUFFICIENT_CREDIT` (they said `PAYMENT_REQUIRED`).

### End-user credits: credit history and per-day totals

A tenant's credit page no longer has to read usage rows
([guide](../guides/end-user-credits.md#the-ledger)):

- `GET /v1/end-users/{id}/ledger` takes `kind` (comma-separated: `grant`, `refund`, `adjustment`, `usage`), `from` and
  `to` (a range on `createdAt`, `to` exclusive), `bucket` and `moved=true` (only entries that moved the balance),
  combined with each other and with `before`/`limit`. Bad values are a 400.
- `GET /v1/end-users/{id}/days?from=&to=&bucket=&limit=`: a person's UTC days, newest first, paged by `next` (pass as
  `to`): per bucket, what allowances paid (`freeRaw`, raw cost) and what the balance paid (`paidCharged`, with the
  markup), and per day what the tenant's grants, refunds and adjustments moved. One query over the per-day spend rows and
  the person's own entries.
- SDKs: `endUsers.ledger(id, { kind, from, to, bucket, moved })` and `endUsers.days(id, { from, to, bucket, limit })`;
  Python `end_users.ledger(id, kind=, from_=, to=, bucket=, moved=)` and `end_users.days(id, from_=, to=, bucket=, limit=)`.

No migration.

### End-user credit: one reason code on every path

- A refusal or stop for an end user's credit says why the same way everywhere: `reason` (`balance`, `daily_limit`,
  `bucket_limit`), `bucket` and `endUser`, defined once in [Errors](../reference/errors.md#end-user-credit-reasons).
- A run refused as it comes to start in the queue now fails with a coded result, as one stopped mid-way does:
  `code: "end_user_credit"`, `stopped: "spend_limit"`, `limit: "end_user"`, `reason`, `bucket`, `endUser` (it was
  `outcome.error` text alone, `runtime_error` in the SDKs). The agent's or tenant's spend limit and spent prepaid
  credit refusing a queued run likewise give `code: "spend_limit"` with `limit` (`agent`, `tenant`, `credit`).
- A run stopped mid-way carries `bucket` and `endUser` too; a sub-agent's notification refused for credit as it lands
  ends its turn as `end_user_credit` with its reason (it read as the agent's own `spend_limit`).
- `run.failed` carries `limit`, `reason`, `bucket` and `endUser` with its `code`. `voice.session.ended` adds `bucket`
  beside `endUserReason`, which is now one of the reasons. `GET /v1/runs/{id}`'s error carries them as well.
- The account's prepaid-credit 402s say `INSUFFICIENT_CREDIT` (they said `PAYMENT_REQUIRED`).
- OpenAPI: the `Error` body declares `endUser`, `bucket`, `reason` and `refundable`; `END_USER_CREDIT` and
  `INSUFFICIENT_BALANCE` are listed codes; `end_user.balance.low` and `end_user.credit.exhausted` are documented events.
- SDKs: `AgentError` has `reason`, `bucket` and `endUser` (Python `end_user`) from any 402 (runs, stateless runs,
  transcriptions, speech, images, voice sessions); a run's error has `limit`, `reason`, `bucket`, `endUser`;
  `CREDIT_REASONS`, and `endUserCredit()` (Python `end_user_credit()`) to read them from an error or a run in one shape.

### End-user credits: per-bucket limits, refunds and fixes

- `bucketLimits` (the tenant's in `/v1/end-user-settings`, and each person's own in `PATCH /v1/end-users/{id}`), keyed
  as allowances are (`"bot:*"`), cap what one bucket may charge a person's balance per UTC day, holds included; 0 keeps
  a bucket to its free allowance. Past it, work is refused with reason `bucket_limit`, and `end_user.credit.exhausted`
  says so once per person, bucket and day (with `bucketLimit`). `GET /v1/end-users/{id}` shows each bucket's
  `paidLimit`. `PATCH /v1/end-user-settings` merges allowances and bucket limits key by key (SDK `endUsers.amend`). Migration 072.
- A refund entry returns at most the balance calls in flight do not hold (409 `INSUFFICIENT_BALANCE`, with
  `refundable`); a lowered cost is refunded at the rate it was paid, never more. A refund crosses the balance-low and
  out-of-credit thresholds silently.
- A model with no price is never free to end users: it holds and settles at the catalog's price, else a mid-range one,
  and logs `end_user_unpriced_model`. The markup applies over what a call costs the tenant on the platform's key.
- A queued run's start is checked against its own bucket, and runs that name no bucket (a schedule's, a notification's)
  spend from the agent's last one, not `default` (#167, #179).
- Holds size by what a call is likely to cost (cached input included), are renewed while a reply streams slowly, and a
  call that began before midnight UTC spends from the day it began (#182).

### End-user settings: concurrent writers keep each other's changes

- `PUT` and `PATCH /v1/end-user-settings` now write only the fields they send, in one statement, and a `PATCH` merges
  its `allowances` and `bucketLimits` keys into the map as it stands when the write lands. Before, each write read the
  row and wrote every field back, so a write that overlapped another (a node's `configure` at start while an operator
  changed `markupBps`, two `PATCH`es adding different keys) could silently undo it. See
  [End-user credits](../guides/end-user-credits.md#turn-it-on).

### End-user credits: costs past a call's hold are written off, never charged past a limit

A call that cost more than it held used to be charged in full to its end user's balance, past the bucket's paid limit
(a bot at `0` too), past the daily limit, and below zero. Settlement now charges at most what is left for the call (the
balance, the daily limit and the bucket's limit, less what other calls in flight hold), on the day its cost posts to.
The rest is written off: the tenant bears it, and the person is never charged it later
([guide](../guides/end-user-credits.md#costs-past-a-calls-hold-written-off)).

- `writtenOff` (raw micro-USD) on usage ledger entries, per bucket in `GET /v1/end-users/{id}` (`today.buckets`) and
  per bucket and day in `GET /v1/end-users/{id}/days`.
- A correction down takes back the write-off first, then refunds the balance, then the allowance; one up is capped the
  same way.
- The limit that capped a charge fires `end_user.credit.exhausted` once per day, as a refused call would (a bucket
  limit of `0` now fires `bucket_limit`). Each write-off logs `end_user_written_off`.
- Web searches, page fetches, tool searches, transcriptions and images settle the same way.

Migration `074_end_user_written_off.sql` adds three columns with a default of 0.

### A node short of memory starts no agents; work it cannot take goes to a peer

`AGENT_MEMORY_HIGH_BYTES` (unset by default; the hosted runtime sets about two thirds of its task's memory): above
it, a node starts no agent and takes no orphaned work, so inline agents cannot grow a node into its OOM kill. A run
the node refuses for its own limits (`AGENT_MAX_AGENTS`, or memory) is handed to a live peer instead of retrying where
there is no room. See [Persistence](persistence.md).

### Ops dashboard

- The team's admin site is now the ops dashboard, at https://run.camelai.com/ops, with Growth, Usage, Revenue and
  Health tabs and the earlier reports under Journeys. `AGENT_ADMIN_URL` (e.g. `https://run.camelai.com/ops`: https, a
  hostname, and no path or `/ops` or `/admin`) says where it is; under a path, the hostname may be one of the
  runtime's own. Only the path (308 to it with a slash) and the paths under it are the site's; everything else on the
  hostname is the runtime's. The page's scripts and styles load from `/console/assets/`, and every data request needs
  Cloudflare Access's token, as before. `AGENT_ADMIN_HOST` still names a hostname of its own; setting both fails the
  start, as does a runtime hostname without a path. See [Ops dashboard](admin-analytics.md).
- New read-only endpoints under the site's path, each for `?days=` UTC days (1 to 365) and logged with the viewer's
  email: `GET /api/growth` (sign-ups, activation, weekly active and returning accounts, the funnel, weekly cohorts),
  `GET /api/acquisition` (where sign-ups came from, from the journey store's `journeys` report), `GET /api/usage`
  (model responses, models, features, integrations, top accounts and agents, with admin tenants such as camelBot
  kept apart from self-serve accounts), `GET /api/account?tenant=` (one account), `GET /api/revenue` (purchases,
  refunds, credit held, free credit, with free credit counted as spent first), `GET /api/health` (the platform's
  provider spend and a projection of the month, and checks of the runtime's queues and jobs) and `GET /api/me`.
  `/api/stats`, `/api/product-signals`, `/api/activity-trend` and `POST /api/report` are unchanged.
- The account drill-down shows each live agent's setup and the first 1,500 characters of its system prompt, with what
  looks like a credential hidden, and its MCP servers by host only. The dashboard's API refuses cross-site requests
  (`Sec-Fetch-Site`), takes only Access tokens with an expiry, and runs at most two of its reads at once per node. Each view is logged as `admin_account_viewed` with the viewer and the tenant
  ([privacy](privacy.md#the-ops-dashboard)).
- `AGENT_ADMIN_EMAILS` (Terraform `admin_emails`, kept in the deployment's tfvars) names the admins: anyone else
  Cloudflare Access signs in gets a 403 for all of the site, logged as `admin_site_refused`. It is a second lock beside
  the Access policy, which should list the same addresses. Unset, whoever the policy admits may use the site.
- The dashboard leaves out staff: accounts journey events marked internal, and accounts whose Google or password
  address is at one of `AGENT_JOURNEY_INTERNAL_EMAIL_DOMAINS`, which the site reads even where journey events are off.
- Hosted: Terraform's `admin_hostname` is now `run.camelai.com` and the new `admin_path` is `/ops`, passed as
  `AGENT_ADMIN_URL`. On a runtime hostname `admin.tf` makes no certificate or DNS record, so applying removes
  `admin.camelai.dev`'s, and that address stops resolving; a plan with a runtime hostname and an empty `admin_path`
  fails. Add `run.camelai.com`, path `ops`, to the "camelRun admin" Access application first, and remove
  `admin.camelai.dev` from it afterwards. An image from before this change refuses to start with the new settings,
  and the deployment circuit breaker rolls it back ([deployment](admin-analytics.md#deployment)).

### Speech on its own: POST /v1/speech

- `POST /v1/speech` makes speech from text, in the voice a voice session would speak it in, and streams it back as it
  is made (`pcm`, 24 kHz mono 16-bit, or `wav`). It is billed as a session's speech is, per second made, against an
  end user's credit with `subject`. See [Voice and audio](../guides/voice.md#speech-on-its-own).

### Voice: in a group call, the bot answers the turns that are its own

- `addressing: {names, mode, conversationMs}` (src/voice/turns/floor.ts): with `names` (wake words), a turn is the
  bot's when it names it (near misses of long names, phrases, CJK without spaces), when its speaker is in a
  conversation with the bot (it answered them, or they named it, within `conversationMs`, 20 s; someone else naming it
  moves the conversation to them), or when no one else is in the call. Rules, not a model: language models pick a
  multi-party addressee near chance. `mode: "always"` (the default without names) is as before.
- The other turns still reach webhooks: `voice.utterance` has `addressed` and `addressedBy`. The agent gets them as
  context with the next turn that is the bot's. Prompt metadata has `addressedBy` when it is not `always`.
- With `agentReplies`, one reply at a time: a reply not yet heard when a newer turn's reply starts is taken back
  (`voice.speech.ended` `by: "superseded"`, log `voice_reply_superseded`), so rapid-fire turns get one answer.

### Voice: packets in order, losses concealed, speech that ends cleanly

- Each speaker's RTP packets go through a jitter buffer before decryption (`src/voice/jitter.ts`). In-order packets
  pass at once. A reordered packet is put back in order, and the buffer waits at most 60 ms (3 packets) for a missing
  one. A packet that arrives later than that is dropped.
- Lost packets (1-3 in a row) are concealed with libopus PLC in the audio streamed to live transcription, so its
  timing holds and the decoder does not jump. What is transcribed after the cut is still the packets as they came.
- Every speech ends with Discord's five silence frames, stopped ones included: before, an interrupt (barge-in, a new
  speech that interrupts, DELETE) cut the audio mid-frame and sent none, and a speech that ended on its own sent four.
  Speaking (op 5) is cleared after each one.

### Voice: a backchannel over the bot lets it go on

- Barge-in's echo guard also lets the bot go on when what was said over it is only a backchannel ("mm-hm", "yeah",
  "ok", "sí", "vale", "ja", "oui", "да", "haan", "嗯", "はい", "네"… about 20 languages; `BACKCHANNELS` in
  src/voice/echo-guard.ts), so a group's murmurs do not stop it. A partial transcript that is only a backchannel waits
  (it may go on: "yeah, but…" stops it). A backchannel judged so is not a turn: it never reaches `deliver.agent`, and
  its `voice.utterance` has `backchannel: true`. `bargeIn.backchannels` adds a session's own (up to 50); sessions show
  them in `interruption`.
- With `endOfTurn: smart`, a turn that ends with less speech than an utterance needs (300 ms: a cough, a click) ends
  the pause it made at once, not at `resumeMs`. Two people over the bot still hold one pause until both are decided.
- Logs: `voice_barge_in_echo_rejected` has `why: "backchannel"` and `why: "ended"`.

### Voice: barge-in ignores the bot's own voice coming back

- A person on laptop speakers without headphones sent the bot's speech back into the call, and barge-in stopped every
  reply about a second in. Barge-in now pauses first and checks (`src/voice/echo-guard.ts`):
  - After `minMs` (300) of speech over the bot, the media pauses playback at once, in its worker. The speech is kept.
  - The utterance's words (live partials, else its transcript) are compared with what the bot is saying and just said:
    matching words in the bot's order (60% or more, allowing small slips) is echo. Echo, or no words, **resumes** where
    it paused. Anyone else's words **stop** it (`by: "barge_in"`).
  - Speech going on for `confirmMs` (1000) after the pause stops it without the words (echo stops with the bot).
    `resumeMs` (3000) is the longest pause: it then stops if they are still talking, else resumes.
- `bargeIn` takes `true | false | {minMs, confirmMs, resumeMs}`; `confirmMs: 0` is the old behaviour (stop at
  `minMs`, no pause). Sessions show `interruption`. Existing sessions get the defaults.
- An utterance judged echo is not delivered to `deliver.agent` (no agent reply, no turn waits on it). Its
  `voice.utterance` webhook (and a browser page's `utterance`) is still sent, with `echo: true`.
- Sounds under `minMs` (a click, a cough) no longer stop the bot.
- Logs `voice_barge_in_candidate`, `voice_barge_in_confirmed` and `voice_barge_in_echo_rejected` (`why`, `pausedMs`,
  `speechMs`, `score`; never the words); metric `voice_barge_in` (`VoiceBargeIns`, `VoiceBargeInPausedMs` by `Outcome`
  and `Why`). `speech_played` has `heldMs.paused`.
- Media protocol: `resume` (control to media), and `barge_in` and `speech_progress` (media to control).

### Voice: calls from a browser

- `POST /v1/voice/sessions` takes `provider: "browser"`: a call from a web page, no Discord, through the same
  pipeline. The answer's `browser.url` and `browser.token` open its WebSocket (Opus or PCM in, the bot's speech out as
  Opus or PCM, and the session's utterance and speech events). Any node accepts the socket and relays it to the node
  holding the session. See [Voice calls](../guides/voice-calls.md#from-a-browser).
- `POST /v1/voice/sessions/{id}/browser-token` makes another token. A browser session may deliver to neither webhooks
  nor an agent.
- `ws` moves from devDependencies to dependencies (it was already installed, through @discordjs/voice).

### Voice: DAVE's group checked against the call

- After each transition of a voice connection's DAVE group, a member Discord's voice server never named (past 5 s)
  drops the connection, which joins again with a new group; a fourth drop in 5 minutes ends the session (`error`,
  `dave_roster`). davey 0.1.12 does not check a Welcome's roster (the check behind CVE-2026-104480). Metric
  `VoiceDaveRosterDrops`; log line `voice_dave_roster`.
- A retiring node releases its voice sessions before telling peers they are free, so a peer's scan takes them at once.

### Voice: a session moving between nodes keeps its Discord credentials

- A node letting a voice session go (draining, retiring, fenced) drops its Discord voice socket instead of closing it.
  A normal close (1000) ended Discord's voice session, so the node that took the call next was refused (4006, session
  no longer valid) and the session ended with `credentials` after 15 s. The DAVE roster check's rejoin drops its old
  socket the same way.
- When Discord stops taking a session's credentials, `voice.session.error` (`code: "credentials_needed"`, `waitMs`)
  goes out at once: the app sends OP 4 for the channel again and PATCHes what Discord answers, and the session goes on.

### Voice: replies sooner after people stop talking

- The speech provider's connection is opened when someone starts talking in a session that speaks, so the reply's
  speech does not wait to connect (about 90-180 ms saved on a cold connection).
- Live transcription, off by default (`AGENT_VOICE_LIVE_TRANSCRIPTION=true`): each speaker's audio streams to
  OpenAI's Realtime transcription (`wss://…/v1/realtime?intent=transcription`, `gpt-live-transcribe`, turn detection
  off) and each cut commits it. Measured live, it brought the text at most ~200 ms sooner than transcribing after the
  cut (sometimes later, on short utterances), at $0.017 a minute against $0.0045, so it stays off. A stream that fails
  (or a key scope with its own address) falls back to transcribing after the cut; `voice.utterance` is unchanged.
  `AGENT_VOICE_LIVE_MODEL`, `AGENT_VOICE_LIVE_DELAY` choose the model and its delay; `AGENT_PRICE_LIVE_TRANSCRIPTION_USD`
  its price. Logs: `voice_utterance` has `live` and `speechEndToTextMs`; `voice_live_transcription_failed` marks a
  fallback.
- `scripts/voice-check.ts` measures it: `speechEndToText` (after the cut, and per live model), each utterance's
  timing, `cutsAtSilenceMs` (how a sentence with pauses is cut at 500, 600 and 800 ms) and `warmMs`.

### Voice: each session's audio in a worker of its own

- A voice session's audio work (the Discord connection, DAVE, Opus, cutting utterances, playing speech) runs in a media
  worker thread, one per session by default, supervised by the node (`src/voice/media-host.ts`). A crash, a heap that
  runs out or a worker that stops answering for 5 s ends that session's audio alone: the session sends
  `voice.session.error` (`code: "media_crashed"`, `restarting`, `attempt`) and reconnects in a fresh worker. After 3
  failures in 5 minutes it ends (`error`). Agent turns, and every other session, are untouched.
- `AGENT_VOICE_ISOLATION=inline` keeps the audio on the node's thread, as before. `AGENT_VOICE_SESSIONS_PER_WORKER`,
  `AGENT_VOICE_WORKERS` (16) and `AGENT_VOICE_WORKER_MAX_MB` (256) size it ([Configuration](configuration.md)).
- New event `voice.session.error`; apps that select every voice event should handle it, or ignore it.
- Logs and metrics: `voice_worker_crashed` (`VoiceWorkerCrashes`, `VoiceWorkerCrashSessions`), `voice_media_crashed`
  per session.

### Voice: Opus without opusscript's wrapper, which corrupted memory and crashed the node

opusscript 0.1.1's JavaScript wrapper views each codec's PCM buffer at twice its address and size, so it wrote over
other codecs' memory, and its views detached when the WebAssembly memory grew. A busy node's codecs then trapped
("memory access out of bounds"), and one trap, in a decoder freed from a silence timer, ended the process. The runtime
now drives opusscript's libopus build itself (`src/opus.ts`): buffers allocated whole and viewed afresh on each call,
`delete` idempotent and never throwing, a codec that traps broken on its own (its module retired for new codecs). A
speaker whose decoder breaks has their utterance cut there and gets a new decoder; nothing in a speaker's audio path
or the silence timer can throw to the process.

### Voice: a smart turn's transcript is made while the turn waits to be sure

- With `endOfTurn: smart` and live transcription, a turn Smart Turn calls complete (`likely_end`, ~250 ms after the
  last word) commits its speaker's live stream then, so the transcript is made while the turn waits out `commitMs`. A
  speaker who goes on (`resume`) is committed again at the cut, and the parts are one transcript (billed as one; if
  either fails, the utterance is transcribed whole, as before). Silence after it is cleared, not sent.
- Measured with a 400 ms commit: the transcript ~235 ms sooner (729 ms from the last speech, against ~960 ms).
- `voice_turn_stats` when a session is let go: turns, likely ends, resumes and `discardRate` (likely ends spoken past:
  what speculative work started at likely_end would throw away), and the floor's counts.

### Voice: a realtime brain (beta), off by default

- A voice session may have `brain: "realtime"` (`"cascade"`, today's pipeline, is the default): a speech-to-speech
  model (OpenAI Realtime, `gpt-realtime-2.1` or `-mini`, or Gemini Live, `gemini-3.8-live`, each over a server-side
  WebSocket) hears the call and answers aloud,
  asking `deliver.agent` for anything beyond talk (`ask_agent`), and staying quiet when people talk to each other
  (`stay_silent`). See [Voice calls](../guides/voice-calls.md#realtime-brain-beta). Nothing changes for sessions that
  do not ask for it.
- It is offered only where `AGENT_VOICE_REALTIME` lists a provider (`openai`, `gemini`); unset, `brain: "realtime"` is
  refused (404). `AGENT_OPENAI_REALTIME_URL` and `AGENT_GEMINI_LIVE_URL` dial other addresses. The tenant's key for the
  provider is used (`openai`, `google`), else the platform's.
- Our media plane, Smart Turn, addressing and echo guard stay in front of the model: the call's per-speaker audio is
  mixed, with a note naming who speaks at each change (`speakers` names them); turns are committed by us (the
  provider's turn detection is off), with the answer begun at Smart Turn's likely end and held until the turn ends; a
  barge-in cancels the answer and truncates its item at what was heard.
- Billing: each answer's tokens at list price, as `usage.recorded` `kind: "speech"` (the model as `model`), and the
  inputs' transcripts (`gpt-transcribe`) as transcriptions; end-user credits hold $0.05 before each answer.
- Logs and metrics: `voice_turn_latency` with `Path=realtime` (and `VoiceRealtimeMs`, commit to the model's first
  audio), `voice_realtime_stats` and the `voice_realtime` metric line per session (turns, answers, ask_agent,
  stay_silent, barge-ins, speculation taken back), `voice_realtime_ask_agent` (`VoiceRealtimeAskAgentMs` by outcome).
  No words are logged.
- `scripts/voice-realtime-e2e.ts` measures it end to end on the bake-off's clips (one-on-one, 2-3 speakers,
  overlapping), against OpenAI (`OPENAI_API_KEY`) or Gemini (`--provider gemini`, `GEMINI_API_KEY`), or a stand-in
  provider (`--fake <ms>`). Gemini Live, measured through it: 0.89-0.92 s from the end of speech to the first packet
  with speculation, 1.35 s without (commit at Smart Turn's median 580 ms).

### A speech can name its voice for each speech provider

- `POST /v1/voice/sessions/{id}/speak` takes `voices`: this speech's voice for each speech provider, by provider
  (`{"elevenlabs": "<voice id>", "openai": "fable"}`). It wins over the session's `speech.voices` for that speech
  alone. Before, a speech's `voice` reached OpenAI only, so a session speaking through ElevenLabs could not change
  voice for one speech.
- SDKs: TypeScript `voice.speak(id, { voices })`; Python `speak(..., voices=…)`.

### Voice sessions can speak

- A session made with `speak: true` (its app joins un-muted: the answer's `join` says so) takes
  `POST /v1/voice/sessions/{id}/speak` `{text, voice?, instructions?, interrupt?}` (202, `speechId`, `position`) and
  `DELETE …/speak` (stop and clear). Speech is made with OpenAI's `gpt-4o-mini-tts`, streamed as PCM and encoded to
  20 ms Opus as it comes, so it starts playing before it is all made; one at a time per session, at most 20 waiting.
  `bargeIn` (default on) stops the bot when a person starts talking; `voice` sets the session's voice.
- Events `voice.speech.started` (`latencyMs`) and `voice.speech.ended` (`reason`: `done`, `interrupted` with `by`, or
  `error`; `seconds`, `costUsd`). Usage `kind: "speech"` at $0.015 a minute of speech made (`AGENT_PRICE_SPEECH_USD`),
  per second; end-user credits hold and settle it as transcription; running out ends the session (`budget`).
- Speech plays through a jitter buffer: it starts after 0.2 s of audio when OpenAI's stream comes at least 1.5x faster
  than it plays (measured over its first 100 ms), else after 1 s; after running dry it resumes with 1 s buffered,
  doubling at each further stall (to 4 s). The `speech_played` diagnostic has `startMs` (asked to first packet),
  `waitedMs` (refilling after stalls) and `gapMs` (silence inside the speech).
- Any node takes a speak request and passes it to the node holding the call.
- `speak: {agentReplies: true}` with `deliver.agent`: the session speaks the agent's reply to each utterance as it is
  written, sentence by sentence (streamed from the agent's node), markdown, links' addresses and code left out, at most
  400 characters; its speech events carry `reply: {agent, requestId}`. Barge-in stops the rest of a reply.
- A prompt's `speak: {session, voice?, interrupt?}` (`POST /v1/agents/{id}/prompt`, and agent clients' `prompt`/`submit`):
  its run's reply is spoken in one of the tenant's sessions that speak, as `agentReplies` speaks one, without
  `deliver.agent`, so an app can choose per utterance whether and which agent answers. Checked before the prompt is
  taken (404 unknown session, 409 `VOICE_SPEAK_DISABLED` or `VOICE_SESSION_ENDED`). A tenant key may name any of its
  sessions; an agent's own token only sessions whose `subject` is its agent's (else 403 `VOICE_SPEAK_FORBIDDEN`, also
  for an agent with no subject). The session's node follows the run
  on the agent's node (`/internal/agents/{id}/follow`, `/internal/voice/sessions/{id}/reply`).
- DAVE's send path: a Welcome into a group with a member the voice gateway never named is refused at once (opcode 31,
  then welcomed again), around @discordjs/voice's handling, as libdave checks it; speech goes out only while the group
  is ready and every member named.
- SDKs: `agents.voice.speak` and `stopSpeaking` (Python `speak`, `stop_speaking`); `speak`, `bargeIn` and `voice` on
  `create`. `scripts/voice-check.ts` now also has the listener speak and the other bot hear it (with `OPENAI_API_KEY`,
  OpenAI's speech, transcribed back; else a tone). Migration 071.

### Voice sessions choose their speech providers

- **Transcription chain.** `transcription: {providers, keyterms}` on `POST /v1/voice/sessions` streams speech to
  text as people speak through the named providers, tried in order:
  - Deepgram `nova-3`
  - Deepgram Flux `flux-general-en`: it detects turns itself, and its turn events go to the turn taker
  - Soniox `stt-rt-v3`
  - AssemblyAI Universal Streaming
  - OpenAI `gpt-live-transcribe`
- **Mid-utterance failover.** An utterance's audio is kept until its transcript arrives. If a provider drops, errs, or
  has not answered 3 s after the cut, the next provider gets the whole utterance. When all fail, the utterance is
  transcribed after it ends (OpenAI's `gpt-transcribe`, then the Azure deployment). OpenAI's live stream now carries
  prior-turn context: what was just said prompts the next utterance.
- **Speech chain.** `speech: {providers, voices}` speaks through ElevenLabs `eleven_flash_v2_5`, Cartesia `sonic-3`,
  Deepgram `aura-2` or OpenAI, each provider with its own voice. A provider that fails or is slow (3 s) before its first
  audio (silence does not count) is passed over for the next.
- **Runtime defaults.** `AGENT_VOICE_STT` and `AGENT_VOICE_TTS` set the chains a session gets when it names none
  ([configuration](configuration.md)).
- **Keys.** New key providers `deepgram`, `soniox`, `assemblyai`, `elevenlabs` and `cartesia` (`PUT
  /v1/providers/<id>/key`, `kind: "speech"`), plus `platformKeys.<id>` for the platform's.
- **Billing.** Each provider is billed at its list price, passed through (`src/voice-providers/prices.ts`,
  `AGENT_SPEECH_PRICES`): STT per second streamed, TTS per character. Usage records name the provider and model that
  served ([billing](billing.md)).
- **SDKs.** TypeScript `voice.create({ transcription, speech })`; Python `create(transcription=…, speech=…)`.

### Voice: no dead air between sentences; a reply's first audio at its first clause

- A session's next speech is made while the one before it plays, once that one is all made. A spoken reply no longer
  waits on a provider round trip between sentences: measured with a 300 ms first byte, the silence between sentences
  went from 322-343 ms to 22-26 ms. A speech made ahead and then stopped ends `interrupted`, billed for what was made.
- A reply's first piece goes as soon as a clause of it is whole (a comma, semicolon, colon or dash, at 24 characters
  or more, with more after it). The pieces after it are whole sentences.

### Voice: turn latency, measured stage by stage; utterance webhooks without the poll

- Each turn in a session that speaks writes one `voice_turn_latency` line: the time from the end of speech to the
  turn's commit, the final transcript, the agent's first token, the first piece queued, TTS's first audio and the first
  Opus packet out (`VoiceFirstPacketMs`, the headline), with `Path` `agent_reply`, `prompt_speak` or `speak` (the app's
  `POST …/speak` within 30 s of a transcript). Stages are as `src/voice/latency.ts` documents them.
- Tofu adds a `<name>-voice` dashboard and the `<name>-voice-turn-latency-p95` alarm (`voice_latency_p95_alarm_ms`,
  2,500 by default, in 3 of 4 15-minute periods with at least 20 spoken turns).
- `voice.utterance` webhooks are sent as soon as they are written, rather than at the outbox's next scan (every 5 s by
  default), which saved 2.5 s on average before an app could answer aloud.

### Voice: turns end when people are done talking, not after a fixed silence

- Voice sessions take `endOfTurn`: `smart` (the default where the runtime has the models) finds speech with Silero VAD
  and, at each pause, asks Pipecat's Smart Turn whether the speaker is done: done, the turn ends at `commitMs` (500 ms)
  of silence; mid-thought, they get up to `maxSilenceMs` (1.4 s). `silence` is the energy segmenter as before
  (`silenceMs`). `threshold`, `commitMs`, `maxSilenceMs` tune it per session; sessions show `endOfTurn`.
- Measured (`scripts/voice-turns-eval.ts`, 920 labelled turns, 23 languages): turns end 580 ms after the last word
  (median, against 816 ms), mid-thought pauses are held 87% of the time (against 1%), and noise is not speech.
- The models run in worker threads (src/voice/turns, onnxruntime-node on the CPU): about 40 ms of CPU per pause and
  0.1 core of VAD for 80 people talking at once, at most two threads (one Smart Turn thread by default; past its
  short queue a check is refused and the turn ends on silence), ~115 MB idle and ~190 MB working set. **Off unless
  the operator sets `AGENT_VOICE_TURN_MODELS=true`**: without it nothing is loaded, every session ends turns on
  silence and `smart` is refused. `AGENT_VOICE_TURN_WORKERS` sets the Smart Turn threads (default 1). onnxruntime's
  usage telemetry is off (`ORT_DISABLE_TELEMETRY`). Logs:
  `voice_turn_models_failed` (they did not load), `voice_turn_models_exited` (a thread died; it restarts).

### Model calls that end without usage are billed an estimate, not the whole context window

A model call that completed normally but reported no token counts and no cost (an OpenAI-style stream that ended between
its finish and its usage chunk) was billed on prepaid tenants as if it read the model's whole context window and wrote its
longest reply, and was free to end users on unbilled tenants and tenants' own keys. It is now billed as a call cut short
is: the input the host estimated at its begin (kept on the attempt, `estimated_input_tokens`) and the characters it
streamed at two a token.

- The tenant's ledger and the end user are charged that estimate, marked `estimated`. OpenRouter calls stay `estimated`
  and reconciliation replaces the estimate with the provider's figure; calls on providers with no reconciliation are
  final at the estimate.
- An end user is never charged more for an estimated call (completed or cut short) than the call held; with its hold
  gone, the estimate itself.
- Unbilled tenants and tenants' own keys charge their end users the estimate instead of nothing.
- Compaction summaries without usage use the same estimate in the run's accounting (`compaction_usage`).
- Each such call logs `model_usage_missing` once (tenant, provider, model, served host, completed or not, whether a
  generation id exists, billed and held). `infra/terraform/alarms.tf` adds the `model-usage-missing` metric filter
  and alarm (10 in 5 minutes); they take effect at the next `tofu apply`.

No migration (`model_attempts.estimated_input_tokens` exists since migration 073).

## 0.10.0 (runtime-v0.10.0, 2026-10-15)

End-user credits (a tenant's own users as billing subjects: balances, daily allowances by bucket, markup and daily
limits, enforced on every model call, with webhooks), Discord voice sessions (held, transcribed and delivered by
camelRun, paid for by end users), schedules without history and with backed-off retries, fetched credentials for tool
servers, structured model failures, platform models on Azure OpenAI, and compaction fixes. The TypeScript SDK 0.21.0
and Python SDK 0.17.0 use it ([SDK reference](../reference/sdk.md)).

**Before upgrading a self-hosted runtime:** migrations 064 to 070 run on start (schedule history and failures, durable
model attempts, email forwarding, end-user credits, voice sessions). End-user credits are off until a tenant turns
them on (`PUT /v1/end-user-settings`); voice sessions are off unless `AGENT_VOICE=true`.

### Platform images, transcription and chat models on Azure OpenAI

- An operator can send images and transcription made on the platform's OpenAI key to its own Azure OpenAI deployments
  (`AGENT_AZURE_OPENAI_ENDPOINT` and `AGENT_AZURE_OPENAI_API_KEY`, or `AGENT_AZURE_OPENAI_SECRET_ARN`; deployments
  default to `gpt-image-2.5-flare` and `gpt-transcribe`). A tenant's own key, an operator-set one and a key scope's stay
  on OpenAI. When Azure is rate limited, down or has no such deployment, the platform's OpenAI key makes it instead.
  Billing is unchanged. Azure's content filter refusals are `IMAGE_REFUSED`, as OpenAI's are. See
  [Configuration](configuration.md).
- Hosted: Terraform adds the `azure-openai` secret, its ECS environment variable and the task role's read of it;
  `infra/azure-openai.sh` stores the resource's endpoint and key and rolls the service.
- The same resource can serve the catalog's `azure/<model>` chat models (`azure/gpt-6-sol`, `azure/gpt-6-luna`, …) as
  platform models: `AGENT_AZURE_OPENAI_MODELS` (or `models` in the secret) names each model's deployment. Tenants on the
  platform's keys see those as available in `GET /v1/models` and are billed at OpenAI's price for the same model
  (Azure's Global Standard price); an undeployed one is refused with a clear error. `azure` models are now priced as
  OpenAI's of the same id, long-context tier included (Pi's entries lacked it). `scripts/azure-models-check.ts` checks
  the deployments with one minimal call each. `infra/azure-openai.sh` takes the models as a fourth argument.

### Compaction counts the system prompt once, and never summarizes nothing

- When to compact counted the system prompt twice once the provider had reported usage, since its report already
  includes it. Compaction then started about one system prompt's worth of tokens early.
- A compaction whose cut kept every message still made a summary call and wrote an empty summary. That changed the
  start of the context and made the provider write it all to its cache again. It is now skipped.

### contextTokens no longer summarizes on every turn

- After a compaction for `runLimits.contextTokens`, the next one waits until a quarter of the limit is new since the
  last. An agent whose system prompt, summary and recent messages nearly filled the limit was summarized again on
  almost every turn, and each summary made the provider write the whole context to its cache again.

### Smaller contexts, and a cached prefix that survives mount changes

- `runLimits.contextTokens` keeps each of an agent's model requests within that many tokens: older context is
  compacted below it, as it is below the model's window otherwise. On a large-window model a long-lived agent then
  stops paying to read its whole history on every request ([Context size](../guides/models-and-keys.md#context-size)).
- The system prompt the model saw first is pinned with the agent's first message. A change of mounts (or another
  configuration change) before the first change of prompt or tools now follows as a system message of its own,
  instead of rewriting the start of the context, which made the provider write the whole prompt and history to its
  cache again.

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
  `forwarded`); `email_outbound` records replies not sent. Migration `068_email_thread_forwarded.sql` adds a column to
  `email_threads` ([Email](../guides/channels.md#email)).

### End-user credits

- Tenants can charge their own users: `PUT /v1/end-user-settings` turns it on, with daily free allowances by bucket
  (`builder`, `bot:*`), a markup and a daily limit on paid spend. Each subject has a balance and a ledger
  (`/v1/end-users/{id}`, `/ledger`, `/entries` for grants, refunds and adjustments, idempotent by key). Agents take a
  `bucket`; so do `POST /v1/runs`, `/v1/transcriptions`, `/v1/images` and prompts sent with the API key.
- Every model call of a subject's work holds its estimate before it is made and as it streams; a run that runs out is
  refused (402 `END_USER_CREDIT`) or stops mid-reply (code `end_user_credit`, `reason` `balance` or `daily_limit`).
  Transcriptions and images hold and settle too; web search, page renders and tool search are charged as recorded.
- Webhooks `end_user.balance.low` and `end_user.credit.exhausted` (`allowance`, `balance`, `daily_limit`).
- Migration 069. SDKs: `agents.endUsers` (TypeScript) and `agents.end_users` (Python), `bucket` on upserts and stateless
  runs. See [End-user credits](../guides/end-user-credits.md).
- The simulator has an end-user scenario (one subject pays for every agent), checked by I22.

### Schedule deliveries back off, then move on

- A schedule whose delivery fails is retried 1, 5 and 15 minutes later (with the same request id, so a delivery that
  did reach the agent never runs twice), instead of every minute for ever. After that, or at once for a refusal a
  retry cannot change (a spend limit's or spent credit's 402, a 400 or 403), the occurrence is given up: a repeating
  schedule moves to its next occurrence and a one-off one is removed. Schedules list `failures` (occurrences given up
  in a row), `lastError` and `lastErrorAt` until a delivery succeeds; each failure is logged as
  `schedule_delivery_failed` ([Waking later](../concepts.md#waking-later)).
- A failed delivery no longer holds up the other wake-ups due in the same scan for a minute.

### Schedules without history

- A text schedule takes `history: "none"` (REST, the SDKs' `schedule`, the `schedule` built-in, `camelrun schedules
  add --history none`, the MCP server's `add_schedule`): each wake-up shows the model only the system prompt and the
  schedule's text, as a prompt's `history: "none"` does, so a periodic agent no longer reads an ever longer history on
  every run. The runs are still recorded in the history. Schedules list it as `history: "none"`; the default is
  unchanged ([Waking later](../concepts.md#waking-later)).

### Claude Sonnet 5.5 cache reads at Anthropic's price

- Fixes the known issue in 0.6.0's notes: Claude Sonnet 5.5's cache reads (`anthropic/claude-sonnet-5-5`, and through
  Cloudflare's AI Gateway) are priced at $0.10 per million tokens, Anthropic's price, not Pi's catalog's $0.20, for
  usage, spend limits, billing and `GET /v1/models`. Agents made before keep counting the right price too. On builder
  workloads (about 94% cache reads) Sonnet 5.5 responses were recorded about 29% above what Anthropic bills. Bedrock's
  entry is unchanged: Bedrock publishes no price for it yet.

### Model failures say how they failed

- A run that a model call failed has `errorClass` (`billing`, `rate_limit`, `server`, `refusal`, `auth`, `timeout`,
  `other`), `providerStatus` (the provider's HTTP status, when known), `retryable` (whether the runtime retries such a
  failure itself) and `model` (`provider/model-id`) on its `error`, beside `code` and `message`, which are unchanged.
  The `run.failed` webhook carries them too, and the stream's events for a failed response (`message_end`) and its
  retries (`auto_retry_start`, `auto_retry_end`) as `failure`. A fallback no longer has to parse the message for a 402
  or a 429 ([Model failures](../reference/errors.md#model-failures)).
- A run's result has `servedModel`, the model that made its last response; so do `run.completed` and `run.failed`.
- The `ErrorClass` metric dimension has a `refusal` class, and a quota used up that a provider sends as a 429
  (OpenAI's `insufficient_quota`) counts as `billing`, not `rate_limit`.

### Fetched credentials for tool servers

- An MCP server in a definition takes `auth: {"type": "exchange", "url", "audience"?}`: the runtime fetches the
  server's credential from an endpoint of yours, asking with an identity token it signs (audience the endpoint's URL,
  and an `exchange` claim naming the server), and calls the server with `Authorization: Bearer <token>`. The endpoint
  answers `{"token", "expiresAt"}` or `{"token", "expiresIn"}`. So a GitHub App installation token, an STS token or
  an OAuth access token can be used where only a long-lived personal token could. See
  [Tools](../guides/tools.md#fetched-credentials-auth-exchange), with a GitHub App as the worked example.
- A credential is kept in memory only, per agent and per node: never stored, logged, returned by an API or shown to a
  model. It is fetched again before it expires, calls made at once share one fetch, and a server that answers 401 or
  403 gets one request more with a new credential before the tool call fails.
- An exchange that is down, slow or answers wrongly makes its source unavailable for that call (`source_unavailable`,
  with what the endpoint did), and the turn goes on. Saving a definition asks for a credential as the definition, to
  list the server's tools: an endpoint that refuses or answers wrongly is a 400, one that is down is not.
- A `tool_credential_exchange` log line and metric (`CredentialExchanges`, `CredentialExchangeMs`, by `Outcome` and
  `Tenant`) for each fetch. `SourceAuth` in the TypeScript SDK has the new type.

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
  each; under 300 ms of speech dropped), packed as Ogg Opus (packets decoded only for their level, never re-encoded),
  and transcribed as `POST /v1/transcriptions` is: the same model and price per second, recorded as usage of the session's `subject` (`usage.recorded`, with `context.voiceSession`). Each transcript
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
- `infra/voice-check.sh` runs `scripts/voice-check.ts` (in the image) as a one-off task in the service's subnets,
  security group and public IP: two test bots in a voice channel, one listening through the runtime's transport and
  segmenter. Run it, and see it PASS, before turning voice on.
- Migration 070.

## 0.9.0 (runtime-v0.9.0, 2026-10-10)

Background sub-agents: messages between agents (`send_message`), `interrupt_agent` and a stop that reaches
running sub-agents, workers your tools prepare (`_meta["camelrun/spawn"]`), spend shares for sub-agents started
together, and notifications that are never lost (to a database error, an abort, or a node lost mid-delivery). Plus
start and fence fixes. The TypeScript SDK 0.20.0 and Python SDK 0.16.0 use it ([SDK reference](../reference/sdk.md)).

**Before upgrading a self-hosted runtime:** migrations 062 (`agent_children` kinds) and 063 (`agent_children.budget`)
run on start. Aborting an agent now aborts its running background sub-agents too; pass `children: "keep"` to keep
them. A node lost while delivering a sub-agent's notification now gives it up after two sweeps (30 s by default)
instead of a minute.

### Background sub-agents: messages and stopping

- `send_message` (with the `agents` builtin, and for any sub-agent the runtime made): a parent messages its sub-agent,
  which takes it in its running turn or starts a turn that keeps its history (a finished one works again and notifies
  again), and a sub-agent messages its parent (`to: "parent"`), which reads it as an `<agent_message>` block. The
  parent's stream has `subagent_message`. Message turns count against `AGENT_WAKES_PER_HOUR`; a turn sends at most 20.
  See [Messages](../guides/multi-agent.md#messages).
- `interrupt_agent` aborts one of the agent's sub-agents. Aborting a parent aborts its running background sub-agents
  unless `children: "keep"` (REST and the SDKs), and deleting it deletes the sub-agents the runtime made.
- A sub-agent that waits on a person notifies with `input_required`, and again when it resumes and ends.
- Browser tokens take a `children` scope: the agent's sub-agents' events, state, history and inputs.
- A notification or message turn refused at the wake cap or a spend limit stays refused on another node if its node is
  lost as the message lands. Migration 062 extends `agent_children`.

### Workers your tools prepare

- A tool from a server with auth "runtime" can start a background sub-agent for the calling agent: its result's
  `_meta["camelrun/spawn"]: { agent, task, name?, output? }` names an agent of the tenant the tool prepared, and the
  model's call answers `{ agentId, name }`; the worker's answer arrives as a notification. A busy worker queues the
  task. The SDKs build it: `spawnAgent(...)` (TypeScript, `@camelai/run/server` too) and `spawn_agent(...)` (Python).
  See [Workers your tools prepare](../guides/multi-agent.md#workers-your-tools-prepare).
- `agentNotice(message)` (Python `agent_notice`) tells sub-agents' notifications and messages apart in history, and
  `<AgentChat>` renders them as notices, not as the user's messages. `subagent_message` is in the SDKs' event types.

### Background sub-agents: shares, limits alone, notices

- A background sub-agent's run gets a share of its parent agent's spend limit: what no running sub-agent holds, split
  evenly among the slots `maxParallel` leaves. Sub-agents started together (by `spawn_agent` or a tool's spawn
  directive) share it rather than each getting all of it. Migration 063 adds `agent_children.budget`.
- `delegate: { maxParallel, maxDepth }` alone, without the `delegate` or `agents` builtin, bounds the sub-agents an
  agent's tools start (`camelrun/spawn`) without giving the model a tool to start them.
- SDKs: a notice (`agentNotice`, `agent_notice`, the chat's `UserChatMessage.agent`) carries the notification's
  structured `output`, its `usage` and the `inputs` it waits on; `SubagentView.status` includes `aborted`; and
  `createAgentHandler`'s `browserToken.scopes` chooses what its tokens read (add `children` for sub-agents).

### Background sub-agents: notifications are never lost

- A notification whose landing the database refused for now (a deadlock, a serialization failure, a statement timeout)
  failed its run and was lost: its landing is now tried again, as a run's start is.
- An abort of the parent cancelled a notification queued behind its turn, or ended one about to start, and the
  sub-agent's answer never reached history: it now lands without a turn (the run ends `aborted`).
- A node lost while delivering a notification held it for a minute; another node now takes over after two sweeps.

### A node that fails to start leaves the cluster

- A node joins the cluster (its heartbeat) before it listens. One whose port was taken, or that refused to run
  `AGENT_STORAGE=file` beside another node, used to exit with its heartbeat still live: peers counted it as a live
  peer (a retiring task could take it for its replacement, a draining one route work to it) until they found it dead,
  or for its whole lease when whatever held the port accepted their probes. It now leaves first, as a draining node
  does, so peers never see it.

### A run is no longer failed by a fence while its agent starts

- A node that lost an agent (it fenced itself, say after a database stall) while the agent's process was still getting
  ready to start went on and started it anyway, for an owner that was gone. The agent's next load, on that node once it
  rejoined, took that process for its own while it was still starting, and its first run failed with "Agent is not
  initialized": a queued run a drain or a deploy had left for the next owner failed instead of running. Such a start now
  gives up, and the next load starts the agent afresh. A stop while an agent starts now stops the start too.

### Fixes

- A run that an abort cancels while the runtime is still accepting it now gives its agent's busy slot back before the
  run is seen to end, as other cancelled, failed and finished runs already did. A client that started another agent's
  run as soon as it saw the cancelled one end could be refused with 429 `BUSY_AGENT_LIMIT` at its tenant's busy limit,
  for as long as the slot took to free.

## 0.8.0 (runtime-v0.8.0, 2026-10-09)

Images (`POST /v1/images` and the `generate_image` builtin, with image usage and billing) and background sub-agents
(the `agents` builtin: `spawn_agent`, `wait_agent`, `list_agents`, with exactly-once completion notifications). The
TypeScript SDK 0.19.0 and Python SDK 0.15.0 use it ([SDK reference](../reference/sdk.md)).

**Before upgrading a self-hosted runtime:** migration 061 runs on start (the `agent_children` and `agent_wakes`
tables). Image generation uses the tenant's OpenAI key (or a key scope's); the platform's key is billed at the prices
in `AGENT_PRICE_IMAGE_TEXT_INPUT_USD`, `AGENT_PRICE_IMAGE_INPUT_USD` and `AGENT_PRICE_IMAGE_OUTPUT_USD`.
`usage.recorded` consumers that switch on `kind` should map `image`. New settings: `AGENT_WAKES_PER_HOUR` (default
100) and `AGENT_CHILD_SWEEP_MS` (default 15 s).

### Images

- `POST /v1/images` makes images from a prompt, or edits up to 4 images given (base64, URL or multipart, with an
  optional mask), with OpenAI's `gpt-image-2.5-flare` on the OpenAI key a model call would use (a key scope's, the
  tenant's own, else the platform's). It takes `size` (`1024x1024`, `1536x1024`, `1024x1536`), `quality` (`low`,
  `medium` by default, `high`), `format`, `background` and `n` (1 to 4), and answers the images as base64, or, with
  `volumeId`, saves them in that volume and answers their paths. See [Images](../guides/images.md).
- On the platform's key it is billed per token at OpenAI's prices ($5 per million text tokens in, $8 per million image
  tokens in, $30 per million image tokens out: a 1024x1024 image is $0.0059 at `low`, $0.0132 at `medium`, $0.0527 at
  `high`), with spend limits checked against its estimate first. Usage kind `image`: a `GET /v1/usage` row, `image`
  and `images` on the hour's ledger entry, and `usage.recorded` events with `kind: "image"` and `images`. Operators
  set the prices with `AGENT_PRICE_IMAGE_TEXT_INPUT_USD`, `AGENT_PRICE_IMAGE_INPUT_USD` and
  `AGENT_PRICE_IMAGE_OUTPUT_USD` (per million tokens).
- OpenAI's safety refusals are 400 `IMAGE_REFUSED`, with the `stage` and `categories` it names, and are not charged.
  New codes: `IMAGE_UNAVAILABLE`, `IMAGE_REFUSED`, `IMAGE_TOO_LARGE`, `UNSUPPORTED_IMAGE`, `IMAGE_FAILED`.
- `usage.recorded` consumers that map kinds should map `image`; as before, treat a kind you do not know as other usage.

### generate_image builtin

- Agents, definitions and stateless runs take a `generate_image` builtin: the model makes an image, or edits images
  from its files, with `gpt-image-2.5-flare` (as `POST /v1/images` does). The image is saved to the workspace under
  `tool-outputs/generate_image/`, shown to the model, and presented to the user with `present_file`. A stateless run
  with it gets a workspace. See [Images](../guides/images.md#in-an-agent).
- Its images are billed per token like `POST /v1/images`, with the run's facts on `usage.recorded` (`kind: "image"`),
  and count against the agent's and the run's spend limits (checked against the estimate before anything is sent). A
  run's `usage.imageCostUsd` says what they cost, and a sub-agent's count toward its parent's spend.
- Saving a definition or an agent with `generate_image` and no OpenAI key to use answers with a warning; the console's
  definition editor offers it.

### Background sub-agents

- The `agents` builtin gives the model `spawn_agent`, `wait_agent` and `list_agents`, with the same `delegate` settings
  (targets, `maxDepth`, `maxParallel`). `spawn_agent` starts a sub-agent and returns `{ agentId, name }` at once. When
  the child's run ends (completed, failed, aborted or waiting on a person), its answer reaches the parent once, as a
  user message with `source: { kind: "agent", agentId, name }` that the model reads in an `<agent_notification>` block,
  and starts a turn or queues behind the running one. `wait_agent` waits for children instead, and answers their
  endings itself. See [Background sub-agents](../guides/multi-agent.md#background-sub-agents).
- Delivery is exactly once across node loss: each child has a row in the new `agent_children` table (migration 061),
  its notification has request id `child_<request>`, and every node sweeps for undelivered endings every
  `AGENT_CHILD_SWEEP_MS` (default 15 s).
- A child's spend is charged to its parent's spend limit when its notification lands. A parent at its spend limit, or a
  chain past `AGENT_WAKES_PER_HOUR` (default 100) turns started by notifications this hour, gets the notification in
  history without a turn: `stopped: "spend_limit"` or `"agent_loop_limit"`.
- Identity tokens of a sub-agent's run (from `delegate` or `spawn_agent`) carry `par` (its parent agent) and `root` (its
  chain's first agent); the SDKs read them as `identity.parentAgentId` and `identity.rootAgentId`
  (`parent_agent_id`, `root_agent_id` in Python).

### Journey events

- A journey secret that is named (`AGENT_JOURNEY_SECRET_ARN`) and has no value yet no longer stops the runtime from
  starting: journey events and the admin site's reports stay off until it has one, and the log says
  `journey_not_configured`. The Terraform module now makes the two secret containers (`journey`, `journey-report`),
  lets the task role read them and sets the journey settings from `journey_url` and the `journey_*` variables;
  `infra/journey.sh` stores the two values and rolls the service. See
  [Admin analytics](admin-analytics.md#connecting-the-journey-store).

### Images in the SDKs

- TypeScript: `agents.images.generate(prompt, options?)` and `agents.images.edit(prompt, images, options?)` (also
  `runtime.images`), with the `ImageOptions`, `ImagesResult` and `GeneratedImage` types; `Builtin` includes
  `generate_image`, `RunUsage` has `imageCostUsd`, and `usage.recorded` events type `kind: "image"` and `images`.
- Python: `agents.images.generate(prompt, ...)` and `agents.images.edit(prompt, images, ...)` (also `runtime.images`,
  and the synchronous clients'), images given as bytes, local paths or `{"url"}`. See
  [SDK reference](../reference/sdk.md#images).
- The CLI's MCP tools take `generate_image` among an agent's builtins.

## 0.7.0 (runtime-v0.7.0, 2026-10-09)

Pinned snapshots, labels, and snapshots made from contents, for projects as the store of record. The TypeScript SDK
0.18.0 and Python SDK 0.14.0 use it ([SDK reference](../reference/sdk.md)).

**Before upgrading a self-hosted runtime:** migration 060 runs on start (two columns on `volume_snapshots`). Nothing
else changes for existing data.

### Pinned snapshots and labels

- A snapshot can be pinned, at create (`pinned: true`) or later with `PATCH /v1/volumes/:id/snapshots/:id
  {pinned, labels}`. A pinned snapshot is kept until unpinned: publish's pruning passes it by, it counts against
  10,000 pinned snapshots instead of the 100 others, and `DELETE` refuses it (409) unless `?force=true`. Deleting a
  volume deletes its pinned snapshots too. Migration 060 runs on start.
- Snapshots take `labels`, a string map of your own (16 at most), set at create or by `PATCH`, and returned with them;
  `GET /v1/volumes/:id/snapshots?label=key:value` (repeatable) lists those that have them.
- `POST /v1/volumes/:id/snapshots {files}` makes a snapshot of the files given (path to text, or `{data}` in base64; at
  most 1,000 files and 16 MiB), leaving the volume and its seq untouched: for bringing in versions kept elsewhere. It
  is made whole or not at all, and answers each file's `sha256` (`contents`) to check against what was sent.
- SDKs: `volume.snapshot({ pinned, labels, files })`, `snapshots({ labels })`, `updateSnapshot`, `deleteSnapshot(id,
  { force })`; `project.publish({ pin, labels })`, `project.versions({ labels })`, `project.pin(version, labels?)` and
  `project.unpin(version)` (Python: the same, snake_case).

## 0.6.0 (runtime-v0.6.0, 2026-10-09)

Projects (keyed volumes, publish, restore, archives), files in tool calls, speech to text, an agent's own MCP servers,
history imported from Anthropic's and OpenAI's APIs, idle lifetimes and per-run limits, Bedrock API keys for the whole
account, and Pi 1.1 (Claude Haiku 5.5). The TypeScript SDK 0.17.0 and Python SDK 0.13.0 use it ([SDK
reference](../reference/sdk.md)).

**Before upgrading a self-hosted runtime:** MCP servers and OpenAPI sources without `auth: {"type": "runtime"}` are no
longer sent the agent's files (`{"$file": path}`); set `"fileArguments": "on"` on a third-party source you trust with
them. An agent given `mounts` now keeps its own workspace at /workspace beside them (`{"workspace": false}` leaves it
out). Bedrock takes Bedrock API keys only (as before: never AWS access keys). Migration 059 runs on start.

**Known issue:** Claude Sonnet 5.5's cache-read price is Pi's catalog price, $0.20 per million tokens, where Anthropic
charges $0.10, so cache reads on Sonnet 5.5 are billed at twice Anthropic's price on the platform's keys until Pi
fixes its catalog upstream; the runtime does not patch the catalog.

### Files in tool calls: call-bound URLs, directories, and which sources get files

- Breaking: a source is sent the agent's files only when its `fileArguments` is `"on"`. That is the default for
  sources with `auth: {"type": "runtime"}`; every other MCP server and OpenAPI source is now `"off"`: its tools are
  not offered `{"$file": path}`, and a `$file` argument is a tool error that tells the model file arguments are off
  for that tool. Set `"fileArguments": "on"` on a third-party source you trust with the agent's files. chiridion's
  and camel-bots' own servers use runtime auth, so they keep getting files.
- A file goes to a tool as a URL bound to the call, `GET /v1/files/{token}/{name}`, instead of a 15-minute signed
  link: its token is an EdDSA JWT the runtime signs with its identity tokens' key (`aud: "camelrun:file"`), naming
  the tenant, agent, call, tool and the file's version. It lasts 5 minutes, takes `Range`, and answers 410 once the
  file changes. Links an application signs (`POST /v1/agents/:id/links`) are unchanged.
- Parameters marked as MCP's SEP-2631 draft marks them (`format: uri` with `x-mcp-file: {accept, maxSize,
  transferModes}`) take files: `accept` and `maxSize` are enforced, and `transferModes: ["inline"]` sends a small
  file as a `data:` URI. With `x-camelrun-directory: true` a parameter takes a directory, sent as a manifest of a
  snapshot made for the call (each file with its own URL and sha-256, and a tar.gz of them all), at most 1,000
  files and 256 MiB.
- An MCP call carries `_meta["camelrun/files"]`: each file sent as a URI, by its argument's JSON pointer, with its
  name, type, size and sha-256.
- For sources with `fileArguments` on, `resource_link` results to `https:` or `data:` URIs are saved to the
  workspace like other tool outputs; the transcript keeps their paths.
- SDKs: `verifyFileUrl` (`@camelai/run/server`) and `verify_file_url` (Python, async and `camelai_run.sync`) check
  that a URL came from the runtime for the agent a tool expects; `testRuntime().fileUrl()` and
  `TestRuntime().file_url()` make one to test with. Sources take `fileArguments` in the SDKs' types.
- Snapshot names starting with `file-arg:` are the runtime's own.
- See [Files in tool calls](../guides/tools.md#files-in-tool-calls).

### Volumes: the workspace beside other mounts

- **Changed:** an agent's own workspace now stays at /workspace beside the `mounts` it is given (after them), for
  uploads, tool outputs and scratch files; before, given mounts replaced it. `{workspace: false}` among the mounts
  leaves it out (`[{workspace: false}]` is no mounts at all; `[]` is now the workspace alone), `{workspace: true}` puts
  it at that position, and a mount given at /workspace takes its place. Stateless runs are unchanged: their own
  mounts are all they get. Chiridion (default workspace) and camel-bots (/bot beside the workspace) need no change.
- `remount: true` on an upsert sets the mounts it gives (between the agent's turns), where other mounts are a 409.
  SDKs: `upsert(key, { mounts, remount: true })`, Python `remount=True`.
- Fix: an agent whose mounts no longer include its own workspace (changed with `PUT /v1/agents/:id/mounts`) left that
  volume behind when it was deleted. It is deleted with the agent now.
- The SDKs' `createVolume({ name }, { idempotencyKey })` and Python `create_volume(idempotency_key=…)` send an
  `Idempotency-Key`: the same key makes the volume once (for a day).
- Docs: where uploads, tool outputs and scratch files go; deleting an agent takes your API key, never its own token.

### Volumes: the agent's workspace at a path of its own

- `{workspace: true, path: "/scratch"}` mounts the agent's own workspace at that path, so a project volume can sit
  at /workspace beside it. Attachments (`uploads/<request>/`), tool outputs, saved long tool results, the prompt's
  environment text and js_exec's example all follow the workspace wherever it is; forks keep it at the same path.
  The path must be absolute, normalized and clear of the other mounts. SDK types: `MountInput` (TypeScript), `Mount`
  and `WorkspaceMount` (Python).

### Mount changes during a turn

- Fix: mounts changed while the agent was running (`PUT /v1/agents/:id/mounts` mid-turn, or an upsert's
  `remount: true`) never reached its prompt: its environment text named the old mounts until the agent happened to
  restart. Now the next run restarts it with the current mounts, and its prompt describes them.
- Mount changes apply at the agent's next tool call (a call under way keeps the mounts it began with): a removed
  volume is refused, a read-only one is read-only, an added or swapped-in one is usable at its path. MCP and other tool
  outputs follow too; before, they could still be saved to a volume unmounted since the agent started.
- Fix: forking an agent whose workspace was left out (`{workspace: false}`) gave the fork a new workspace at
  /workspace.

### Projects

- `POST /v1/volumes {key}`: the tenant's volume for a key, made the first time and the same one every time after
  (`existing: true`), for as long as it lives; a deleted one's key makes no other. SDKs: `createVolume({ key })`,
  Python `create_volume(key=)`.
- TypeScript SDK: `runtime.projects.create({ key, template })`, `project.mount(path)`, `project.publish({ validate,
  store })` (snapshot, read every file at it, check, store; the snapshot is the version), `project.versions()`, and
  `publishTool(...)` for `serveTools`, which finds the project from the call's identity. Python: `camelai_run.projects`
  (`Projects`, `publish_tool`). See [Projects](../guides/projects.md).

### Projects: restore in place, and checks that hand on what they computed

- `POST /v1/volumes/:id/restore {snapshot}` makes a volume as a snapshot of it was, in place: files the snapshot
  lacks are removed and files that differ are written back, in one write, each a change agents mounting it see.
  SDKs: `volume.restore(snapshot)`, and `project.restore(version)` for a published version.
- `GET /v1/volumes/:id/archive?snapshot=&path=&glob=` streams a volume's files (or a snapshot's) as a tar.gz, named
  relative to `path`, at most 10,000 files and 1 GiB. SDKs: `volume.archive(...)`, `project.archive({ version })`.
- A project's `validate` may return `{problems, data}`: `data` reaches `store` as `checked` and comes back in the
  publish result (and `publishTool`'s `published`), so what the check computed (a bundle, its manifest) is not
  computed again. Both SDKs.
- The projects guide shows `publishTool`'s `project(identity)` for an agent whose mounts change during its life: look
  up its current mounts (`runtime.mounts(identity.agent)`).
- Fix: `publishTool` called by a client that sends no idempotency key (`_meta["agent-runtime/idempotencyKey"]`) took
  the JSON-RPC id as the publish's key, so a later call with the same id (every call of `testRuntime().callTool`,
  which sent id 1) stored the first publish's files again. Only a key that outlives the request dedupes now, and
  `callTool` / `call_tool` send a fresh key per call (`idempotencyKey` / `idempotency_key=` to repeat one). Both SDKs.

### Reading many files at once, and snapshots

- `GET /v1/volumes/:id/files?content=true` returns every matching file with its contents in one answer, as the
  volume was at one seq: `{seq, files: [{path, size, version, contentType, sha256, text | data}]}`, at most 1,000
  files and 16 MiB (else 413). SDKs: `volume.readAll({ prefix, glob, snapshot })`, Python `read_all`.
- `GET /v1/volumes/:id/changes?prefix=` keeps the changes at or under a path, and `GET /v1/volumes?ids=a,b` returns up
  to 50 volumes as they are now, each with its seq (SDKs: `changes(since, { prefix })`, `runtime.volumes(ids)`).
- `snapshot=` reads a snapshot: on the listing, on `content=true`, and on `GET /v1/volumes/:id/files/{path}`
  (SDKs: `list`, `read`, `readAll` take `snapshot`).

### Runtime

- Speech to text. Audio attached to a message (a voice note, a recording) is transcribed before the message is
  accepted, and the model reads the transcript, so every model hears it; history keeps the audio file with its
  transcript. A file of type `audio/*` is transcribed by default (`transcribe: false` keeps it a plain file; `true`
  asks for any file); a message with audio needs no `text`. Files attach by URL too (`{url}`, fetched through the
  outbound guard). `POST /v1/transcriptions` transcribes audio alone (multipart, base64 or a URL; `language`,
  `prompt`). It runs on OpenAI's `gpt-transcribe` with the tenant's OpenAI
  key as model calls resolve it, else the platform's: $0.0045 a minute, per second, on prepaid credit. Ogg (Opus,
  Vorbis), WebM, MP3, M4A/MP4, WAV and FLAC, 25 MB and 30 minutes a file, 5 files and 30 minutes a message.
  Transcriptions count toward spend limits, monthly caps and credit, and are `usage.recorded` events with the new
  `kind: "transcription"` (and `audioSeconds`; `agentId` is null for one made alone): a consumer that switches on
  `kind` should treat an unknown one as other usage. Channels' voice messages and audio files are transcribed with no setup. See
  [Voice and audio](../guides/voice.md).
- `maxOutputTokens` and `temperature` on agents, definitions, `PATCH /v1/agents/:id/configuration` and stateless
  runs: the most the model writes in one response (at most its own maximum), and its sampling temperature (0 to 2).
  A temperature the model would refuse is a 400 where it is set: Claude Opus 4.7 and later, Sonnet 5.5 and Fable,
  models that always reason (o-series, GPT-5), and any reasoning model at a `thinkingLevel` other than `off`. Set on
  an agent from a definition, both stay its own when the definition is applied. Compaction summaries keep the
  runtime's settings. See [Output length and temperature](../guides/models-and-keys.md#output-length-and-temperature).
- `mcpServers` on agents without a definition (`POST /v1/agents`, upserts, `PATCH /v1/agents/:id/configuration`)
  and on stateless runs: MCP servers of their own, without credentials (`auth: {"type": "runtime"}` or none; a token
  or headers is a 400 that says to use a definition). They count toward an upsert's `configHash`, a fork copies
  them, and `GET /v1/agents/:id` shows them. An agent from a definition refuses them. OpenAPI specs stay in
  definitions. See [An agent's own MCP servers](../guides/tools.md#an-agents-own-mcp-servers).

### Lifetimes, limits and tool servers, for products built on the runtime

- `idleTtlSeconds` on agents and definition `limits`, instead of `ttlSeconds`: the agent lives that long (60 seconds
  to 366 days) from its latest run, so one in use is kept and one left alone expires. With `ttlSeconds` it is a 400.
  Both SDKs: `idleTtlSeconds` / `idle_ttl_seconds=` on `createAgent`.
- `runLimits: {maxResponses?, maxSeconds?}` on `POST /v1/agents/:id/prompt`: that run's own limits, applied only
  where lower than the agent's (or the runtime's). Both SDKs take `runLimits` / `run_limits=` on `run`, `stream`,
  `prompt` and `send`.
- A run stopped by a spend limit says which: `result.limit` is `run`, `agent`, `tenant` (the monthly cap) or
  `credit`.
- Applying a definition (`apply: "all"`, or `applyOnUpdate`) drops the tool lists the runtime holds for its MCP
  servers, so the agents it reaches see a server's new tools at once instead of within the cache's lifetime.
- Identity tokens carry the run's request id (`req`) and the model's tool call id (`tcid`) during a turn: the SDKs'
  `identity.requestId` and `identity.toolCallId` (`request_id`, `tool_call_id`). A tool can tie its work to the run
  that asked for it, or make a tool call idempotent.
- `GET /v1/agents/:id/events?request=<id>` (and `/clients/:id/events`): only that request's events and its response.
- Both SDKs: `agent.send(text, options)` sends a message without waiting for its run (`{id, state}`, the prompt's
  202), and `agent.wait(id)` gives the run later; `AgentClient.submit` / `client.submit` is the same one level down.
- `serveTools` / `serve_tools` take a function of the caller's identity instead of the tools, so each agent can be
  offered its own; a tool it is not given is refused. A `ToolServer`'s `listTools(context)` gets
  `{identity, origin, signal}`.
- The TypeScript SDK's `DefinitionInput` has `runLimits` (the API took it already). The Python SDK's definition
  methods take each field's Python spelling too (`run_limits=`, `system_prompt=`, `mcp_servers=`), besides the REST
  name.

### Importing conversations from other APIs

- `importMessages: {format, messages, model?}` on agent creates and upserts: a conversation in Anthropic's Messages
  format, OpenAI's Responses input items or Chat Completions messages, tool calls and results included, converted
  to the Pi messages the agent begins with. Reasoning goes back to the model that wrote it (`model`) as it came, and
  to any other as text. Python: `import_messages=`; TypeScript also exports `toPiMessages` to convert one locally.
  See [Bringing in existing conversations](../guides/multi-user.md#bringing-in-existing-conversations).

### Tool servers that move

- An MCP server's or OpenAPI source's `audience` (auth `runtime`) may be a name of the tenant's own,
  `urn:camelrun:<tenant>:<name>`, besides a URL on the server's origin: tokens keep naming it when the server moves
  to another URL or domain. Another tenant's name, like another origin's URL, is a 400. `serveTools` and
  `verifyRuntimeToken` (both SDKs) already take a list of audiences, for accepting an old and a new URL while agents
  move. See [A server that moves](../guides/tools.md#a-server-that-moves).

### Definitions that reach live agents

- `applyOnUpdate: true` on a definition: every save that makes a new revision (an upsert that changes it, or a
  `PATCH`) also applies it to every live agent made from it, as `apply: "all"` does, and the answer carries
  `applied` (`POST /v1/definitions` answers with it too). An upsert that changes nothing applies nothing. See
  [Definitions](../guides/definitions.md).

### Bedrock API keys for the whole account, and their region

- `PUT /v1/providers/amazon-bedrock/key` takes `{apiKey, region}`: an account's own Bedrock API key (a bearer token)
  and the AWS region its calls go to (it was refused as needing AWS credentials). The console's Models page asks for
  the region, and `GET /v1/providers` shows it. Migration 059 runs on start.
- Fix: a key scope entry's Bedrock `region` now reaches the call. Before, Pi's client took the region from the
  runtime host's `AWS_REGION` (or the catalog's `us-east-1`), unless the entry's `baseUrl` was a regional endpoint.
- Bedrock takes Bedrock API keys only: no AWS access keys or SigV4, never the host's AWS credentials. See
  [Amazon Bedrock](../guides/models-and-keys.md#amazon-bedrock).

### Pi 1.1: Claude Haiku 5.5, Bedrock inference profiles

- The runtime runs on Pi 1.1 (`@earendil-works/pi-ai` and `pi-agent-core` 1.1.0). New in the catalog: Claude Haiku 5.5
  (`anthropic/claude-haiku-5-5`, and on Bedrock `amazon-bedrock/global.anthropic.claude-haiku-5-5` and its `us.`,
  `eu.`, `au.` and `jp.` profiles), and Claude Sonnet 5.5's `us.` and `eu.` profiles on Bedrock. Haiku 5.5's prompts
  over 100,000 tokens are priced higher, as Anthropic prices them.
- Bedrock serves Anthropic's models only through inference profiles: a base id (`amazon-bedrock/anthropic.claude-sonnet-5`)
  is no longer listed in `GET /v1/models`, and an agent that names one is called through its global profile (its US
  one where it has no global one).
- A Claude model that always reasons on Anthropic's API does on Bedrock too (Haiku, Sonnet and Opus 5.5, Opus 5,
  Fable): a call asking for no reasoning gets the least it takes, as on Anthropic.
- History's assistant messages carry `durationMs` (how long the response took) and tool results theirs (how long
  the tool ran) ([events](../reference/events.md)).
- Context estimates count 3.5 characters a token (4 before), so compaction starts a little earlier on text-heavy history.
- Anthropic tool changes mid-conversation use the `inline-tools-2026-09-15` beta; Bedrock's Claude 5 calls bind thinking to
  their prompt, dropping stale thinking blocks after the tools or system prompt change instead of failing.
- The provider `azure-openai-responses` is now `azure`, as Pi names it.

### File tools without versions

- The model's file tools (`read`, `write`, `edit`, `ls`, `present_file`, and `fs` in `js_exec`) no longer show file
  versions, and `write` and `edit` no longer take one. The runtime remembers the version of each file the agent last
  read or wrote, and refuses a write or edit of a file that changed since then: "<path> changed since you last read
  it. Read it again". Writing a file only if it does not exist yet (`version: 0`) is gone from the model's tools.
  The files API and the SDKs' volume and file calls keep versions and `If-Match`; `run.files` keeps its versions.

### Faster chat loading

- `watchAgent` and `createAgentChat` (`@camelai/run`) read pending inputs while the event stream opens, and history
  and state together once it has: opening a chat takes three round trips (token, stream, history and state) where it
  took five. Their state has `loaded` (`ChatSnapshot.loaded`): true once history and state are read, so a UI shows
  a loading state, not an empty chat, before it. The React kit's empty state waits for it.

### Imported history

- Fix: an imported assistant message without `usage` (which the guide says is optional) could fail the agent's next
  run ("Cannot read properties of undefined (reading 'totalTokens')"). Imported messages now get what they leave out:
  a timestamp, an assistant message's `usage` (zero) and `stopReason` (`toolUse` when it calls tools), a tool
  result's `isError` (false).

### Fixes

- An answered input (an approval, an `ask_user` answer, a tool's own question) is no longer lost when the node running
  its resume is lost just as the resume starts. The next owner found the turn still suspended and ended the resume
  `input_required` with no inputs, so an approved call never ran and the agent waited for an answer no one could give.
  The resume now runs again from its answers there: an approved call runs once. A call the agent had already released
  to run still ends as of unknown outcome and is never run again.
- A run whose node is lost after its turn ended, but before the run recorded its end, now ends on the next owner with
  the turn's reply (and structured output) from history. A prompt in that window used to end `uncertain` ("The runtime
  restarted during this request") though its reply was written, and a resumed approval or answer completed with no
  `reply`.

### TypeScript SDK

- `maxOutputTokens` and `temperature` on `agents.upsert`, `agents.run`, definitions and `agent.configure` (`null`
  removes either there).
- `mcpServers` on `agents.upsert`, `createAgent`/`upsertAgent` and `agents.run` (`InlineMcpServer`: no credentials).
- `agents.transcriptions.create({ file | url, language, prompt })` (also `runtime.transcriptions`); attachments take
  `{ url }` and `transcribe`, and a message with audio may have no text. See [Voice and audio](../guides/voice.md).

### Python SDK

- `camelai_run.sync`: a synchronous client with the same names (`Agents`, `Agent`, `AgentRuntime`, `Runs`) for
  scripts, Django and Flask views and Celery tasks: upsert, get, fork, run, stream, steer, answer inputs, stateless
  runs. It holds no connection, so it does not serve tools from its own process and has no `on_event` or `on_input`;
  it also has no volumes, no `create_agent` and no `client.steer` (use the async client for those). See [the synchronous client](../reference/sdk.md#the-synchronous-client-python).
- `camelai_run.sync.serve_tools` serves tools as a WSGI app (Django, Flask), plain functions in the request's thread;
  `camelai_run.sync.verify_runtime_token` and `TestRuntime` are its synchronous token check and test runtime.
- `verify_webhook(body, headers, secret)` verifies a webhook request (Standard Webhooks signature, constant-time,
  within 5 minutes) and returns its event.
- `initial_messages=` on `agents.upsert` and `create_agent`: the history an agent begins with.
- `mcp_servers=` on `agents.upsert` (async and sync), `create_agent`, `upsert_agent` and `agents.run`: MCP servers
  of the agent's or run's own, without credentials.
- `max_output_tokens=` and `temperature=` on `agents.upsert`, `create_agent`, `agents.run` and `configure` (`None`
  removes either there); definitions take `maxOutputTokens` and `temperature` as fields.
- `AgentRuntime` manages key scopes (`set_scope_key`, `key_scope`, `set_scope_provider`, ...), API tokens
  (`tokens`, `create_token`, `revoke_token`), usage (`usage`), webhook endpoints (`create_webhook`, `webhooks`,
  `update_webhook`, `delete_webhook`, `rotate_webhook_secret`) and agent tokens (`rotate_agent_credentials`).
- `transcriptions.create(file or url=…)` on `Agents` and `AgentRuntime`, async and in `camelai_run.sync`; attachments
  take `{"url"}` and `"transcribe"`, and a message with audio may have no text.

### Admin site

- `GET /api/activity-trend` on the admin site, for its chart: sign-ups and returning active accounts by UTC day over
  the `days` days (14 by default, 90 at most) that end on `end_date` (today by default). A returning active account
  is one made before that day whose agents got at least one model response on it (`usage`); the days are UTC because
  that is how usage is kept. `incomplete_date` names the day still going.
- `POST /api/report` also takes `kind: "pages"` (dates only), for the journey store's report on the operator's
  website pages about the runtime.

## 0.5.0 (runtime-v0.5.0, 2026-10-08)

Stateless runs, steer receipts and stops that cancel the queue, faster resume, js_exec on V8, and email and
password sign-in. The TypeScript SDK 0.16.0 and Python SDK 0.12.0 use it ([SDK reference](../reference/sdk.md)).

**Before upgrading a self-hosted runtime:** deploying it signs everyone out of the console once; signing in to
the console with an API or operator token is gone (set a password with the operator token first, see
[Self-hosting](self-host.md#sign-in-to-the-console)); a runtime with `AGENT_BILLING_EMAIL_PROVIDER=cloudflare` or a
tenant `codeEngine` other than `v8` does not start; `AGENT_SANDBOX_PROCESSES` and `AGENT_CODE_WORKERS_MIN` are
removed and `AGENT_SANDBOX_SOCKETS` is now `AGENT_SANDBOX_DIR`. Migrations 050 to 058 run on start.

### Stateless runs

- `POST /v1/runs`: a configuration (an agent's fields, or a `definition`) and an input in, the result out, with
  nothing carried over and no agent kept. `wait` answers once it ends; `GET /v1/runs/{id}` (`?wait=25`),
  `/events` (resumable with `Last-Event-ID`), `/messages`, `POST /v1/runs/{id}/abort` and `DELETE` follow it.
  Its result is kept for `retentionSeconds` (a day by default). A run with no tools gets neither `js_exec` nor
  file tools unless it asks. Runs count against runs per minute and busy agents, not agent creates, and are as
  durable as an agent's. See [Stateless runs](../guides/stateless-runs.md).

### Steer receipts, stops that cancel the queue, stalled model streams

- A prompt with `whileRunning: "steer"` is answered at once (`steer: "accepted" | "queued"`), and its request
  completes when the running turn takes the message (`steeredInto`, and a `steer_taken` event), not when the turn ends.
- A stop (`POST /v1/agents/:id/abort`) also cancels the runs queued behind the running turn (code `cancelled`,
  `run_cancelled` events) unless `queued: "keep"`, and answers with their ids (`cancelled`).
- A model request that sends nothing before its first token (120 s; 300 s for a reasoning model at `thinkingLevel`
  high and up) or goes quiet for 45 s is ended as stalled and retried; past every retry the run fails with code
  `model_stream_stalled`. `runLimits.firstTokenSeconds` and `idleSeconds` set an agent's own
  ([Limits](../reference/limits.md)).

### Reconnect hint on purposeful closes

- A stream the runtime closes on purpose (a drain, a retiring node, an idle agent released, an agent now
  served elsewhere) ends with `event: reconnect` (`{type: "reconnect", reason: "drain" | "moved", retryMs: 0}`,
  `retry: 0`), and the SDKs reconnect at once with `Last-Event-ID` instead of backing off
  ([events](../reference/events.md#event-reconnect)).

### Free-tier limits

- Free credit's busy agents 8 → 20 and runs 60 → 240 a minute; paid limits are unchanged.
- Agent creates are limited only against abuse: 600 a minute for every account, free credit included (it
  was 10 free, 60 paid); `AGENT_RATE_LIMIT_AGENT_CREATES` and `AGENT_RATE_LIMIT_FREE_AGENT_CREATES` still set it.
- `BUSY_AGENT_LIMIT` and a free account's runs 429 say what buying credit unlocks ("$5 more of credit
  unlocks Tier 1: 50 busy agents"); `GET /v1/billing` adds `runsPerMinute`, and the console shows both.

### Builder DX: fresh runs, forced structured output, no-op upserts, rate-limit headers, lean prompts

- A prompt's `history: "none"` shows the model the system prompt (as it stands) and that message only.
  The run is recorded as usual (its user message carries `history: "none"`) and later runs see it; no
  background compaction follows such a run. See [Runs without the history](../concepts.md#runs-without-the-history).
- Structured output forces `final_output` with the provider's own `tool_choice`: from the first request
  when it is the model's only tool, and on the output reminder otherwise; never with Anthropic thinking on;
  a provider that refuses it is asked again unforced; at most three forced requests a run
  ([Forcing the tool](../guides/structured-output.md#forcing-the-tool)).
- `codeMode: false` on agents, upserts and definitions: no `js_exec`, every tool direct, and the runtime's
  prompt text only for the tools the agent has; with `fileTools: false` and no tools, none but a sender note
  (about 2,000 input tokens down to a few hundred). The default prompt is unchanged, byte for byte.
- An upsert whose configuration equals the agent's is not counted against `agent_creates`. Creates,
  upserts, list, `GET /v1/agents/{id}` and `credentials` return `configHash`.
- Creates, forks and runs answer with `X-RateLimit-Limit`, `-Remaining` and `-Reset` (seconds; windows
  align to the clock minute), and so do their 429s ([Rate limits](../reference/limits.md#rate-limits)).

### Faster resume after a crash, a drain or a deploy

- A node that dies mid-turn is found by its peers within about 10 s, not after its 90 s lease: a
  heartbeat three renewals late whose address refuses connections or does not answer is ended, and
  its turns resume at once on another node ([Dead nodes](architecture.md)). Heartbeats are renewed
  every 3 s (one write per node; it was every 15 s at the default lease). The lease stays 90 s, so a
  node still rides out a database failover; an expired heartbeat is no longer renewed.
- A node that gives up agents with runs open (a drain that timed out, a retirement leaving queued
  runs) tells the others, which sweep at once: the work resumes within about a second, not at the
  next 30 s sweep. Nodes also sweep as they start, and `AGENT_ORPHAN_SWEEP_MS` defaults to 10 s.
- Nodes must reach each other's `AGENT_NODE_URL` (as forwarding already needs).
- A node makes model and tool calls, runs js_exec and sends channel messages only while its lease is
  fresh (renewed within 6 s), so one that peers took for dead stops before they resume its work; it
  used to keep running turns for up to 81 s. While the database is away every node pauses these
  effects, cutting model requests in flight, and resumes them when it is back ([Fresh leases](architecture.md)).

### Sandbox: no sandbox processes

- js_exec and file parsing no longer go through long-lived Node "sandbox processes". `agent-launcher`
  starts each v8-exec process, and a parse job (`src/parse-job.ts`) for each PDF or image to scale
  down, itself: a uid no other live process has, no environment, `no_new_privs` and its seccomp
  filter, as before ([Layers](sandbox.md#layers)). An execution goes runtime → v8-exec (the launcher
  only starts it); a trivial one takes about 0.8 ms instead of 1.6, and an idle task holds about
  350 MB less. Image headers are read in the runtime; a parse job takes about 120 ms to start.
- Removed: `AGENT_SANDBOX_PROCESSES`. `AGENT_SANDBOX_SOCKETS` is now `AGENT_SANDBOX_DIR` (set by
  the launcher). `AGENT_V8_PRESPAWN` and `AGENT_V8_MAX` count the runtime's own processes.
- `AGENT_CODE_WORKERS_MAX` defaults to 16 (it was what the task's memory afforded at 128 MiB an
  execution: 6 on a 2 GB task), and sets the number rather than only lowering it.
- `v8_exec` metric lines (`Event`: `killed`) now come from the runtime, with the signal the
  launcher reports.

### js_exec on V8; QuickJS removed

- js_exec runs on V8, in a process of its own per execution (`v8-exec`, in the image at
  `/usr/local/bin/v8-exec`), jitless, under a seccomp allowlist of its own inside the sandbox
  processes ([The V8 engine](sandbox.md#the-v8-engine-v8-exec)). The QuickJS engine (WebAssembly on
  pooled worker threads) is gone, with its `quickjs-emscripten` and `sucrase` dependencies; TypeScript
  is stripped by oxc inside v8-exec.
- What agents notice: V8's error messages (`Cannot read properties of undefined (reading 'x')`
  where QuickJS said `cannot read property 'x' of undefined`); no `InternalError` (deep recursion
  throws a `RangeError`, `Maximum call stack size exceeded`, where QuickJS said `stack overflow`);
  `Intl` and `Temporal` exist; **running out of heap (128 MiB) ends the execution** with
  `Codemode memory limit exceeded` instead of throwing an error code can catch, while ArrayBuffers
  may hold 128 MiB (32 under QuickJS). CPU-bound code runs 4-10 times faster; a trivial execution
  takes about 3 ms instead of 0.4 ms. The system prompt states 128 MB of memory per execution.
- `code_execution` metric lines carry `Engine` (a dimension, always `v8`), and new `ErrorClass`
  values: `memory_limit`, `sandbox_seccomp`, `sandbox_rlimit`, `spawn_failed`. Sandbox processes
  write `v8_exec` lines (`Event`: `spawn_failed`, `killed`).
- New settings: `AGENT_V8_PRESPAWN`, `AGENT_V8_MAX`, `AGENT_V8_JITLESS`, `AGENT_V8_EXEC`
  ([Configuration](configuration.md)). Removed: `AGENT_CODE_WORKERS_MIN` (no worker pool to keep
  warm). `AGENT_CODE_WORKERS_MAX` now only lowers how many executions tenants with a concurrency
  limit share on a node. The image is about 50 MB larger.
- Running from a checkout needs the binary: `npm run build:v8-exec` (Rust 1.95), or `AGENT_V8_EXEC`
  pointing at one. Without it the runtime does not start, since js_exec does not run.

**Migrating from a build with the QuickJS engine:**

- Remove every `codeEngine` from the tenants file first (`infra/tenant.sh clear-engine <tenant>`;
  `tenant.sh list` shows any left). An entry with `"codeEngine": "quickjs"` (or anything but `"v8"`)
  is an error: the runtime does not start with it, and a running one keeps its previous tenants.
- `PUT /v1/tenants/{id}/limits` refuses `codeEngine` unless it is `null`; any `PUT` clears an engine
  stored for a self-serve tenant, and the reply no longer lists one. An engine still stored is
  ignored.
- `AGENT_JS_EXEC` is ignored; drop it from your environment.
### Journey events (opt-in)

- With `AGENT_JOURNEY_URL` and `AGENT_JOURNEY_SECRET` (or its ARN) set, the runtime sends signed events to the
  operator's own analytics store, for browsers that agreed to be measured: an arrival at the console from
  elsewhere, the console's pages (as routes), an account being made, signed in to or out of, minting an API
  token or being deleted, an agent being made through the API, an account's active days and first completed run,
  and its payments. The account export gains `analytics/` for accounts it knew (migration 056; [privacy](privacy.md#journey-events)). Unset, the default, nothing
  changes: no cookie is read or set, no row is written and nothing is sent.
- `/` and `/console` keep the query string when they redirect to `/console/`.

### Admin site

- The existing admin page adds Product signals and User journeys with shared calendar filters (today in Central Time by default), date-scoped payment/sign-up counts, explicit first-run coverage and per-account histories. The original overview remains available separately. See [Admin analytics](admin-analytics.md).

- The admins are whoever the admin site's Access application's policy admits: narrow that policy to the admin
  addresses before enabling reports.
- `GET /api/product-signals` on the admin site: self-serve sign-ups and credit purchases (count, paying accounts
  and amount in cents) for a range of calendar days (`start_date`, `end_date`, `time_zone`; today in
  `America/Chicago` by default, 366 days at most), in total and by day, from the runtime's own tables. An
  account's first completed run is counted from journey events' record of it, and is `null` with
  `activation_coverage` saying why where that is not known (journey events off, or not yet on for those days).
  Accounts being or already erased, tenants an operator made and staff journey events know are not counted.
- `POST /api/report` on the admin site asks the journey store for a report (`AGENT_JOURNEY_URL`, signed with
  `AGENT_JOURNEY_REPORT_SECRET` or its ARN, a secret of its own). Without one it answers
  `503 {"error":"report_not_configured"}`; `/api/stats` is unchanged.

### Console sessions

- Console sessions are stored in Postgres (`console_sessions`, migration 053); the cookie carries only a random
  id. Signing out ends the session on the server. **Deploying this signs everyone out once**: the earlier signed
  cookies are not sessions any more, so people sign in again.
- `DELETE /v1/sessions` signs a tenant out everywhere (every console session ends), from the console's Account
  page or with an API token. `GET /v1/me` says how a console session signed in (`signIn`: `github`, `google`
  or `password`).
- Cookie-authenticated writes (with `X-Agent-Runtime-Console: 1`), and the OAuth consent and sign-in forms, need
  a same-origin `Origin` or, where a browser leaves Origin out, `Sec-Fetch-Site: same-origin`. A request with
  neither (curl with a copied cookie) is refused.

### Billing and Get Help mail: SES only

- The `cloudflare` billing email provider (the `infra/billing-email` Worker) is removed, with
  `AGENT_BILLING_EMAIL_URL`, `AGENT_BILLING_EMAIL_SECRET` and `AGENT_BILLING_EMAIL_SECRET_ARN`. Billing and Get Help
  mail go through SES (`AGENT_BILLING_EMAIL_PROVIDER=ses`, the default), with its configuration set and SNS topics.
  **A runtime configured with `AGENT_BILLING_EMAIL_PROVIDER=cloudflare` no longer starts**: move it to SES first.

### Sign-up, password reset and adding a password by email

Off unless account mail is configured (`AGENT_ACCOUNT_EMAIL_FROM`); without it nothing changes. See
[Account email](account-email.md).

- **Sign up with an email and a password** on the console (`/console/signup`) and the MCP consent page, with
  `AGENT_OPEN_SIGNUP=true`. The password is 12 to 256 characters, not one of the most common, not the address;
  no composition rules. A link mailed to the address (24 hours, once) finishes it with that password, making
  the account (prepaid, a random `u-<16 hex>` id, starting credit by card check as for Google) and signing in.
  Unverified sign-ups have no account and cannot sign in.
- **Forgot password**: a link (an hour, once, only the newest) sets a new password and ends every password
  session.
- **Account page**: shows the account's address; an account without a password adds one (its own Google
  address at once, any other through a link). Changing a password now refuses the most common ones.
- Requests answer the same whether or not the address has an account: an address with one is mailed that
  someone tried; a Google account's address is told to sign in with Google. Email sign-up never merges with or
  takes over a GitHub or Google account.
- Links are kept only as SHA-256 hashes, in `account_email_links` (**migration 055**), with an index on
  `tenants.google_email`.
- New limits: `email_requests` per client address an hour (`AGENT_RATE_LIMIT_EMAIL_REQUESTS_PER_IP`, 10
  behind Cloudflare, else off unless set) and `emails` per address a day (`AGENT_RATE_LIMIT_EMAILS_PER_ADDRESS`,
  5, always on).
- Mail goes through Amazon SES (`AGENT_ACCOUNT_EMAIL_PROVIDER=ses`, the default) with the runtime's AWS
  credentials, or for a runtime of one's own to the log (`log`, refused with open sign-up on a public URL).
- Account mail can send through an SES configuration set (`AGENT_ACCOUNT_EMAIL_CONFIGURATION_SET`); with billing's
  (`AGENT_BILLING_EMAIL_PROVIDER=ses`) sharing it and its SNS topic, account mail's and Get Help's bounce events
  are ignored by billing's feedback route, which suppresses only billing contacts.
- `GET /v1/tenants?login=` also finds a tenant by its password address (`email` in the result), and the
  account export's `account.json` has it.

### Email and password sign-in; token sign-in removed

- **Signing in to the console, or on the MCP consent page, with an API or operator token is gone**:
  `POST /console/auth/token`, `POST /oauth/login` and the console's token form answer 404, and console sessions
  signed in with a token end on deploy. API and operator tokens still authenticate the API as Bearer tokens.
- **Email and password**, next to GitHub and Google, on the console's sign-in page and the consent page, for
  accounts an operator gave a password. There is no sign-up, email verification or reset by email: an operator
  sets or clears a password with `PUT` / `DELETE /v1/tenants/{id}/password` (the platform operator for any
  tenant, or a tenant's own operator token, as on a self-hosted runtime; never an API token), or on the hosted
  service `infra/tenant.sh set-password <tenant> <email>`. Setting or clearing it ends the tenant's password
  sessions. A password session is a person's, like a GitHub or Google one. Signed in, people change their own
  password on the Account page with the current one (`PUT /v1/account/password`), which ends their other
  password sessions.
- Passwords are hashed with scrypt (N = 2^15, r = 8, p = 1), a random salt each, kept in `tenant_passwords`
  (migration 054). A wrong password and an unknown address get the same 401 `Wrong email or password`, after
  the same hashing. Failed sign-ins are limited per address (`AGENT_RATE_LIMIT_PASSWORD_FAILURES_PER_EMAIL`,
  default 10 per 15 minutes, always on) and per source (`AGENT_RATE_LIMIT_PASSWORD_FAILURES_PER_IP`, default 20
  behind Cloudflare, else off unless set); past either, sign-in answers 429 until the window turns over.
- **Self-hosted runtimes without GitHub or Google** sign in with a password set with the operator token; see
  [Self-hosting](self-host.md#sign-in-to-the-console).

## 0.4.0 (runtime-v0.4.0, 2026-10-03)

### Sub-agents

- The `delegate` built-in (`builtins: ["delegate"]`, `delegate: { agents, instructions?, maxDepth?, maxParallel? }`):
  an agent starts a sub-agent from an allowlisted definition or agent (or inline instructions, if allowed),
  gives it a task and gets its answer back, structured with an `output` schema if asked. Sub-agents are
  keyed by the parent's tool call, so a parent resumed on another node collects the answer instead of running
  the task twice. Depth (default 2), calls in flight per run (default 4), busy-agent slots and spend limits
  apply; a sub-agent's spend is charged back to its parent (`usage.subagentCostUsd`). Aborting the parent
  aborts its sub-agents, and a sub-agent's run joins the parent's trace. Opt-in `subagent_*` events on
  streams; `run.toolCalls[].agentId` names the sub-agent. See [Multi-agent](../guides/multi-agent.md).
- An abort that reached a run before its model loop began is no longer lost.

## 0.3.0 (runtime-v0.3.0, 2026-10-03)

### Forking, OpenTelemetry export, agent credentials

- `POST /v1/agents/{id}/fork`: a new agent with the source's configuration, its committed history up to a
  turn boundary (`atMessage`), and a fork of its workspace volume. Files the copied history refers to stay
  pinned for the fork. See [Concepts](../concepts.md).
- OpenTelemetry trace export per tenant (`/v1/telemetry`): run, model, tool, compaction and human-input spans
  over OTLP/HTTP (protobuf or JSON), GenAI attributes, content off unless `include.content`. Inbound W3C
  `traceparent` continues a caller's trace. A self-hosted runtime sending to a private collector needs it in
  `AGENT_OUTBOUND_ALLOW_ORIGINS`. See [Observability](../guides/observability.md).
- `GET /v1/agents/{keyOrId}/credentials`, behind the SDKs' `agents.get()`.
- `GET /v1/models?available=true` sends an `X-Camelrun-Hint` header when it is empty, and a self-hosted
  runtime's `model_key_missing` names `AGENT_TENANT_API_KEYS`.
- Account exports read each agent's history from the node that serves it and fail rather than leave one out;
  agents a crashed node held read their whole history.
- Migrations 045-048 run on start (busy agents, tenant limits, dropping a retired Discord table, rate limits).

## 0.2.0 (runtime-v0.2.0, 2026-10-03)

### Agents without a model key, and runs that say why they failed

- Agents are made before any model key is set (0.1.0 refused with 400). A run without a key fails with
  `model_key_missing`, and one whose key the provider refuses with `model_key_invalid`; both say what to set.
- Request records carry `status` (`completed`, `input_required`, `failed`) beside `state`.
- `/docs/operations/*` is served with the other docs.

### Background compaction, Pi 1.0

Compaction no longer holds up the next run. Once an agent's context comes within 32k tokens (15% of a
smaller window) of its compaction threshold, the summary is made in the background, after a run or
between model requests, and runs go on with the whole context until it is written. Only a run whose
context would not fit waits for it, or compacts first when none is running. One compaction runs at a
time per agent. Its events carry `background: true` and reach the agent's stream outside any run
(`requestId` empty); its usage is billed as `compaction`, with no `requestId`, and counts against
spend limits as before. Measured on gpt-4o-mini with 110k tokens of history, the run that crossed the
threshold started its reply in 1.1 s instead of 12.6 s (6.3 s when it was sent straight after the
previous run, while the summary was still being made).

Context estimates no longer count usage that a response reported before the latest summary: it
measured the context the summary replaced, and could start a second compaction straight after the first.

The runtime runs on Pi 1.0 (`@earendil-works/pi-agent-core` and `pi-ai`). Transcripts written by
earlier releases load unchanged. A tool result an MCP server or OpenAPI operation returns with
`isError` keeps its content and structured content in history.

### Rate limits

The API answers 429 `RATE_LIMITED` with `Retry-After` and the limit reached (`limit: {name, scope, max,
windowSeconds}`) past a rate limit: per account, agent creates (60 a minute, 10 on free credit) and
runs started (600 a minute, 60 on free credit); per client address, `/v1/*` requests (600 a minute),
sign-in and OAuth requests (20 a minute) and new accounts (5 a UTC day). The per-address limits are on
by default only with `AGENT_TRUST_CF_CONNECTING_IP=true`, for a runtime only Cloudflare reaches; a
self-hosted runtime sets them itself. Every value is an `AGENT_RATE_LIMIT_*` setting, and admin
tenants are exempt (their per-address /v1 traffic too) unless they set `maxAgentCreatesPerMinute` or
`maxRunsPerMinute`. See [limits](../reference/limits.md#rate-limits).

Migration 048 adds `rate_limits`. Nodes without this release count nothing, so limits hold fully once
the rollout ends.
### Busy agents across the fleet, and usage tiers

A tenant's busy-agent limit now holds across every node together, not per node: an agent is
busy while it has a run open (running or queued), and a run past the limit gets 429
`BUSY_AGENT_LIMIT` with `busyAgents: {busy, limit, source, tier?, paid?, next?}` in the body.
Prepaid tenants get their limit from a usage tier by what they have paid for credit (Free 8,
$5 25, $50 100, $250 250, $1,000 1,000; `AGENT_USAGE_TIERS`), applied as soon as a payment
posts. A tenant's `maxAgents` still wins, and now counts across the fleet too, as does
`AGENT_MAX_AGENTS_PER_TENANT` for tenants that are not prepaid. `GET /v1/billing` and the
console's Billing page show the tier. `AGENT_FREE_MAX_AGENTS` is replaced by the first tier's
`busyAgents`; a node with it set refuses to start. Rejections at a tier's limit log
`busy_limit_reached`; at a `maxAgents` or default limit, `quota_rejected` as before.

Migration 045 adds `busy_agents`. During a rollout, older nodes neither write nor count rows,
so a tenant's runs on them are limited per node as before.

### Structured output

A prompt takes `output: {schema}` (a JSON Schema for an object). The agent ends the run by calling a
`final_output` tool with that schema, which a system prompt section tells it to call. The runtime
checks the call and hands one that does not fit back to the model. A model that answers in text is
asked once more, with a reminder. The outcome's `result.output` is the answer. A run that still ends
without one fails with `code: "output_missing"`. The SDKs take zod, TypeBox and JSON Schema (TypeScript) or a pydantic model
(Python) as `run(text, { output })`, and return the parsed answer as `run.output`. There is no
migration: the tool is declared in the agent's transcript. During a rollout, a structured turn that
resumes on a node without this release loses the tool and ends as a plain run, without `output`. See
[structured output](../guides/structured-output.md).

### Account export and deletion

`GET /v1/account/export` streams a zip of everything an account stores, and the console's
Account page offers it and **Delete account** (`DELETE /v1/account`, console sessions only).
Platform operators (`AGENT_BILLING_ADMINS`) look tenants up, export and delete them with
`GET /v1/tenants?login=`, `GET /v1/tenants/{id}/export`, `DELETE /v1/tenants/{id}` and
`GET /v1/tenants/{id}/deletion`. See [account data](privacy.md).
`POST /v1/tenants` makes a prepaid tenant with an API token and no sign-in identity, for
test and review accounts (see [billing](billing.md)).

Migration 043 adds `account_deletions`, reduces existing purged agents' tombstones to their id,
and deletes email thread metadata left by agents and channels deleted before. Older nodes still
authenticate a tenant being deleted until they are replaced, and purge agents into the old,
fuller tombstone: finish the rollout before acting on a deletion request.

### Public URL aliases

`AGENT_PUBLIC_ALIASES` lists other origins the runtime answers at, such as an
earlier domain kept working after `AGENT_PUBLIC_URL` moves, and `AGENT_ISSUER`
keeps identity tokens' `iss` and the OAuth issuer where they were. On an alias,
MCP protected-resource metadata and `WWW-Authenticate` challenges name the
origin the client reached; the console, `/` and `/oauth/authorize` redirect to
`AGENT_PUBLIC_URL`. Existing OAuth grants and tokens work at every origin. See
[configuration](configuration.md).

## 0.1.0 (runtime-v0.1.0, 2026-09-30)

### Usage and billing

GitHub starting-credit eligibility is decided once, at signup. Before deploying
migration 031, set `AGENT_SIGNUP_MIN_ACCOUNT_DAYS` to the existing private policy
when GitHub sign-in and a positive starting grant are enabled. Startup now rejects
a missing policy. A disabled starting-credit program needs no policy and produces
no eligibility notice.

Replace or drain all older sign-in handlers during this rollout: they can still
re-evaluate eligibility at later sign-ins. Migration preserves existing awards; it
does not issue catch-up grants. Support exceptions use the billing-admin endpoint
`POST /v1/billing/starting-credit/grant` with `amountUsd` (whole cents, $1–$100).
See [billing operations](billing.md) for correction and audit procedures.

Migrations 034–035 add recipient opt-out and durable refund reconciliation.
Replace or drain older billing-email workers before enabling opt-out, because
their claimed sends do not perform the new final consent check. Verify that the
SES sender's DKIM signature covers both unsubscribe headers before relying on
email clients' one-click controls. The web opt-out remains available independently.

Replace older Stripe webhook handlers during this rollout: they still ignore
refunds that arrive before a purchase. The new handler persists those refunds and
applies them atomically when the purchase arrives. Previously ignored refunds
are not recreated by migration; replay their signed Stripe events through the
updated handler or reconcile them through the existing audited correction flow.

Migrations 036–039 add durable Stripe purchases, hosted billing, automatic top-up
and recovery pauses. Drain older billing and automatic top-up workers before
cutover: an older worker does not honor expired-confirmation pauses. Apply all
migrations in order, then start the updated API, webhook and worker code together.
The runtime applies pending migrations at startup; do not run older binaries
against the upgraded billing schema. Automatic top-up stays off until a customer
explicitly consents. An expired bank confirmation now voids the unpaid invoice
and stays paused until fresh consent; it cannot generate daily charge attempts.

Automatic invoice creation no longer sends an empty `default_tax_rates` value,
which Stripe rejects. It explicitly disables automatic tax and continues to
clear inherited discounts, keeping the invoice equal to the customer's quote.

Before rollout, exercise the full Stripe flow in a separate sandbox using the
pinned API version and restricted key. Check decline/retry with a changed default
card (including InvoicePayment allocation count), 3DS confirmation, invoices,
portal configuration and refunds. Configure and test billing SES/SNS feedback and
route `billing_reconciliation_required` to the operations pager. See
[billing operations](billing.md) for exact configuration and recovery procedures.
