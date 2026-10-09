# Release notes

Each runtime release is a `runtime-v<version>` tag, and the image `ghcr.io/qaml-ai/run:<version>`
(`latest` is the newest). Upgrade a self-hosted runtime by changing `AGENT_RUNTIME_IMAGE` and running
`docker compose up -d` (see [Self-hosting](self-host.md#upgrade)); read the notes for every version
between yours and the new one first.

## Unreleased

Changes on main since the last tag are in [unreleased/](unreleased/), a file for each change (so changes merged in
any order never conflict here), gathered into a version's notes when it is tagged: `npm run release-notes` shows them
together, and `npm run release-notes -- <version>` writes them here and removes the files.

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
