# Release notes

Each runtime release is a `runtime-v<version>` tag, and the image `ghcr.io/qaml-ai/run:<version>`
(`latest` is the newest). Upgrade a self-hosted runtime by changing `AGENT_RUNTIME_IMAGE` and running
`docker compose up -d` (see [Self-hosting](self-host.md#upgrade)); read the notes for every version
between yours and the new one first.

## Unreleased

Changes on main since the last tag are in [unreleased/](unreleased/), a file for each change (so changes merged in
any order never conflict here), gathered into a version's notes when it is tagged: `npm run release-notes` shows them
together, and `npm run release-notes -- <version>` writes them here and removes the files.

## 0.12.0 (runtime-v0.12.0, 2026-11-01)

Agents run on Pi: durable execution and storage are Pi's journal, and the old engine, its history index and their importer are gone. This release also adds decisions (`POST /v1/decisions` and the `decide` builtin, on by default), judged tool approvals, native and managed computers, workflows, realtime voice, virtual models and a console organized by workspaces. Breaking: the transcribe-and-reply voice pipeline and trace export are removed, and legacy history formats are refused.

### Admin tenants' runs have a backstop

A tenant in the tenants file (an admin tenant: chiridion-prod, camel-bots, an operator's own) had no run limit unless its
entry set `maxRunResponses`/`maxRunSeconds`; on 2026-10-27 one scheduled run looped for 25 hours and 71k messages. Their
runs now stop at `AGENT_ADMIN_MAX_RUN_RESPONSES` (default 1000) or `AGENT_ADMIN_MAX_RUN_SECONDS` (default 14400, 4
hours), with `stopped: "turn_limit"`; an entry's own limits still replace them. Seven days of turns: 99.9% end within 25
minutes and ~100 responses, the longest legitimate one 92 minutes and 229.

### Agents have a primary language

`language` sets an agent's primary language as a BCP 47 tag (`"es"`, `"es-ES"`, `"pt-BR"`, `"zh-Hant"`; at most 35
characters, stored in canonical case, junk refused with 400). Give it when you make an agent, on a stateless run, or on
a definition (its agents take it unless they set their own, which applying the definition keeps); change it with
`PATCH /v1/agents/:id/configuration`, where `null` removes it. An upsert that leaves it out keeps the agent's (so an older
SDK, which drops the field, does not clear it). `GET /v1/agents/:id` and definitions show it. With one
set, the system prompt gets one fixed line after the environment summary, e.g. "Language: reply in Spanish (español) by
default. If the person clearly writes in another language, reply in that language instead." The line is the same every
turn, so prompt caching holds. Compaction summaries are unchanged. The TypeScript and Python SDKs take `language`
(`language=`) on create, configure and runs. Agents without it are unchanged.

### Sub-agents report progress without interrupting their parent

A sub-agent the runtime made (a `spawn_agent` or `delegate` child) has `report_progress({ text })`: its latest status,
at most 500 characters, latest wins. It never starts a turn and does not count against `AGENT_WAKES_PER_HOUR`. A
background sub-agent's parent sees the reports it has not seen yet with its next tool result, as an `<agent_updates>`
block the runtime writes (in history, a part of that result with `agentUpdates: true`), and as `progress` and
`progressAt` in `list_agents` and `wait_agent`; a sub-agent's ending supersedes its reports. Watchers asking for
sub-agents (`?subagents=1`) get `subagent_progress`, and a delegate sub-agent's report is also its call's
`tool_execution_update`, which `<AgentChat>` shows under the call. The SDKs leave the block out of a tool result's
`output` and of the chat's `ToolPart.result` (`agentUpdates` has it). Migration 098 adds `progress`, `progress_seq`
and `progress_at` to `agent_children`. See [Progress](../guides/multi-agent.md#progress).

### A sub-agent's message reaches its busy parent at once

`send_message` to `"parent"` now joins the parent's running turn at its next step, as a `whileRunning: "steer"`
prompt does, instead of waiting for that turn to end: it starts no turn (and so counts no wake), and its request ends
`steeredInto` the turn. A parent's `wait_agent` returns as soon as one of its sub-agents messages it, with `messaged`
naming who, so the model reads the message next. An idle parent still gets it as a turn of its own. The call answers
`into: "its running turn"` or `"a new turn of its own"`.

### A waiting parent can watch its sub-agents' progress

`wait_agent({ untilProgress: true })` also returns when a sub-agent it waits on reports progress the parent has not
seen, with `updated` naming whose and each one's latest `progress`, so the model can correct a sub-agent that went off
track while it works. It answers no sooner than `AGENT_PROGRESS_WAIT_MS` (default 15 seconds) into the wait, so a
sub-agent reporting each step costs its parent at most one model call per that long. Without it, a report never ends
a wait.

### Starting a sub-agent and messaging it in one response

`wait_agent`, `send_message`, `list_agents` and `interrupt_agent` called in the same response as `spawn_agent` now run
once the sub-agent has started: `send_message` found no agent, and `wait_agent` recorded the sub-agent as failed while
it went on to run. A message to a sub-agent whose turn has not begun yet waits up to 10 seconds for it and joins it,
instead of queuing behind the whole task.

### A steer sent just after a prompt joins its turn

A `whileRunning: "steer"` prompt (a person's, or a sub-agent's message) that arrives while a turn has begun but its
host has not yet opened it now waits up to 5 seconds for it to open and joins it, instead of answering `steer: "queued"`
and running after the whole turn.

### Sub-agents of the model's own design require their instructions

With `delegate: { instructions: true }` and no `agents`, `delegate` and `spawn_agent` now list `instructions` as
required, as the runtime already demanded: models sent only a `task`, were refused, and wrote every call again. A call
without it says which field is missing (`Give instructions too: who the sub-agent is …`).

### wait_agent waits for a sub-agent's latest turn

A message to a sub-agent that had already answered starts a turn of its own; `wait_agent` now waits for that turn's
answer, instead of returning the earlier one at once. The earlier answer still comes as its notification. The
`instructions` and `task` descriptions now tell the model to put the work (data, rules, steps) in `task`: a message can
amend a task, but models hold to a system prompt over later messages.

### A sub-agent of the model's own design gets its instructions as its first message

With `delegate: { instructions: true }`, the model's `instructions` are no longer the sub-agent's system prompt: they
come first in its first message (`Your role:` then `Your task:`), and the system prompt is the runtime's, saying its
parent's later `<agent_message name="parent">` messages may correct its role or task. As a system prompt they
outranked the parent's corrections: GPT-6 Astra and GPT-6.1 Sol put a task's rules in them, and their sub-agents
answered the old total again however often they were corrected (a bare Sol agent followed a correction against its
system prompt 0 times in 8, even when told it could; 4 in 4 with the rules in its first message). Text the parent
model wrote now has its authority, no more: a parent misled by what it read cannot raise that text above what its
sub-agent reads in turn. A sub-agent from a definition keeps the definition's system prompt.

### A sub-agent shares its parent's files

A sub-agent of the model's own design (`delegate: { instructions: true }`) now mounts its parent's mounts as they
are, at the same paths, as Claude Managed Agents and Claude Code share one filesystem, so a file the parent names
(`/workspace/rows.json`) is there and the sub-agent may change it. It had only an empty `/workspace` of its own:
models wrote data to a file and handed sub-agents its path, which they could not open (DeepSeek v4.1 flash failed 4
of 5 runs of a benchmark this way). A definition's sub-agent keeps the definition's mounts.

### Cloudflare reaches the load balancers over HTTP/1.1

Both load balancers have HTTP/2 off. Over HTTP/2, Cloudflare multiplexed many requests on one connection, and an
unread ~1 MB history response (a load cancelled by a quick reload) stalled every other request on it for 25-183 s,
so chat pages hit their 60 s stream timeout. Apply with `infra/apply.sh`; the change is in place, no replacement.

### Platform Anthropic workload identity federation

Operators can use the ECS task role for short-lived Anthropic credentials. Tenant keys keep precedence.
The platform refreshes tokens per node and can fall back to its static Anthropic key during rollout.
See Anthropic via Workload Identity Federation (`docs/operations/anthropic-federation.md`) for setup and verification.

### Azure DeepSeek V4.1 Flash, over Chat Completions

Azure DeepSeek V4.1 Flash is available as `azure/deepseek-v4.1-flash` when the platform maps it to its deployment, for example `deepseek-v4.1-flash=DeepSeek-V4.1-Flash` in `AGENT_AZURE_OPENAI_MODELS`.

It uses Azure v1 Chat Completions with tools, reasoning, images and cached input. Its context window is 1,048,576 tokens, including output; the default maximum reply is 131,072 tokens. Azure Global prices per million tokens are $0.30 input, $1.20 output and $0.006 cached input, with no cache-write charge. The Azure version is 2026-09-10 (preview), not OpenRouter's 2026-10-17 snapshot. Calls and billing use the same platform credential path as Azure's Responses models.

### Voice: realtime sessions on the platform's OpenAI key can run on Azure OpenAI

Operators with an Azure OpenAI resource (`AGENT_AZURE_OPENAI_*`) now send realtime voice sessions made on the
platform's OpenAI key to its `gpt-realtime-2.1` deployment (`realtimeDeployment` in the secret, or
`AGENT_AZURE_REALTIME_DEPLOYMENT`; default that name, `""` keeps voice on OpenAI; `realtimeModels` /
`AGENT_AZURE_REALTIME_MODELS` for other realtime models). A session connects to Azure's GA realtime endpoint with the
`api-key` header, its input transcription on the `gpt-transcribe` deployment. When Azure refuses or fails before the
session is live, it goes on on OpenAI with the platform's key (`voice_realtime_azure_fallback`). A tenant's own key
stays on OpenAI. Billing is unchanged. The `voice_realtime` metric gains a `Host` dimension (`azure` or `openai`) and
`VoiceRealtimeAzureFallbacks`. A secret stored before this change, without `realtimeDeployment`, sends voice to Azure's
`gpt-realtime-2.1` deployment once the new image runs: store `"realtimeDeployment": ""` first to keep it on OpenAI.

### Configure card-verification credit separately

`AGENT_CARD_CREDIT_USD` sets the free credit for verifying a card. Unset, it follows
`AGENT_CREDIT_GRANT_USD` (default $5). Set it to `0` to hide the console offer and
refuse new checks with HTTP 409 (`CARD_CREDIT_UNAVAILABLE`). Pending checks still
settle and are recorded without granting credit. GitHub starting grants and credit
already granted are unchanged. Terraform exposes this as `agent_card_credit_usd`;
its default empty string leaves the environment setting unset. See [Billing](billing.md).

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

### Compact when a request leaves out older images

A model request that has to leave out older inline images (past the request's image count or byte budget) sends less
than the agent's Pi context holds, so Pi's compaction, which reads the size of the context from that response's usage,
would never see them. Such a request now also starts Pi's compaction in the background, at most once a run and only when
none is running; its summary is placed at the next boundary. Image-heavy agents are compacted sooner, which bounds the
images their context holds in memory. Nothing changes for requests that send everything.

### A refused computer key no longer blocks the computer

A provider answering 401 or 403 when a computer starts has made nothing, so the session now closes instead of staying
`uncertain` until someone confirms cleanup. `computer_start` says the credentials were refused; disconnect and reconnect
with a working key. Any other failed start stays `uncertain`, because a lost response may have made a machine. Agents'
computer tools also say when to stop a computer, that `computer_start` comes first, and who can clear a failed start.

### Clearer computer transfer and file link errors

`computer_download` of a remote file that does not exist now answers 404, `<path> not found on the computer`. It used to
say the transfer exceeded the file size limit. `file_link` now accepts a generic `contentType`
(`application/octet-stream`, `application/x-www-form-urlencoded`, `multipart/form-data`) as saying nothing about the file,
instead of refusing it as invalid.

### Computer file transfers

Shell computers now offer `computer_upload` and `computer_download` to copy binary
files between their remote filesystem and the agent's workspace. Results contain
only the path, byte size and SHA-256 digest. Files can be up to 256 MiB, subject to
workspace permissions and storage quotas. Each transfer uses a signed URL
that expires within two minutes. See `docs/guides/computers.md`.

### Console: organized around workspaces

The console's sidebar now has a workspace switcher (shown once an account has a workspace) over the pages it scopes,
and an **Account** group for what is account-wide. The selection is `?ws=` in the URL, so a link keeps it.

- **Overview** is home once an account has an agent: spend against the previous 30 days, running agents, recent
  failures (class and time only) and spend by model and tool. Get started stays home before the first agent.
- **Agents** is paged and filtered on the server (search, Running, Failed · 24h, Sub-agents, Expiring), shows each
  agent's workspace and last activity, and moves agents between workspaces in bulk.
- **Workspaces** shows each workspace's spend and members; each has a settings page (rename, definitions, agents,
  archive).
- **Usage** moved out of Settings: a daily chart stacked by workspace, By workspace / By model / By day (paged)
  tabs, the range in the URL, and CSV export of the current view.
- Old console URLs keep working; `/console/settings` opens Settings → Telemetry.

### Content-filter fallback

A request whose provider's content filter blocks it (`finish_reason: content_filter`, or an error with `code: content_filter`) is made once more on the same model on another provider, where `AGENT_CONTENT_FILTER_FALLBACKS` names one (`from=to`, comma-separated; empty for none). The default sends `azure/deepseek-v4.1-flash`, whose Prompt Shields filter blocks ordinary coding answers as jailbreaks, to `openrouter/deepseek/deepseek-v4.1-flash-1017:nitro`. The fallback uses the agent's key for that provider (its key scope's entry, or the account's key), and is made inside the same model request, before Pi sees the block: history keeps only the fallback's answer, and a watcher sees the response begin again (a new `message_start`). The account pays for the fallback's answer alone: the blocked call is settled as the platform's cost (no credit charge, no end-user charge, out of the account's usage totals), and its `usage.recorded` event carries its tokens and `superseded: "content_filter"` so a receiver books it without charging for it. A failure of the fallback is the request's failure, retried as any other (on the agent's own model first). The next request goes to the agent's own model. Only agents whose key is resolved per call (a key scope, or the platform's Azure) fall back. Each fallback is a `model_fallback` metric line (`ModelFallbacks` by `From`, `To` and `Reason`).

### Oversized agent contexts fail without loading the range

An agent whose Pi journal range since its latest compaction exceeds 128 MiB now fails its run with code `context_too_large` before the host loads it. Interrupted runs fail with the same code instead of repeatedly resuming. History reads and abort remain available.

Live runs check before each model request, stopping with `stopped: "turn_limit"` and code `context_too_large` when the range exceeds the bound. Operators can set `AGENT_CONTEXT_RANGE_MAX_BYTES` to a positive byte count. Use a new agent with a summary of the history, or raise the bound with enough heap capacity.

### Reset an agent's context: `POST /v1/agents/{id}/context/reset`

An agent whose runs fail with `context_too_large` can run again. `POST /v1/agents/{id}/context/reset` with `{ summary?, keepMessages? }` writes a new Pi head marker at the journal's tail: the agent's current system message, a summary (the one given, or a note that the operator reset it on that date), and its last `keepMessages` history messages (0 to 20, default 0, never starting on a tool result whose call is not kept). It reads the system message in SQL and never loads the old context range, so it works on an agent no node can start. History (`GET /v1/agents/{id}/history`), the history index, files and configuration are unchanged. It is refused with 409 `AGENT_BUSY` while a run is active or queued (or when the agent started while it was being reset), and with 409 `context_too_large` if the new context would itself be past `AGENT_CONTEXT_RANGE_MAX_BYTES`. Repeating it is safe.

The SDKs have `agent.resetContext()` / `runtime.resetContext(agentId)` (TypeScript) and `reset_context()` (Python); the CLI has `camelrun agents reset-context <agent> [--summary text] [--keep n]`.

The system-message read stops on the database after 120 s (`statement_timeout`), so a reset the client gave up on does not keep scanning, and it is not retried.

### Model calls hold your credit before they are made

A model call on the platform's keys now holds its estimate of a prepaid account's credit first, at the catalog's rates. Before, the balance was only checked between calls, so a few cents could start a call costing many dollars.

- A call the credit does not cover is not made, and the turn ends with `stopped: "spend_limit"`, `limit: "credit"`. On free credit, the room is also what is left of the hour's allowance.
- All of your credit can be spent: a last call starts within $0.25 of what is left, and a reply stops where the credit does.
- Each call, on your credit or an end user's, asks for at most the output what is left pays for, so `max_tokens` can come out lower than the model's maximum near the end of a balance. That also bounds reasoning that never streams.
- An estimate now uses a model's long-context rates for end users' holds as well.
- A model with no price, or a router, holds at $3 and $15 per million tokens. It settles at what the provider reports.
- Your own keys are not held, and neither are `:free` models.

### Database connections stay open a minute when idle

The control-plane pool now keeps an idle connection for 60 s (`AGENT_DATABASE_IDLE_TIMEOUT_MS`; it was pg's 10 s), so a node reconnects, with a TLS handshake, far less often.

### The decide tool is on by default

Every agent now has the `decide` tool (decisions with a decision model, `docs/guides/decisions.md`), directly and from
js_exec as `tools.decide`, without listing it in `builtins`. Exceptions: an agent with no js_exec and no tools of its
own, and a run with no tools at all, have none unless they send `decide: true`; it is not offered on an account with no
OpenRouter key decisions can use (an agent whose `dataCollection` is `deny` has it, its calls sent with that policy).
Opt out with `decide: false` on an agent (create or `PATCH .../configuration`; `null` restores the default), a
run, or a definition; the agent view shows the setting (`decide`: true, false or null). The tool adds about 300 tokens
to each request's tool list, so each agent's next request misses the prompt cache once. Calls are billed like any
decision: on the platform's key, to prepaid credit.

### Decisions with one side of a noul's criteria work

OpenRouter refuses a noul question whose `criteria` has only `true` or only `false` (HTTP 400, `invalid_union`), which the
API and SDKs allow. Such a question failed its whole decision. camelRun now sends the other side: yes is the question's
statement, no is "Anything else.". Each failed decision also logs `decision_failed` with its status and error class.

### Decisions: `POST /v1/decisions` and the `decide` builtin

Typed questions about a state (`noul` yes/no, `choice`, `score`) answered with calibrated probabilities by a decision
model: TypeSafe's Jev (`typesafe/jev-1.14`, pinned) through OpenRouter's decisions API (`/api/alpha/decisions`), on the
tenant's OpenRouter key or the platform's at OpenRouter's reported cost. One state, or a batch of up to 100 answered in
parallel (16 calls at once per tenant per node, 64 per node), with transient failures retried and Retry-After honoured.
Agents get it as the `decide` builtin, and from js_exec as `tools.decide({items})`, billed to the run's and agent's
spend limits (`usage.decisionCostUsd`). Usage has a new kind, `decision` (`decisions` counted), in `/v1/usage`, the
ledger and `usage.recorded`. The provider sits behind `src/decision-providers.ts`; nothing is cached or logged of a
state. `AGENT_DECISIONS_URL` points the adapter elsewhere (tests). See `docs/guides/decisions.md`.

Also: a provider answer with neither cost nor tokens is billed at the estimate (logged as
`decision_usage_untrusted`); `dataCollection: "deny"` (a request's, new on `POST /v1/decisions`, or an agent's) is sent as
`provider.data_collection: "deny"`, which the decisions API takes and TypeSafe serves (a 404 for want of such a host
is `DECISIONS_DATA_POLICY`); a
request body is at most 2 MB and characters in flight are bounded per tenant (8M) and node (32M), with a 429 before the
body is read; a key scope's chat `baseUrl` is not used; a call's own timeout is retried; end users settle at what the
tenant pays (the OpenRouter credit multiplier on the platform's key). Images and transcriptions asked for alone now
record their usage before settling an end user's hold.

### DeepSeek V4.1 Flash 1017 skips InferenceNet and Wafer

Calls to `openrouter/deepseek/deepseek-v4.1-flash-1017` and its `:nitro` variant now send `provider.ignore: ["inference-net", "wafer"]`. Those two OpenRouter hosts sometimes dropped a tool call's optional arguments: 13.6% of camel-builder's `bot__preview` calls failed on InferenceNet on the evening of 2026-10-27, and 15.6% failed on Wafer on 2026-10-26, against 1.7% on Together. OpenRouter still balances load across every other host. `:nitro` is still sent as given, and `ignore` combines with `dataCollection: "deny"`. The `:morph` canary is unchanged.

### DeepSeek V4.1 Flash is the default model

An agent that names no model, on a runtime that sets none of `AGENT_PROVIDER`, `AGENT_MODEL` and `AGENT_BASE_URL`, now gets `openrouter/deepseek/deepseek-v4.1-flash-1017`, in place of Claude Sonnet 5.5. A runtime that sets any of them keeps what it named: `AGENT_MODEL` or `AGENT_BASE_URL` alone is still Anthropic's, and `AGENT_PROVIDER=anthropic` alone is still Sonnet 5.5. run.camelai.com moves when its `AGENT_PROVIDER` and `AGENT_MODEL` are changed.

- **Your own keys come first.** The default is the first model your key scope or account holds a key for, then the first the platform's keys serve. An account with only an Anthropic or Bedrock key gets Claude Sonnet 5.5 on that key, and is not moved onto the platform's keys and its credit.
- **`AGENT_MODEL_FALLBACKS`** now defaults to `azure/deepseek-v4.1-flash`, then Sonnet 5.5 on Anthropic, OpenRouter and Bedrock's global profile. `openrouter/openai/gpt-6-luna` is gone from it: any account with an OpenRouter key stopped before it. These choose a model when an agent is made, by who holds a key. No running agent moves to them when a provider fails.
- **Existing agents keep their model.** An upsert (`POST /v1/agents` with an `Idempotency-Key`) that names no model, or a definition applied that names none, now leaves an agent's model as it is. Before, either moved it to the runtime's default: an upsert with no model no longer undoes one that named a model. Name a model to change it.
- **What a default agent notices.** DeepSeek takes `thinkingLevel: "off"` where Sonnet 5.5 always reasons, so a default agent does not reason unless you set a level. Its tool-call arguments may arrive in one piece (`toolCallStreaming: false`). It costs far less per token, and takes more tool calls per task.
- The SDK examples and `camelrun init`'s template use the account's default, or show the new one.

### Delegates in one response always share the run's budget

With a run's spend limit, each delegate call in a response gets an even share of what the run has left. The share counted
only calls already at the node, so one that arrived late, or waited for a `maxParallel` slot, could find the first child
holding the whole budget and fail with "This run has no budget left for a sub-agent". Shares now count every delegate call
in the response. Sequential children no longer get everything left to whichever ran first.

### Delegate sub-agents are tracked in the database

A `delegate` call's sub-agent now has a row in `agent_children` (kind `delegate`, migration 083), written before its
prompt is sent. Aborting, stopping or deleting the parent reaches it from any node, also after the node that made it
was lost and before the parent's run resumes; deleting the parent deletes the sub-agents the runtime made for it. An
abort answers once the parent's delegate sub-agents have ended (at most 10 seconds, then `subagent_stop_timeout` is
logged), and what they spent counts in the aborted run's `usage.subagentCostUsd` and against the parent's spend limit.
A sub-agent whose parent's run ended without its answer is aborted by the child sweep, which charges what it spent to
the parent's spend limit (`subagent_late_ending`).

### Deploys: a hotfix lane, and never an older image over a newer one

A hand-run Deploy is now the hotfix lane: `gh workflow run deploy.yml -R qaml-ai/run -f sha=<commit>` (main's head
without `sha`) skips CI, uses CI's image or builds it, runs beside the automatic deploys instead of queuing behind
them, and logs the ECS rollout (see [CI and deploys](README.md#ci-and-deploys)). Automatic deploys no longer cancel a
hand-run one, and a newer commit's deploy cancels the older run's wait instead of queuing behind its whole rollout.
Every deploy compares its commit with production's primary deployment right before the update and follows a
deployment that already includes it, so an older commit never rolls over a newer one (`-f rollback=true` to do so on
purpose), and each run checks at the end that every running task runs its image. Run titles name the deployed commit:
a `workflow_run` run's own head SHA is main's head when CI finished, which made the deploy of #362 look like #368's.

### ElevenLabs calls past 10 minutes

- ElevenLabs Agents conversations now last up to 30 minutes, and a conversation that reaches its limit ("Max call
  duration exceeded") is replaced by a fresh one, briefed with what was said, instead of ending the voice session with
  `error`. Calls on ElevenLabs voices longer than 10 minutes used to end. The runtime creates a new agent per
  credential (`camelRun realtime voice v3`) on first use; the earlier `v2` agents are no longer used and can be deleted
  from the ElevenLabs account. See `docs/guides/voice-calls.md` for the realtime brain.

### ElevenLabs realtime models

ElevenLabs voice sessions accept any model ElevenLabs Agents offers, with `gemini-3.1-flash-lite` still the default.
Each model uses its own agent; existing model agents are reused. Refused models produce an error naming the model.
Other models use `AGENT_PRICE_ELEVENLABS_OTHER_LLM_MINUTE_USD`, default `0.05` USD per minute, plus the configured Agents rate.

### Moving files with any tool that takes a URL

Enable `file_link` to sign a GET or PUT URL for one workspace file (5 minutes by default, at most 15), and hand it to
any tool, such as a shell on a machine behind your own MCP server. `file_import` streams a public URL into a writable
path. Neither sends file bytes through the model. A PUT needs a size cap; imports allow up to 256 MiB and use the
outbound guard and the storage quota.

Files returned by tools an application attaches are now saved to the workspace, as an MCP server's already are. A
resource link from a server without `fileArguments` stays a link, with a hint to use `file_import`.

`computer_upload` and `computer_download` now use the same signed links, valid for 120 seconds, with size and SHA-256
verification. A link can be reused until it expires. Migration 100 drops `computer_transfers`. See
`docs/guides/files.md` and `docs/guides/computers.md`.

### One place decides whether a turn ends the run

- The agent asks the host whether a turn ends the run (`finishTurn`: a call waiting for input, `final_output`, a run
  or spend limit, a hand-off) in one place, for a tool round and for an answer alike, from the response and results it
  already holds, instead of reading them back from the journal at the end of every tool round. `turn_end` events carry
  the round's results in call order, as before.
- A steer sent `whileRunning: "steer"` that its run did not take is dropped by the agent itself when the run ends; the
  host no longer keeps its own list of steers to take them back.
- A tool result's `structuredContent` goes to Pi only for a tool that declares an output schema: Pi drops it otherwise,
  and reported each one as an `extension_error` (`pi_report`).

### Fork messages before a compaction or import cut

Forking an early message now succeeds when it predates the source's retained model context. The fork copies
the raw history through the requested point from the history index and journal, without the source's compaction
summary. This also works after obsolete context checkpoints have been reclaimed. Later fork points still use
Pi's retained context. Running turns and unknown messages keep their existing refusals.

The raw context is seeded whole. Normal compaction summarizes an oversized context on the fork's first turn,
in chunks when needed. If old usage counts understate its size, the normal provider-overflow path compacts
and retries. History remains complete. `fork_from_history` logs the source agent, cut index and message count,
without message content.

### GPT-6.1 Terra

The model catalog includes `openai/gpt-6.1-terra`, `azure/gpt-6.1-terra` and
`openrouter/openai/gpt-6.1-terra`, with GPT-6.1 Sol's context window on each provider. Base prices
per million tokens are $1 input, $5 output and $0.05 cache reads. Cache writes
are $1.25. Above 272,000 input tokens, rates are $2 input, $7.50 output,
$0.10 cache reads and $2.50 cache writes.

The base prices come from OpenRouter's 2026-10-26 model list, and OpenAI and
Azure use them too. Other capabilities are assumed to match each
provider's GPT-6.1 Sol entry: Responses API, text and image input, 128,000 maximum
output tokens, and low, medium, high, xhigh and max reasoning. Cache writes and
the long-context tier are assumed to cost half Sol's rates at the same threshold.
Tool-call streaming is unmeasured. With the vendored Pi these are Pi's own entries, at the same prices, and Terra
can also reason not at all (effort `none`). Azure accepts Terra in the configured models
map, but requires a deployment before it can be used; none is added by this change.

### History pages read forward: `after` and `nextAfter`

`GET /v1/agents/:id/history` (and the agent-token history endpoint) accepts `after`, a
message index like `before`. The page holds whole turns from the first turn start at or
after it (from `after` on when that is inside a turn, resuming a page a byte bound split),
oldest first, up to `limit` messages and `maxBytes`. A forward page keeps the
`{ entries, next, total }` shape and adds `nextAfter`: the `after` for the next page, one
past its last message, `total` once caught up. A job that polls reads each new message once
instead of paging back from the newest every run. `next` keeps its meaning (the older page's
`before`), and pages requested without `after` are unchanged.

`after` with `before` is a 400. An `after` older than the history the agent still holds
(compaction dropped it) is answered with what exists and `truncated: true`, not an error;
past `total` it is `entries: []` with `nextAfter: total`, so a caller sees the history
shrank and starts again from `total`.

Use `agent.historyPage({ after: 0, limit: 50 })` in TypeScript or
`agent.history_page(after=0, limit=50)` in Python. Read `nextAfter` from the answer and
pass it as `after` next time.

### History is read from Pi storage by ordinal; the history index writer is gone

History pages, the full history, account export, forks and a context reset's kept messages now read an agent's messages
from Pi storage by ordinal (the columns #481 added), on whichever node serves the request, with every read bounded in bytes
before it reads. Agents no longer write history index chunks: the index writer, the stop-time flush (`historyFlushMs`),
the running agent's history tail, page forwarding to the owning node and the journal backlog read are deleted. A fork's
copied history is stored in the fork's own Pi storage as archive entries instead of index chunks. History from before
an agent's journal (retired host transcripts, older forks) is still read from the existing index chunks until it moves
into Pi storage. An agent not yet placed is placed at its first history read. See `docs/operations/pi-durable.md`.

### Imported history is not charged again

Creating an agent with `initialMessages` charged each imported assistant message's original usage again: a usage receipt, agent spend and a `usage.recorded` event per message. An import is now free. Imported messages keep their usage for context accounting, and new model responses are charged as before.

### Bound full-history reads to 64 MiB

Full-history requests and forks now return HTTP 413 before reading indexed chunks when their stored size exceeds 64 MiB. Read large histories in pages with `limit`, `before` and `maxBytes`.

The console polls the latest bounded page and keeps absolute message indexes when forking. The TypeScript SDK's `history()` collects bounded pages while keeping its existing return type; use `historyPage()` to avoid holding the whole history in your client.

### The history index is gone

Every agent's history is now read from its Pi storage alone: the history index's tables (`agent_history_index`,
`agent_history_chunks`) are dropped (migration 095) after their messages moved into Pi storage as archive entries, and the
move's endpoint (`/v1/operations/history-archive`), the chunk fallback, the legacy coverage's `retired_index_short` count
and the pin backfill's history pages go with them. Journal reclaim's stage 2 now selects every retired host transcript.
Leftover chunk blobs are removed with each agent's purge.

### Bound history pages by bytes

History paging accepts `maxBytes` (16,384 to 4,000,000) to cap the UTF-8 JSON response,
including its envelope. It returns the newest messages that fit and the existing `next`
cursor for older messages. Pages may start inside a turn; a single oversized message
is returned whole. Requests without `maxBytes` keep their existing behavior.

Use `agent.historyPage({ limit: 50, maxBytes: 65536 })` in TypeScript or
`agent.history_page(limit=50, max_bytes=65536)` in Python. The parameter works on
`GET /v1/agents/:id/history` and the agent-token history endpoint.

### `history: "none"` is ignored: every run sees the agent's history

Prompts (REST, the SDKs' `run`, `stream`, `send` and `client.prompt`) and schedules (REST, the SDKs' `schedule`, the
`schedule` built-in, the MCP server's `add_schedule`) still accept `history: "none"` and `"full"`, so existing callers
and stored schedules do not fail, but ignore it: every run, and every wake-up, sees the agent's history, which Pi's
compaction keeps bounded. For a run that sees no history, use a stateless run (`docs/guides/stateless-runs.md`)
(`POST /v1/runs`, `agents.run({ instructions, input })`). The field is marked deprecated in the OpenAPI schema and the
SDKs; `camelrun schedules add --history` prints a deprecation warning. The runtime logs `history_none_ignored`
(`agent`, `tenant`, `source`: `prompt` or `schedule`) once per agent and source per process, to find remaining callers.

The `schedule` built-in still accepts `history`, described to the model as ignored, so a model that sends it does not
fail; schedules no longer report it. A request that loses every user message no longer fails with code `context_lost`
(that guard served only history-none runs).

### History ordinal fill: records Postgres will not parse

`POST /v1/operations/history-ordinals` no longer fails an agent whose entries hold a `\u0000` or a lone surrogate escape
(Postgres refuses them as `jsonb`; about 1% of agents in the first dry run): such a page of entries is read and shaped
on the node, one record at a time, and the agent is placed as its commits would have placed it. Rerun the fill after
this deploys: agents placed already come back `current`.

### History ordinals in Pi storage

Each history entry in Pi storage now records its place in the agent's history (`msg_from`, `msg_count`, `msg_skip`,
`turn_start` on `pi_durable_entries`; `history_next` and `history_last_id` on `pi_durable_metadata`), kept by every
commit, so history reads can find a page of messages by ordinal in SQL instead of reading the journal from its base.
New agents are placed from their start. Agents from before this release are placed by
`POST /v1/operations/history-ordinals` (operator only; a dry run by default; resumable, bounded, idempotent), and
`GET /v1/operations/history-ordinals-coverage` reports agents not placed yet. The index on `msg_from` is built
concurrently at start. History reads do not use the ordinals yet. See `docs/operations/pi-durable.md`.

### Large history reads in Python and journal backlogs

The Python SDK's `history()` now collects bounded pages, like the TypeScript SDK,
so histories larger than 64 MiB remain readable. Its return shape is unchanged.
History pages that need messages before the journal's base read only the missing
range from the index. The 64 MiB read limit applies to the chunks in that range.

### One history read is capped, and a node near its heap limit names its busy agents

A read of an agent's history messages from its journal (`JournalHistory.messagesFrom`: a turn's messages on resume,
the history index's tail on a page read) fails past 64 MiB of message JSON, rather than taking it all into memory.
On 2026-10-27 from 13:00Z such reads took nodes to their 2 GB heap limit about once a minute, and the orphan sweep
carried the work to the next node. `agents_resumed` now lists the agents a sweep loaded, and `node_load` lists
`busyAgents` (those with work running) while the heap is past 1 GiB.

### jemalloc for the runtime's node process

The image preloads jemalloc (`LD_PRELOAD`) for the runtime's node process. With glibc, memory a voice media worker
thread allocated stays reserved in that thread's arena after the worker is ended, so the node's RSS steps up with each
worker kill: measured, 32 kills left a node at 713 MB against 80 MB before them; with jemalloc, 144 MB against 100 MB.
Baseline RSS is about 20 MB higher. Confined processes (v8-exec, file parsing) and agent processes do not get
`LD_PRELOAD`: the launcher gives the former an empty environment and `agentProcessEnv` does not pass it. The build fails
if jemalloc does not load. To turn it off without a rebuild, set `LD_PRELOAD` to empty in the task definition.

### Reclaim superseded journal checkpoints

Operators can size and reclaim obsolete context copies in idle sessions with
`scripts/ops/reclaim-checkpoints.ts`. Dry run is the default; apply rechecks idleness under session locks and keeps
native history, compactions, seed markers and every reserved ID. See the runbook (`docs/operations/journal-reclaim.md`).
Journal forks before the newest retained context head use raw history from the history index and journal.

### Journal reclaim stage 2: retired host transcripts

`scripts/ops/reclaim-checkpoints.ts --stage host-transcript` removes a retired host transcript's records, archive and
snapshot document, for sessions whose history index holds the history before their journal's base: dry run by
default, idle sessions only, one transaction each. See [Reclaim superseded journal checkpoints](journal-reclaim.md).

### Judged tool approvals

A definition's MCP servers and OpenAPI sources take a fourth approval policy:
`"approval": {"default": "judged"}` (or `judged` for one tool in `tools`). Before
each call, the runtime asks the decision model (`typesafe/jev-1.14`, the one
`decide` uses) whether the call is an ordinary reversible step toward the
request. An ordinary call runs with no person in the loop; a call that may
irreversibly delete or rewrite what already existed, write to production or
change permissions asks the person, as `always` does; a call that would send
credentials, secrets or private data out of the user's systems is denied before
it runs, and the model reads that denial as the call's result. A judge that
cannot answer — no OpenRouter key, a spent spend limit, a provider failure, an
answer it cannot read, or arguments or a description past what it is shown —
asks the person, so a judged call never runs unjudged; so does a turn with no
request of its own (a prompt sent with no text), since a request is the only
thing that can authorize a call.
A denial is not remembered: the next call is judged on its own, and shows in a
run's outcome as `tool_error`. A resumed turn is judged against the request that
started it, not against nothing.

A judged call costs about $0.00003 (Jev bills input tokens at $0.042 a million)
and is billed as a decision is, under `kind: "decision"`, with an end user's
credit holding and settling it when they pay. The judge sees the request's start
and end (2,000 characters), the 4,000-character description the model is shown,
and 8,000 characters of the call's arguments; past those it asks rather than
guessing. Each decision logs `tool_judged` (tool, decision, risk, and why it
asked), never the request, the arguments or the answer. Judged tools are
declared to the model directly, since code in `js_exec` cannot wait for a person.

Implementation: `src/tool-judge.ts` (the questions and the decision table),
`src/tool-sources.ts` (the gate), the judge is built per session in
`src/client-sessions/spend.ts` (`judgeFor`). Limits: `JUDGE_LIMITS` in
`src/limits.ts`.

### Messages that land without a turn are compacted

Pi checks its compaction threshold only as it prepares a model request, so an agent that kept receiving messages without
running a turn (a credit- or spend-stopped agent's sub-agent notices, notices past the wake cap) grew its context without
bound. After such a message lands, the host now applies the same check, and past the threshold starts Pi's own
compaction (`Conversation.compact()`), unless one is already listed. The write never waits for the summary. A turn that
starts meanwhile waits for that compaction and starts on its summary, instead of compacting the same context again. The
model sees the change only as the summary text.

- The context is read only when the last measure plus the tokens landed since cross the threshold, and only after the
  #433 range-size check passes; a range too large to load is skipped and logged (`compaction_skipped`).
- A summary that fails (a bad key, a refused payment) is not retried for 5 minutes of landings.
- Summaries are model calls billed to the tenant, credit-stopped agents' included: about one summary per window of
  landed content. Between runs their usage is reported as the agent's background work (`background: true`).

### A person can spend the credit they have

- With end-user credits on, a model call whose estimate is more than what is left now starts anyway when the shortfall
  is within $0.25, holding what is left, where it was refused (402 `END_USER_CREDIT`) with up to the cost of its input
  left. What it costs past its hold is written off and recorded as any write-off is (`writtenOff`, `end_user_written_off`):
  the tenant bears it, no balance goes negative, and no daily or bucket limit is passed. With nothing left, calls and
  runs are refused as before.
- The same holds for fixed holds: transcription, images and each realtime voice answer. A realtime voice session starts
  with any credit left, not only with one answer's $0.05. `EndUserCredits.refusal` no longer takes `usd`.

### Legacy format coverage endpoint

`GET /v1/operations/legacy-coverage` (platform operator token only) counts the agents that still need the retired and
legacy history readers: host transcripts never retired, retired ones whose history index is short of the journal base,
Pi sessions with no journal history, and agents with no Pi storage (with and without hot legacy-log rows), with up to
20 agent ids per nonzero count and a `gate` saying whether the readers can go. It walks agents in batches with a few
index lookups each (never a scan of `pi_durable_entries`), about 20 s per call, and answers a `next` cursor carrying
the counts until `complete`. Each batch is read-only, each statement stopped after 20 s. See
`docs/operations/pi-durable.md`.

### Legacy history formats are refused, not read

Every agent in a legacy history format was converted by `POST /v1/operations/legacy-migrate`, and legacy coverage read
0. The readers of the host transcript's records, its retirement, the legacy log, and the migration endpoint itself are
removed. An agent whose history is still in such a format (none should be) is refused with `409 AGENT_NOT_MIGRATED` and
its storage is left untouched; each refusal logs `legacy_format_refused` with the agent, tenant and `kind`:

- `host_transcript`: a host transcript no release retired.
- `not_on_pi`: Pi storage without a journal history (a session rolled back to the legacy engine, or imported before #322).
- `legacy_log`: no Pi storage, but a legacy log (a session from before Pi).
- `history_before_base`: a history read reaches before the journal's base, and the history index does not hold it.

`GET /v1/operations/legacy-coverage` stays, to check none appears. The supervisor's `closeTurn` no longer takes a history
index (only the retirement used it). Legacy logs themselves are not deleted.

### Limit hits are logged with the tenant

A `limit_hit` line (`tenant`, `limit`, `status`, `route`) when a limit refuses someone with a 402, 413, 429 or 507, in the
API, the volumes and `TOOL_FILE_LIMITS` (`tool_file_*`); never what was refused. One line per tenant, limit and minute on
each node, then `limit_hit_repeats` with how many more came. `turn_metrics` for `spend_limit` and `turn_limit` turns adds
`tenant`, and `limit` and `limitReason` where known. Per-address 429s carry the tenant when the request's credential
checks out, and `tenant: null` otherwise.

```text
filter type = "limit_hit" | stats count(*) by tenant, limit, status, route
```

### Luna context windows and model usage

#410 was reverted after its fixed 272,000-token Luna cap made working 300–500k-token chats compact on every turn. The unbounded summary requests then failed and blocked those turns. OpenRouter and other aggregators now keep Pi's catalog window, including routing variants and the latest alias. Native OpenAI and Azure keep their catalog windows.

A Luna stream failure with no output and a prompt over 272,000 tokens triggers overflow recovery. Learned token limits survive restarts. Limits cannot fall below 32,768 tokens or half the catalog window (half the native 272,000-token window for Luna). Byte-size refusals do not lower token limits. Summary requests split large histories into chunks that fit the effective window, carrying the previous summary forward. Compaction and summarization failures have their own metrics class.

Failed model calls without usage evidence are never billed an estimate retroactively. Unreconcilable calls settle at zero when no usage was reported; platform Azure and ordinary tenant provider endpoints are not classified as gateways. Reconciliation waits past the maximum turn time and preserves the credentials recorded for the attempt. Real provider evidence can raise or lower an end user's charge, subject to the original usage day's limits. Calls still streaming refresh their activity time, and a late real finish bills its full reported usage. Direct OpenRouter credentials continue to reconcile against the provider's generation record.

### Managed computers

An agent can have a Linux computer with no provider account of your own: choose **Managed (no key needed)** under
Computers, or `POST /v1/computers` with `provider: "boat"` and no credentials. It is a small machine for work in the
foreground, charged to credit at what it costs while it runs, and an account starts one once it has bought credit.
`AGENT_MANAGED_COMPUTERS` turns them on, off by default, with `platformKeys.boat` in the tenants file. See
`docs/guides/computers.md`.

### Ops: sign-ups and activity by MCP plugin (ChatGPT, Codex, Claude)

The ops dashboard has an MCP plugins tab (`GET /ops/api/mcp?days=7|30|90`). It reads existing tables; there is no migration or change to OAuth authentication.

- Sign-ups: self-serve `tenants.created_at` in the selected window, classified by the first retained `oauth_grants` row if it was created within one hour (inclusive). Later connections do not change acquisition. The Growth source report joins these accounts through `journey_accounts.account_ref` and substitutes the plugin label, including sign-ups whose browser ran in the OAuth flow. Growth joins first-touch sources from the journey store with local signup and usage counts. Missing sources stay Not captured, and plugin labels remain available without a journey connection.
- Daily and weekly token activity: distinct accounts by kind from `oauth_grants.used_at`. Weeks start Monday UTC and cover only the selected dates. The column stores **token issuance/refresh**, not authenticated requests, and overwrites earlier activity. These are not complete historical MCP active-account counts; they can decrease as tokens refresh outside the window.
- Funnel: accounts signed up in the window that have authorized each kind by now, then have an `agents` row or model-response usage, then model-response usage in `usage`, then usage on a day after their first response. Each step is a subset of the previous step. Progress is account-wide, including work outside the plugin. An account can appear under multiple kinds. Removed agents can be inferred from retained usage.
- Tool calls: omitted. Neither hosted MCP (`src/hosted-mcp.ts`) nor per-agent MCP (`src/agent-mcp.ts`) stores incoming tool-call records with an OAuth grant/client. Model usage and outgoing MCP tool activity cannot establish the caller's plugin.

All metrics exclude staff and erased accounts by the existing admin rules. Revoking a grant deletes it, so both attribution and authorization counts can disappear or change to the next retained grant. The report does not claim durable first-touch history.

Registration data is in the signed `oauth_grants.client_id` payload (`n` = name, `r` = redirect URIs, `m` = auth method). The report decodes only stored registrations; it does not accept these ids as authentication. Exact HTTPS callback hosts `chatgpt.com` / `chat.openai.com` identify ChatGPT and `claude.ai` identifies Claude. Otherwise exact names ChatGPT, Codex, Claude and Claude Code are recognized, case-insensitively. Unrecognized registrations remain Other MCP; a loopback callback alone is not Codex. These fields are client-declared, not verified vendor identity.

Evidence for matching (checked 2026-10-21):

- [OpenAI plugin authentication](https://developers.openai.com/plugins/build/auth) describes ChatGPT's `chatgpt.com` callback URIs.
- [Codex's OAuth registration implementation](https://github.com/openai/codex/blob/main/codex-rs/rmcp-client/src/oauth_client_registration.rs) sends `with_client_name("Codex")`; its callback is loopback, not a uniquely identifying host.
- `src/oauth.ts` `register`, `clientId`, `exchange`, `issue`, `authenticate` establish the local storage format, grant creation, last token timestamp semantics, and absence of per-request writes. No production data was queried.

### Retire nodes under sustained memory pressure

`AGENT_MEMORY_RETIRE_MS` enables memory retirement after sustained pressure, plus up to 10 minutes of per-node jitter. It defaults to 0 (disabled); ECS sets 10 minutes. A claim requires a live, non-draining peer below its memory threshold, with one retirement at a time and at least 10 minutes between claims. Nodes publish their memory pressure with their heartbeat.

A retiring node stops taking agents, hands turns to peers, and calls ECS StopTask on its own task. `/healthz` stays 200 while ECS deregisters and replaces it; the first SIGTERM joins the drain without cutting turns. Without an external signal, `AGENT_MEMORY_RETIRE_FALLBACK_MS` (default 10 minutes after claiming) finishes the drain and exits 0, or 1 if the drain fails. Handed-off turns record `memory` in `handoffs[].reason`.

The task role needs `ecs:StopTask`; apply `infra/terraform/ecs.tf` to enable this path. If StopTask is unavailable or fails, the node uses `/healthz` 503 only when its deployment is current. Otherwise it releases the memory claim without undraining and retries after backoff. Logs identify the StopTask, health-check, or deferred path.

### Native computers

Agents can connect to Modal, Daytona, Boat, E2B, Browserbase, Browser Use Cloud, or a Docker runner
reached through Cloudflare Tunnel. The Computers page stores provider credentials
encrypted, attaches shell or browser tools automatically, and shows session state
and compute seconds by workspace. Providers bill the connected account directly.

Sessions have fixed expiries and daily time budgets. Durable operation receipts
prevent duplicate mutations after retries. Cleanup is retried; credentials and
references are removed after successful disconnect. Account deletion waits for
provider cleanup. The setup and recovery guide is `docs/guides/computers.md`.

### Native Pi system sections for every agent

`AGENT_NATIVE_SECTIONS_TENANTS` is gone: every agent's system sections are native Pi sections, as they have been in
production (`*`) since the canary finished. The non-native path, which gave Pi's generation the host's sections in place
of its agent's through the task override, is removed. A conversation still under the old `instructions` key is re-keyed
to `application` as it loads, with the same prompt text, as before. Self-hosted nodes that left the variable unset now
render sections natively too; the variable is ignored if still set (the Terraform variable can be dropped with the next
infrastructure change).

### Search engines are asked not to list the console or the docs' Markdown copies

The console and the pages that lead to it (`/`, `/console` and everything under it, its sign-in, billing and Discord
routes, and `/oauth/authorize`) now answer with `X-Robots-Tag: noindex`, and so does every document the runtime
serves for agents: `/llms.txt`, `/llms-full.txt`, `/SKILL.md`, `/docs/**/*.md` and the UI registry's `/r/*.json`.
The runtime also serves a `/robots.txt` that blocks nothing, so crawlers can fetch those pages and see the header.
The documents' bodies, types and caching are unchanged, and so are the API, `/mcp` and the other endpoints.

### A sub-agent's notification survives an abort as its turn opens

When a parent was aborted just as a sub-agent's notification began its turn, before Pi had the message, the notification
was marked landed but never reached the parent's history, so the parent never learned the sub-agent had finished. It now
lands without a turn, as it already did when an abort reached it earlier.

### Any OpenRouter model passes through

`openrouter/<id>` now works for a model not in the catalog. The runtime makes one lookup of that model (`GET /api/v1/models/{id}/endpoints`) when an agent takes it, and the agent keeps what it says: the largest context window, the longest reply every host serves, images, tool support and the dearest host's prices, which set estimates and holds. Calls are billed what OpenRouter reports.

- OpenRouter has no such model, or lists no tool support for it: a 400 when the agent is made or moved to it.
- OpenRouter out of reach: the agent starts with a 128,000-token window and 8,192-token replies, held at $3 and $15 per million. A provider's overflow compacts and asks again, as for any model.
- These models are not listed in `GET /v1/models`. `AGENT_MODEL_FALLBACKS` and `AGENT_CONTENT_FILTER_FALLBACKS` still refuse a name the catalog lacks, so a typo stops the node.
- A model that takes reasoning always gets at least `low`, with no `temperature`: the lookup does not say whether it can turn reasoning off, and a third of OpenRouter's models answer a 400 to that.

### Runtime

Pi compacts once when a model rejects a turn for exceeding its context window. If the retried request still overflows,
the turn now fails with the provider's overflow error. Later turns use the learned smaller window. The runtime no
longer retracts that final failure to compact and retry a second time.

### Particle-1 on OpenRouter, at the price OpenRouter charges

`openrouter/particle-ai/particle-1` is listed at $0.05 input, $0.50 output and $0.003 cached per million tokens, in place of the $0.25, $1 and $0.03 the catalog carried. `toolCallStreaming` is `false`. Particle AI is its only provider, so there is no other host to route to when it is down. A request with an image in its context cost about $0.002 more in our tests, which `GET /v1/models` does not show. Calls were and are billed what OpenRouter reports; the listed price sets estimates and holds.

### Task size and memory watch for Pi

Terraform runs 1 vCPU / 4 GiB tasks with the admission threshold
(`AGENT_MEMORY_HIGH_BYTES`) at 65% of them (2.6 GiB) and `node_load` every five
seconds (`AGENT_LOAD_INTERVAL_MS=5000`), which logs Node heap, RSS, voice workers
and the visible cgroup current/high-water memory; the default stays 60 seconds.
The cgroup may include helper processes: do not read it as the Node heap alone.
The `-task-cgroup-memory` deployment alarm (cgroup memory over 3 GiB) replaces the
hand-made `-pi-canary-memory` alarm.

### Pi context size metrics

Pi model requests now log `held_tokens`, `sent_tokens` and `held_sent_ratio` in CloudWatch
namespace `AgentRuntime`, with only `ServiceName` as a dimension. Both counts use the same
estimator, before context trimming and after request conversion respectively. Agent ids remain
plain log fields. A `context_divergence` warning appears at most once per host run when held
tokens exceed both four times sent tokens and 50,000.

The existing context size guard also reports `context_range_bytes` and `context_range_entries`
at host load and the first model request of each run, without extra SQL. Committed tool results
report `tool_result_details_bytes` (serialized JSON) and `tool_result_inline_image_bytes`
(stored base64 payloads). Contents are never logged. Held estimates reuse unchanged message
objects; each request walks the message list without serializing the whole context. These
metrics do not change model-visible messages or compaction behavior.

### Smaller stored tool results

Direct JSON tool results no longer repeat their content in `details`. Other direct-tool details over 16 KiB of
JSON, and js_exec details over 32 KiB, become `{ truncated: true, path? }` in events and history. The full JSON is
saved beside tool output in `tool-results/` when a writable workspace is available and it fits the 700 KiB
file-write limit; otherwise it is dropped. Values past 700 KiB log `tool_details_dropped` with the agent, tool
and byte count only. Model-visible content, input-required markers, and `final_output` results are unchanged.

User-entry deduplication is off by default. `AGENT_PI_DEDUPE_USER_ENTRIES=true` stores content only in the model
message; readers accept both formats. Leave it off until this reader is deployed everywhere and older releases
are no longer rollback targets: older readers require content in `data.message`.

### Vendored Pi carries no patches of ours (can be rolled back)

A fork reads its source's context through Pi's own derivation on a read-only viewer Harness again (Pi's recommended
way for a reader), instead of our patch `readStoredContext`. That was the last patch: the vendored packages are now
Pi's own build, `1.4.0-main.f09d01b85e03`. The fork point refusals (before the newest head marker, inside an entry of
several messages) and the compaction kept-range cut are unchanged. No stored format changes.

### Pi durable 1.4.0

The runtime moves to `@earendil-works/pi-durable` 1.4.0 with `pi-ai`, `pi-agent-core` and `chord` 1.4.0 (`pi-ai` was 1.1.0
at the top level, 1.3.0 inside pi-durable; there is now one copy).

- **No migration.** Pi 1.4.0 adds a `sleeping` task status (durable sleeps for retry and deferred-poll backoff) and a
  `restarts` count on task records. `pi_durable_tasks.status` already allows `sleeping` (078), and `restarts` lives in the
  JSON `record`. Pi's own SQLite schema-2 rebuild does not apply to the Postgres storage.
- **Rolling deploy and rollback are safe.** Generation retry is off (`retry.enabled: false`, so compaction retry is
  off as well), and no provider returns deferred responses, so this release never writes a `sleeping` task. A 1.3.0 node that
  opens a session after a 1.4.0 node ignores `restarts`. It carries the field along unchanged, without the reset on
  progress, so during the rollout a task's count can be stale; `AGENT_MAX_RESUMES` still ends turns first (below).
  Rolling back needs nothing.
- **Crash-loop guard (Pi default, 5).** Opening a session counts a restart for each task that was running when its node was
  lost, and parks a task after 5 restarts in a row without progress. A clean close (drain, retire, memory hand-off) does not
  count. `AGENT_MAX_RESUMES` (default 2) still ends a turn first: the third node loss fails the run with `resume_limit`
  before Pi's count reaches 5. Pi's guard is a backstop for work our count does not cover, and for `AGENT_MAX_RESUMES` ≥ 5.
  `pi_report` logs now carry `report` (for example `task_faulted`) and the task kind and id. (Parking is gone again with
  the vendored Pi: see "Pi from its main branch, vendored".)
- **No Pi attribution headers.** Pi 1.4.0 attributes every model request to pi by default: OpenRouter `HTTP-Referer:
  https://pi.dev` and `X-OpenRouter-Title: pi`, plus NVIDIA and OpenCode origin headers. The runtime sets `identity: {
  attribution: null }`, so it sends none of these (as before). `User-Agent` stays pi-ai's default `pi/<version> (…)`,
  as with 1.1.0.
- **pi-ai catalog moves from 1.1.0 to 1.4.0.** Models the platform prices itself keep their overrides
  (`src/pi-catalog.ts`). Dropped because Pi now has them: Anthropic Sonnet 5.5 cache reads at $0.10, OpenRouter Gemini
  3.8 Flash at list price, and the added OpenRouter DeepSeek V4.1 Flash 1017 entry (same list price). Changes agents will
  see: OpenRouter DeepSeek V4.1 Flash's longest reply drops from 943,718 to 393,216 (DeepSeek's own endpoint); Anthropic
  `claude-sonnet-4-5` has a 200,000 window, not 1,000,000; many OpenRouter list prices moved (for example
  `openai/gpt-5.6-sol` doubled, and `deepseek/deepseek-v4-pro`). OpenRouter calls are still billed what OpenRouter reports;
  catalog prices drive estimates, holds and calls that report nothing. Claude Haiku 5.5 can now turn thinking off
  (pi-ai 1.3.0 fix), so a call that asks for no reasoning on it sends none instead of the minimum level. Pi removed
  `openai-codex/gpt-5.5` and `gpt-5.3-codex-spark`, which the Codex backend rejects for ChatGPT accounts, and some old
  OpenRouter ids such as `anthropic/claude-sonnet-4`, `deepseek/deepseek-r1` and `qwen/qwen3-max`. New agents
  cannot name a removed model; existing agents keep the model they were created with.

### Pi durable execution

Every agent runs on Pi durable 1.3.0, in process or inline hosting. Pi owns
execution, canonical history and compaction. The host loads a bounded native
checkpoint and uses indexed request admissions; it does not replay a legacy
transcript.

Postgres responses and summary usage commit with durable accounting receipts and
agent spend. Receipt consumption atomically updates daily usage, prepaid charges
and webhook events, including after a crash or concurrent worker retry.
Production's durable model-attempt accounting and end-user credit holds remain
authoritative; native fallback receipts do not charge those tracked calls a second
time. Storage metering is deferred.

### The host transcript is removed: an agent's history is its Pi journal

Every agent's history and model context are now Pi's journal alone: Pi's messages, the messages the host makes
itself as native entries, and its turns, retractions, waiting calls and skips as markers. The host transcript
(`camel.host.snapshot`, `camel.host.record`), its dual write and dual read, and its working set that runs checked
into Pi's context are gone. A session's first load on this release retires its host transcript, once: it indexes
whatever settled history before the journal's base its history index lacks, then disables the host document
(`retired: "journal"`), and logs `host_transcript_retired`. A release before this one then refuses the session
(409 `AGENT_NOT_MIGRATED`), so a rollback below it is one-way. See `docs/operations/pi-durable.md`.

`AGENT_HISTORY_BACKLOG_BYTES`, `AGENT_PI_DUAL_WRITE`, `AGENT_PI_DUAL_READ` and `AGENT_PI_HISTORY_SOURCE_TENANTS` are
ignored (`settings_ignored`), and their Terraform variables (`agent_pi_dual_write`, `agent_pi_dual_read`,
`agent_pi_history_source_tenants`) and the `-dual-read-mismatches` and `-history-source-mismatches` alarms are
removed: apply with this release's image, never before it. Migration 084 drops the `pi_sweep` table.

What the model is sent changes in two places, for the same content: after a Pi compaction, requests carry Pi's own
compacted context (its summary and kept messages, after its system message with every section in effect) rather
than the host's copy of it.

### Fewer database round trips per Pi step

Pi sessions on Postgres make about 40% fewer database statements per model call: a commit takes its sequence in
the metadata lock, checks its IDs and documents in one read and writes everything in one statement, and journal
reads fetch their conversation in the same statement. A turn's first model request starts sooner, and so does each
tool round. New metrics separate the runtime's part of time to first token from the model's: `TimeToFirstRequestMs`
on `turn_metrics`, and `RequestFirstTokenMs` on `model_response` ([architecture](architecture.md)).

### A person's answer survives a deploy that lands as their question is asked

When a node stopped just as a tool call began waiting for a person, the next owner could lose track of the wait: the
question was already shown, but the answer was then accepted and dropped, and the turn ended without it. The call now
stays waiting on the next owner, and the answer reaches the run.

The host's journal now always writes through Pi's Session. A journal write made once an agent is closing is refused and
logged (`journal_write_refused`, with the kinds of record it held), except a call left waiting for a person, which is
stored. The next owner goes on from what is stored, as after a lost node.

### The legacy engine and its importer are removed

The pi-agent-core loop that ran agents before Pi durable is gone, with its host
compaction, the `AGENT_ENGINE` switch, the Pi canary allowlists, the rollback
from Pi to it, the one-way importer of legacy sessions and the migration sweep
(`AGENT_PI_SWEEP`, `/v1/operations/pi-sweep`, `infra/pi-sweep.sh`). A node with
`AGENT_ENGINE`, `AGENT_PI_CANARY_AGENTS`, `AGENT_PI_CANARY_TENANTS` or
`AGENT_PI_SWEEP` set still starts, ignores them and logs `settings_ignored` once.

Every format the imports wrote is still read, including imports too large to copy,
whose history reads their legacy log first. A session whose history is still only
in the legacy format is refused with 409 `AGENT_NOT_MIGRATED` (logged as
`legacy_session_not_imported`), and nothing is written. New agents and forks are
seeded straight into Pi. See `docs/operations/pi-durable.md`.

### Live Pi compaction limits

Pi sessions now apply changes to `runLimits.contextTokens` on the next request,
including recalculating how much context to reserve and retain. Host checkpoints
preserve message boundaries so Pi can compact across separate user turns as well
as long tool loops. Full history remains available.

### One compaction path

Agents always use Pi's native context selection and compaction. The adapter's
older host-compaction mode and its extra context checkpoints have been removed.

This does not change journal storage or the public session API.

### Pi storage is ready for the next Pi release's commit contract

The next `@earendil-works/pi-durable` release calls `Storage.commit(writes, adopt, context)` and expects the storage to
call `adopt(seq)` once, synchronously, when the batch is durable and before its next commit. camelRun's Postgres
storage, its SQLite wrapper and the agent-process RPC storage (`remotePiStorage`) take that shape, never adopt a commit
that failed, and adopt a commit whose answer was lost but landed exactly once. (The vendored Pi uses it: the shapes
for Pi 1.4.0 are gone again.)

### A leaving node hands its turns to Pi on the next owner at once

A node that retires (a deploy), drains with a live peer, or leaves under memory pressure no longer waits for each
running turn to reach a step boundary. It closes each agent's Pi harness at once, mid-step and without an abort, records
the hand-off on the run (`handoffs`, with what the run gathered), and its peer's Pi goes on with the run where it was: a
model request the close cut is made again; a tool call in flight is answered as interrupted ("was interrupted and may
have partially run"), or made again when it is safe to repeat (`delegate` and the other multi-agent tools, declared
`replay: "safe"`). A code execution (`execute`) still finishes where it runs, up to `AGENT_RETIRE_MAX_MS`.

A node lost mid-turn (a crash) recovers the same way: the next owner resumes Pi's run instead of aborting it and
repairing the turn. A model request the crash cut ends Pi's run `interrupted` (Pi's retry is off), and the runtime asks
again once (`task_interrupted` in `pi_report`). Turns lost between Pi's runs (a host retry's backoff, say) are still
closed by the runtime as before.

Visible: drains are faster; a non-replay-safe call in flight at a deploy or drain is answered as interrupted (before,
only at a crash). `RunStop` loses `handoff`. Watch `turn_handed_off`, `task_interrupted` and turn outcomes after deploys.

### Sessions a later release moved to Pi's journal alone are refused as newer

Once a later release reads a session's history from Pi's journal alone, it retires the session's host transcript
(the host document's `retired`). This release refuses such a session with 409 `AGENT_NOT_MIGRATED` saying its history
format is newer than this runtime (logged as `session_format_newer`), rather than continue from the frozen host
transcript, and writes nothing. Run a newer release.

### Retries without Pi patches

Vendored Pi drops two of our patches, `GenerationHooks.beforeRetry` and `settings.retry.keepRetried`
(`1.4.0-main.f09d01b85e03-camel.2`). The host still decides every retry, now through `settings.retry` getters that Pi
reads as it classifies a failed request, and through the adapter's stream for failures Pi would not make again (a refused
forced tool choice or image, a cut lease, DeepSeek's reasoning-replay refusal). Attempts made again, the overflow Pi
compacts for, and the partial answer a lost node left in flight stay in Pi's journal marked `retried`, and out of the
history, events and billing as before. Retry events, delays and limits are unchanged.

No stored document or task version changes: this deploy can be rolled back.

### Ending a run after a tool round without a Pi patch

Vendored Pi drops our `afterTools` `{ end: true }` patch (`1.4.0-main.f09d01b85e03-camel.1`). The host still decides
after each call of a round whether the run ends there (a call waiting for input, final_output, a run or spend limit):
the first call that ends it, and every call after it, return `control.terminate`, and when a call of the round had
already settled, the conversation's turn limit ends the round, so Pi makes no further model request. The round's end is
committed with the decision, so a node that takes over a round a lost node left open ends it too. Run outcomes, inputs
and replies are unchanged.

No stored document or task version changes: this deploy can be rolled back.

### Pi's own storage failure rule

The agent no longer wraps its Pi storage in a proxy that re-implemented Pi's rule for which storage failures fail the
Session. Pi 1.4 guards its own storage calls and reports `session_failed`; the agent ends its run with
`PERSISTENCE_FAILED` and is given up on that report, as before. A storage that fails to close also counts now, as Pi
treats it.

### Remove Pi migration scaffolding

Remove the unused rollback helper, the migration dashboard check and temporary system-prompt hash logging.
Persisted journal kinds and seed metadata stay unchanged. Bounded legacy-import reads are replaced by log
emptiness checks; the unused importer replay path is removed. First-load host transcript retirement,
history-index backfill, old-row reads, forks, compaction and both reclaim stages remain.

Terraform no longer sets `AGENT_ENGINE` or accepts `agent_engine`. A human Terraform apply removes the env
from the ECS task definition. Retired runtime settings remain accepted with a `settings_ignored` warning until
infrastructure stops setting them. Rollback below the host transcript's removal is no longer supported.

### Pi vendored at main a14cdf90f0a7

Pi's Session now stores commits in groups and makes no storage reads in a normal run. Nothing changes in the API. An
agent's Pi steps no longer wait for one another's database round trip, and a run reads less from Postgres.

The Postgres storage implements Pi's new `Storage.commit(batches, receive, context)`, each batch in its own transaction
as before. The host's journal writes now go through Pi's Session while an agent is open, since Pi keeps a conversation's
newest entry and a run's context from its own commits: a failed journal write now fails Pi's Session too, and the agent
is given up and reloaded, as after a failed Pi commit.

No stored format moved: this deploy can be rolled back. Models and prices are unchanged.

### Pi bumped to main f09d01b85e03 (can be rolled back)

The vendored Pi moves from `02a2b2532d8f` (2026-10-28) to `f09d01b85e03` (2026-10-29), versioned
`1.4.0-main.f09d01b85e03-camel.4`; our four patches apply unchanged (only their changelog context moved).

No stored document or task version changes (`pi.live`, `pi.tool`, `pi.generation` and the rest keep their versions)
and no change to the Postgres storage: this deploy can be rolled back.

What changes for the runtime:

- **Closing an agent is no longer read as a storage failure.** Pi now ends a commit observer `failed` ("session
  closed") when its Session closes, where it ended it `ended`. The agent gives itself up on a `failed` end, so without
  the adapter change every close (an idle unload, a hand-off) would have reported `Session persistence failed` and a
  handed-off turn would have failed instead. The adapter now ignores the end after its own close.
- **pi-ai**: a Zhipu/Z.ai plan usage limit (error code 1308, sent as HTTP 429) is no longer retried.
- Upstream's other changes are new APIs the runtime does not use (`StoreStorage` on Chord v2's store,
  `registryReader`, Chord v2 slices) and coding-agent/TUI changes outside the vendored packages.
- **OpenRouter DeepSeek V4.1 Flash still asks for at most 131,072 output tokens.** Pi's catalog moved its longest reply
  to 943,718, which OpenRouter would route only to hosts that serve that much (Nebius, one of its five allowed hosts,
  serves 943,200) and which, with a long input, asks for more than the 1M window holds. The runtime now caps it at
  131,072 as it does 1017 and Azure Flash, agents made before included.
- **Model catalog** (pi-ai's, generated when the commit was vendored): 7 OpenRouter/Vercel/Mistral models added, 1
  removed (`openrouter/upstage/solar-pro-3`), and list prices moved on some OpenRouter entries (V4.1 Flash, V4 Pro,
  Kimi K3, GLM). V4.1 Flash, Kimi K3 and GLM 5.3 keep our own prices (`src/pi-catalog.ts`), and OpenRouter calls are
  still billed what OpenRouter reports. The Anthropic, OpenAI, Google, Azure, Bedrock and DeepSeek entries are
  unchanged.

### Vendored Pi carries our own patches

`vendor/pi/patches/*.patch` are changes of ours to Pi, applied on top of the vendored commit by `scripts/vendor-pi.sh`
before it builds (`docs/operations/pi-vendoring.md`). The packages are now versioned
`1.4.0-main.02a2b2532d8f-camel.4` (upstream version, `main.<commit>`, `camel.<number of patches>`), so a build of ours never
passes for an npm release. The four patches add Pi features the host does not use yet (no behaviour change):

- `GenerationHooks.beforeRetry`: the host decides whether and when a failed model request is retried.
- `settings.retry.keepRetried: false`: failed attempts that are asked again stay out of the transcript.
- `afterTools` returning `{ end: true }` ends the run after the tool round.
- `readStoredContext(storage, conversationId, context, { at })`: Pi's context derivation from Storage alone.

No stored document or task version changes: this deploy can be rolled back.

### Pi from its main branch, vendored (cannot be rolled back)

**This deploy cannot be rolled back.** The first session a node on this release touches is stored in formats Pi 1.4.0
cannot read: `pi.live` version 3, and in-flight `pi.tool` version 3 and `pi.generation` version 2 tasks. A node on the
release before fails to open such a session (`Document … (pi.live) has newer version 3 than 1`), and it works again
once a node on this release loads it. The old node does write first, though: loading an agent whose turn was still
open (its node died or handed it off mid-turn), it repairs that turn (retracts a cut-off response, answers lost calls
as unknown) or closes it in the journal before Pi's open fails, so that turn ends instead of resuming. So if this
release misbehaves, roll forward with a fix: a rollback (by hand, or ECS's circuit breaker or a deployment alarm)
makes every agent that ran on it fail to load until the next deploy, and fails the turns that were running. During
the rolling deploy the same can hit an agent that ran on a new node and was loaded next by an old node that has not
started retiring yet: one idle for 5 minutes (unloaded; it fails to load), or one whose new node died or drained
mid-turn (its turn fails); sessions from the release before open on new nodes as usual.

The runtime now runs on Pi built from commit `02a2b2532d8f` of its main branch (2026-10-28) instead of the npm
release 1.4.0: `vendor/pi/` holds the six packages (`pi-durable`, `pi-ai`, `chord`, `pi-codemode`, `pi-telemetry`,
and `pi-agent-core` for types), `vendor/pi/PI_COMMIT` names the commit, and `scripts/vendor-pi.sh <sha>` bumps it
(`docs/operations/pi-vendoring.md`). Nothing of Pi comes from npm any more. The published SDKs never depended on Pi.

What changes with it:

- **Runs a lost node left are no longer parked.** A model request in flight when its node died is not sent again on
  open: with Pi's retry off, the run ends at once with "The host stopped while the model was answering" (Pi's
  `runFailure` reason `interrupted`). Work cut off `restartLimit` (5) times in a row ends instead of parking: a tool call
  with an error result (its outcome is shown as unknown, like an interrupted call's), a generation with the run failed
  (`restart_limit`). The runtime's own resume of a turn its node lost (`AGENT_MAX_RESUMES`) is unchanged. The adapter's
  handling of parked generations ("cut off by repeated node failures") is gone.
- **`pi_report` logs**: `report` is `storage_failed` (was `session_failed`), `task_interrupted` (new; with `reason`
  `interrupted` or `restart_limit`) or `task_outdated` with `reason` `task_too_old`; `task_parked` is gone. Each line
  now carries the report's `reason` where it has one.
- **A continue on a context that ends in an answer** asks no model: the run ends with "The conversation has nothing
  to answer" (Pi's `nothing_to_answer`). Continues the runtime makes itself (after a failed or taken-back response, a
  resumed tool round) end in a user message or tool results and are unaffected.
- **A failed commit observer reloads the agent.** Pi detaches a commit observer that throws (and ends it when the
  Session fails); the agent's would then stop seeing what is committed and could end a turn on an older answer. Now an
  error in it is logged (`pi_observer_error`, the error's type and message) and, like a storage failure, the agent is
  given up (`Session persistence failed`) and loaded again from what was committed.
- **Streamed progress is stored as before**: Pi now defers storing partial answers and tool output by up to 1 s; the
  runtime sets `persistWithinMs: 0`, so each is stored right after its commit, as on 1.4.0.
- **Memory**: Pi no longer copies a growing answer or tool-call argument string on every partial commit, nor re-parses
  streamed tool-call arguments on every delta (a 500 KB tool call took about 20 s of CPU and a 100 MB heap peak).
- **Model catalog** (pi-ai's, generated when the commit was vendored): GPT-6.1 Terra is Pi's own entry on OpenAI,
  Azure and OpenRouter (same prices; it can now reason not at all, `thinkingLevel: "off"` sends effort `none`).
  OpenRouter DeepSeek V4.1 Flash's longest reply is 131,072 (was 393,216). Several OpenRouter list prices moved;
  OpenRouter calls are still billed what OpenRouter reports. Realtime and image models are no longer chat models
  (`openai/gpt-realtime-2.1`, `google/gemini-3.1-flash-live-preview`), and some old OpenRouter, OpenCode, Mistral and
  Radius ids are gone; existing agents keep the model they were created with. The prices and limits of the Anthropic,
  OpenAI, Google, Azure, Bedrock and DeepSeek models the runtime already listed are unchanged.

Rollout: deploy when someone can roll forward at once, and watch, at 15 minutes and 1 hour: agent loads that fail with
"has newer version" (expected only during the rollout, from old nodes), `pi_report` by `report` (`storage_failed` at
the old `session_failed` rate; `task_interrupted` where node losses were), turn outcomes and `model_error`, Postgres
commit latency and transactions per turn (flat, with `persistWithinMs: 0`), and `agent_memory` (lower peaks on long
answers and tool calls).

### Keep recent images within provider limits

Model requests keep the newest 40 images, or 90 for Anthropic models, including
models reached through gateways. Older images are replaced with text in the
outgoing request. Saved history and files are unchanged. The same cap applies
to summary requests, and image token estimates use the capped request.

If a provider still rejects the image count, the runtime retries once without
images for the rest of that turn. These failures are classified as `image_limit`.

### Agents keep the runtime's rules after a compaction

Since native compaction (#316), every agent lost the runtime's part of its system prompt (how to use tools, files and
results, and who sent a message: the `RUNTIME_CONTEXT` sender rules) at its first compaction, and every request after
it went without them; the application's instructions, the environment summary and the language stayed. The rules were
the system message's content, and Pi's baseline after a compaction writes sections only. They are now the system
message's first section, untagged: a new agent's prompt is the same text as before. An existing agent keeps its prompt
until its next compaction, which now keeps the rules; one that already lost them gets them back, in their place, on its
next request (one request re-declares its sections). No migration: stored contexts are read as they are.

### Calendar schedules and emailed reports

Agents can wake at a local time in an IANA time zone, daily or on selected weekdays,
including daylight saving transitions. The console's Schedules tab creates and
cancels schedules and shows email delivery status. Owners can have successful
scheduled runs email their complete final reply through the runtime's SES mail
configuration. Choose plain text, agent-authored HTML with its own styling, or
Markdown rendered with basic formatting (the default). HTML delivery adds no platform
layout or branding and includes a generated plain-text alternative.
The durable outbox waits for completion and retries delivery errors.

### Signups by source in Ops, kept on each account

The Growth tab stacks daily signups by source. The Sources table compares outside self-serve signups
with accounts that made an agent, ran a model, worked on two or more UTC days, and purchased credit.
It also shows each source's share and the median UTC-day wait to a first model answer. Usage includes
scheduled and channel runs and is counted through today. The range control selects 7, 30 or 90 signup
days; 30 is the default.

Every figure comes from the runtime's own tables in one read; nothing is asked of the journey store,
so the panel answers as fast as the rest of Growth. (Asking the store page by page took 20 seconds
for 414 signups and still left most of them unread.)

A sign-up's source is kept on the account when it is made (`tenants.signup_source`, migration 091),
as camelBot keeps `users.signup_ref`:

- The console sends the `ref` of the link that opened it (`/console/?ref=run-slack`) and the host of
  the site the browser came from when a GitHub or Google sign-in starts, or with an email sign-up.
  They wait in a 10-minute cookie of the sign-in's own (`ar_source`, path `/console/auth`) or with the
  mailed link, and are kept once, on the account the sign-in makes. Signing in again never changes it.
- A browser that sends Global Privacy Control, or whose consent cookie says `denied`, keeps its link's
  tag but not its referrer.
- The sales site tags its links to the console with the page they are on (`ref=home`,
  `ref=run-slack`, `ref=blog/<post>`).

The dashboard's label is, in order: the MCP plugin whose first OAuth grant came within an hour of
signup; `ref=<tag>`; the referring host; Direct (neither shown); Not captured (accounts made before
this release, or by an operator). Missing sources are never counted as direct. The account export's
`account.json` includes `signupSource`.

The journey store's first-touch attribution, campaigns and landing pages are no longer part of this
panel; the Journeys tab still shows them per account.

### Sprites computers

Connect a Fly.io Sprites account from Computers with its API token. Each session
creates a private Linux sprite with shell and file tools. camelRun deletes the
sprite when the session stops or expires. See `docs/guides/computers.md`.

### A message sent just after a prompt joins its turn

A prompt with `whileRunning: "steer"` that arrived after another prompt was taken, but before its turn had begun (the
agent still starting), was queued as a turn of its own, to run after all of the first. A parent's `send_message` beside
its `spawn_agent` met this: the sub-agent did its whole task without the message. It now waits up to 5 s for that turn
and joins it.

### Every message of a prompt is sent; steers are placed by Pi's own boundaries

- **Fix:** a prompt of several messages sent with a `requestId` lost every message after the first: each was submitted
  to Pi under the same request id, which Pi takes for the first. A run's input now goes into Pi's context at once, in
  order, before its first model request (all but the last as entries, the last as the input that starts the run), and
  only the first message of a request carries its id.
- A steer given while a run runs is handed to Pi's inbox as the tool round ends, and Pi places it at that boundary,
  instead of the agent placing it itself before the next model request. One given as the run answers starts a run of
  its own, as before. Steers given while no run is running wait for the next run, which now starts with all of them after
  its input (before: one per model request).
- The agent's unused follow-up queue is removed.

### Back off sweep loads after node crashes

Orphan sweeps now reserve a retry delay before loading an agent. If the load or its run kills the node without recording an error, the next node waits for that delay. Repeated attempts double the sweep interval, up to one hour. The delay clears after the agent stays loaded for two minutes or its run ends.

This backoff only gates sweep selection. It does not add a wait to a resumed turn's model call, change its resume limit, or count a load refused because another node owns the agent.

### Trace export is removed

The per-tenant OpenTelemetry trace export is gone: `PUT/GET/DELETE /v1/telemetry` and `POST /v1/telemetry/test`, the
`runtime.telemetry` SDK object and the `traceparent` options (TypeScript and Python), `camelrun telemetry` and `run --traceparent`, the console's
Telemetry page (Settings now opens the account), the run record's `trace`, and inbound `traceparent` handling (a header or
param older clients send is ignored). Nobody used it: no tenant exported a span in the 14 days before (no
`telemetry_spans` lines), and chiridion and camel-bots never configured it. `AGENT_TELEMETRY_INTERVAL_MS` and
`AGENT_TELEMETRY_RETRY_MS` are no longer read.

The `telemetry_exporters` table is dropped (migration 094; an account deletion still running old code during the
rollout fails once and is retried). Operators keep the CloudWatch metric lines (`turn_metrics`, `model_response` and
the rest); Pi's own spans (`@earendil-works/pi-telemetry`) can be attached to an operator pipeline if one is added.

### Recover from damaged images

Damaged or incomplete images are replaced with an omission notice before they
reach the model, including images already in an agent's history. The saved
history and files are unchanged.

If a provider still cannot read an image, the runtime retries once without
images and keeps them omitted for the rest of that turn. The next turn can use
images again.

### The by-hand agent quarantine is gone

`QUARANTINED_AGENTS` is removed: a full indexed history read past 64 MiB now answers 413 before reading (#428), and a
sweep load that takes its node down backs the agent off across nodes (#429), so one agent can no longer run node
after node out of heap.

### Usage tiers set every per-account limit, raised; an internal tier; per-account decision concurrency

A prepaid account's usage tier (by credit paid in total) now sets every per-account limit, not only busy agents:
runs and agent creates a minute, js_exec executions and decision calls at once per node. The defaults are much higher:

| Tier | Paid | Busy agents | Runs/min | Creates/min | js_exec/node | Decisions/node |
| --- | --- | --- | --- | --- | --- | --- |
| Free | $0 | 50 (was 20) | 300 (was 240) | 600 | 4 (was 2) | 16 |
| Tier 1 | $5 | 250 (was 50) | 1,500 (was 600) | 1,200 (was 600) | 8 (was 4) | 32 (was 16) |
| Tier 2 | $50 | 1,000 (was 100) | 6,000 | 3,000 | 16 | 48 |
| Tier 3 | $250 | 4,000 (was 250) | 20,000 | 6,000 | 16 | 64 |
| Tier 4 | $1,000 | 10,000 (was 1,000) | 60,000 | 12,000 | 16 | 64 |

Each limit is the first of: set for the account (its tenants-file field, or `PUT /v1/tenants/{id}/limits`), none on the
internal tier, its tier's, the deployment's default. Unbilled accounts keep the defaults they had; an admin tenant
with `billing: "prepaid"` now has its tier's rate and js_exec limits instead of none.

- **`GET /v1/limits`** (new): the account's tier and the next one, every limit with its `source` (`tier`, `tenant`,
  `internal`, `default`) and what the next tier raises it to, and the tier table. The 429 for runs and creates says
  what the next tier unlocks.
- **`tier: "internal"`** in the tenants file: the operator's own applications, with no per-account limit unless a field
  of the entry sets one. Node caps (agents hosted, js_exec workers, decision calls, in-flight characters, memory, body
  shedding) and spend limits still apply. `infra/tenant.sh set-tier <tenant> internal|default`.
- **`decisionConcurrency`** (issue #493): decision calls at once for an account on a node, set like `codeConcurrency`
  (tenants file, `PUT /v1/tenants/{id}/limits`, null clears; `infra/tenant.sh set-decision-concurrency`), at most
  the node's, now `AGENT_DECISION_NODE_CONCURRENCY` (default 64). The account's queue and in-flight characters scale up
  with it (48: 3,000 waiting, 24M characters), the characters at most the node's 32M.
- **Visibility:** a `decision_wait` metric line (tenant, calls of a request that waited past 250 ms, the longest wait,
  the queue depth) and a `decision_load` gauge per tenant with calls in flight, sampled with `node_load` (which adds
  `decisionsActive` and `decisionsWaiting`).
- `AGENT_USAGE_TIERS` takes the new fields, each optional (left out: the deployment's default). `GET /v1/billing`'s
  `busyAgents.limit` is null on the internal tier.

### Virtual models, and `camelrun/default` as the default

`camelrun/default` is a virtual model: a name an agent keeps, routed to a real model for each request. Today it is `openrouter/particle-ai/particle-1`, then `openrouter/deepseek/deepseek-v4.1-flash-1017`. A runtime that sets none of `AGENT_PROVIDER`, `AGENT_MODEL` and `AGENT_BASE_URL` now uses it as the default for agents that name no model; `AGENT_PROVIDER=camelrun` with `AGENT_MODEL=default` names it. A runtime that sets them otherwise keeps what it named.

- **Failover per request.** A request a model cannot take now (a 429, a 5xx, no provider, a timeout, a stream gone quiet) and that has streamed nothing moves to the next model at once. A bad request, an oversized context, or a key or credit problem does not. Each new message starts on the first model; the rest of a turn stays where it moved. An agent naming a real model has none of this.
- **Records.** A run's `servedModel`, `/v1/usage` and `usage.recorded` name the model that answered, at its price. `GET /v1/agents/:id` and `GET /v1/me` show the virtual name, and `GET /v1/models` lists it with `routes`. A move logs `model_fallback` with `Reason: unavailable` and its `errorClass`, and counts `ModelFallbacks`.
- **Credit.** Each attempt holds end-user credit at its own model's price. A failed attempt's hold goes as it ends, it costs nothing and counts as no response in `/v1/usage`, and the next is checked at its price.

### Live MP3 streams that start mid-frame play

`POST /v1/voice/sessions/{id}/audio` refused a live MP3 stream whose first bytes were the middle of a frame, as
`AUDIO_UNSUPPORTED`. Such a stream is now told by two MP3 frames in a row within its first 4 KB, and plays from the
first whole frame. HTML pages and other non-audio are still refused.

### ElevenLabs voice defaults to gemini-3.1-flash-lite

ElevenLabs calls now use `gemini-3.1-flash-lite` unless a session asks for another model, on a new agent,
`camelRun realtime voice v6`, made as each key's first such call connects. In group calls on this model, a rule that what
isn't for it comes first. `claude-haiku-5-5` stays allowed for rollback; other models and providers keep today's rules.

Set `AGENT_PRICE_ELEVENLABS_GEMINI_3_1_LLM_MINUTE_USD` before this deploys (`0.012` in Terraform): without it, ElevenLabs
calls are refused with `REALTIME_UNPRICED`. Their total goes from $0.083 to $0.092 a minute.

### ElevenLabs voice defaults to claude-haiku-5-5

`gemini-2.5-flash-lite` writes some tool calls out as text, which ElevenLabs speaks, and ElevenLabs is retiring it. A session
on ElevenLabs Agents that names no model now runs on `claude-haiku-5-5`, at `AGENT_PRICE_ELEVENLABS_HAIKU_LLM_MINUTE_USD`.

### ElevenLabs voice can run on claude-haiku-5-5

A session may ask for `realtime.model: "claude-haiku-5-5"` on ElevenLabs Agents. It runs on its own agent,
`camelRun realtime voice v5`, made as each key's first such call connects. The default stays `gemini-2.5-flash-lite`.

Set `AGENT_PRICE_ELEVENLABS_HAIKU_LLM_MINUTE_USD` before the first such session (`0.003` in Terraform): without it,
that model is refused with `REALTIME_UNPRICED`.

`voice_realtime_lost` now names the `reference`, the `failure` class and any `closeCode`, with no provider text.

### Exact voice ID checks

- `GET /v1/voices/{provider}/{id}` and TypeScript/Python `voices.get(provider, id)` check a saved exact voice ID and return voice metadata, `usable`, and a reason. ElevenLabs uses the same keys as search and reads account copies and exact shared-library metadata without importing a voice. Grok, OpenAI, and Gemini use the fixed voice lists.

### Voice: the transcribe-and-reply pipeline is removed (breaking for voice clients)

A voice session either answers with the realtime model (`brain: "realtime"`, the default) or only listens (`brain:
"listen"`: muted, each utterance transcribed and sent to webhooks, nothing answering). The pipeline released in 0.10.0 and 0.11.0,
which sent each utterance to `deliver.agent` or your app and spoke replies through text to speech, is gone. What
clients must change:

- A session that only listened (no `speak`) now asks for `brain: "listen"`; left out, a session answers aloud.
- `POST /v1/voice/sessions` no longer takes `speak.agentReplies`, `transcription`, `speech` or `bargeIn.backchannels`
  (400). A realtime session speaks, so your app joins un-muted (`join.self_mute: false`); a listening one joins muted.
  `speak: true` is still accepted, changes nothing, and is deprecated; leave it out. `voice` (OpenAI's names) maps to
  the realtime provider's nearest voice; `realtime.voice` names the provider's own.
- `deliver.agent` no longer gets each utterance as a prompt: the model asks it (`ask_agent`) when it needs it.
  `voice.utterance` still comes for what people say, now always with `brain` (`realtime` or `listen`; a listening
  session's have no `addressed`); it no longer has `echo` or `backchannel`.
- `POST /v1/voice/sessions/{id}/speak` is removed (404), and so is a prompt's `speak` (400: not a field). `DELETE
  /v1/voice/sessions/{id}/speak` still stops what the bot is saying. The SDKs drop `voice.speak()` and the `speak`
  prompt option.
- `voice.speech.*` events no longer carry `reply`; `by` is `requested`, `barge_in`, `end`, `superseded` or `budget`.
  Sessions no longer show `speak`, `agentReplies`, `transcription`, `speech`, or `addressing.contextTurns` and
  `contextMs`; `brain` is `realtime` or `listen`, and `bargeIn` and `voice` are shown for realtime sessions only.
- A session made before this change, still live when the runtime is upgraded, ends (`voice.session.ended` with
  `reason: "error"`; logged as `brain_removed`).
- `POST /v1/speech` has no runtime default chain any more: it speaks through the providers the request names
  (`speech.providers`, else those `speech.voices` names, in its order, then OpenAI), else OpenAI.
- Operators: `AGENT_VOICE_TTS`, `AGENT_VOICE_STT`, `AGENT_VOICE_LIVE_TRANSCRIPTION`, `AGENT_VOICE_LIVE_MODEL`,
  `AGENT_VOICE_LIVE_DELAY`, `AGENT_PRICE_LIVE_TRANSCRIPTION_USD`, `AGENT_SONIOX_URL` and `AGENT_ASSEMBLYAI_URL` are no
  longer read, and `AGENT_SPEECH_PRICES` takes `tts` only. Soniox and AssemblyAI keys are no longer offered (`PUT
  /v1/providers/soniox/key`). `AGENT_VOICE_REALTIME` defaults to `openai`. `AGENT_VOICE_TURN_MODELS` stays: the
  realtime brain ends turns with Smart Turn.

### Voice: record a call

`POST /v1/voice/sessions/{id}/recording` records a voice session's call as Ogg Opus: one mixed file (mono, 24 kHz, 16 kbps) or a
file per speaker (`tracks: "speakers"`, the bot's own speech among them, all lined up from the recording's start), until
`DELETE …/recording`, `maxMinutes` (default 60, at most 240), `maxBytes` (default 25 MiB, at most 100 MiB) or the
session's end. The answer has a `notice` for the voice channel's chat. Its files are kept `retentionHours` (default 24,
at most 720), at `GET /v1/voice/recordings/{id}/files/{name}`, and `voice.recording.ended` says when they are ready
(add it to an endpoint's events to get it). While it records, the owning node writes the audio to object storage in
chunks (`recordings/<tenant>/<id>/`), so a session handed to another node goes on recording into the same recording.
Audio is stored only while a call is recorded. The TypeScript client has `voice.record`, `stopRecording`, `recording`,
`recordingFile` and `deleteRecording`. Migration `096_voice_recordings.sql`. Logs: `voice_recording_created`,
`voice_recording_started`, `voice_recording_ended`, `voice_recording_failed`.

### Voice sessions say words and play audio

A voice session's bot can now speak from your app, not only in answer to people:

- `POST /v1/voice/sessions/{id}/say` says given words, word for word, in the call's voice (text to speech, billed as
  `POST /v1/speech`), and `POST …/prompt` has the realtime model speak up on its own. Both wait their turn behind
  what the bot is saying, or cut it off with `interrupt`. Their `voice.speech.*` events carry `source: "say"`.
- `POST …/audio` plays MP3, Ogg Opus or WAV files and streams, by https URL or as an upload, from a queue;
  `GET`/`PATCH …/audio` read and control it (pause, resume, skip, stop, volume). The bot's speech holds the music, and
  barge-in leaves it be. New webhook events: `voice.audio.started` and `voice.audio.ended`. Sessions count `tracks`
  and `playedSeconds`. Playing audio is not billed.

The TypeScript and Python clients have `say`, `prompt`, `play`, `audio` and `controlAudio` (`control_audio`).
Implementation: `src/voice/jukebox.ts`, `src/voice/audio-decode.ts` (minimp3, Apache-2.0, for MP3), and the brain's
`say`/`prompt` in `src/voice/realtime/brain.ts`. Migration `097_voice_audio.sql`.

### Voice calls survive a Discord voice server going down

- A Discord voice connection whose reconnects keep failing (a voice server that is down answers 521 or 522) now asks
  the app for new credentials (`voice.session.error`, `credentials_needed`) instead of ending the session with
  `error`: Discord's answer to the app's OP 4 can be another voice server. Without new credentials within the grace
  the session ends with `credentials`. See [voice calls](../guides/voice-calls.md).

### 50 live voice sessions per account, spread across nodes

- `AGENT_VOICE_SESSIONS_PER_TENANT` now defaults to 50 (was 10), measured against what a node holds; see
  [the pipeline](voice-pipeline.md#sessions-per-node). A tenant's `maxVoiceSessions` still comes first.
- `AGENT_VOICE_SESSIONS_PER_NODE` now defaults to 15 (was 200), and is no longer a hard stop: a node at its share leaves
  a session to its peers, and any node takes one no peer has taken within 30 seconds. **Self-hosters:** on a single node,
  a session past 15 connects about 30 seconds later, unless you set this for your machine.
- A node past `AGENT_MEMORY_HIGH_BYTES` takes no voice sessions until it falls.

### ElevenLabs voice counts tool calls written as text

A tool call an ElevenLabs model writes out as text is read aloud. Each one now logs `voice_realtime_warning` with
`errorCode: tool_text_written`, the session's `reference`, and in `detail` the form it matched, plus `muted` if the
adapter was muting that audio. It logs no text and changes nothing that's played. `voice_realtime_warning` lines now all
carry `reference`.

### ElevenLabs voice agents set thinking off

New agents, `camelRun realtime voice v4`, set `thinking_budget: 0`; they are made as each key's next call connects.

### Voice media workers: memory counted once, and a memory kill says what grew

A media worker's memory check (`AGENT_VOICE_WORKER_MAX_MB`, 256) added `arrayBuffers` to `external`, which already
includes it, so every Buffer counted twice. `arrayBuffers` also counts Buffers the worker transferred to another
thread for as long as that thread keeps them. Workers were ended for memory they did not hold: 58 times since
2026-10-20, all in long, busy calls. The check is now heap plus external. The worker's heartbeat carries its memory
split (heap, external, ArrayBuffers, the Opus heap and its codecs) and, for each session, counts of what it holds:
streams, SSRCs, packets held, playbacks. `voice_worker_crashed` logs that split (`memory`) when a worker is ended for
its memory.

### wait_agent no longer answers twice for one sub-agent message

A sub-agent's message cuts its parent's `wait_agent` short. A `wait_agent` the model called right after reading that
message could be cut short by it again, while the node was still saving that the message was read, and return "running"
with "sent you a message". It now waits for the sub-agent.

### Workflows: a script an agent runs to coordinate sub-agents

An agent with the `workflow` builtin gets `run_workflow`: it writes a JavaScript
script that calls `agent()`, `parallel()`, `pipeline()`, `phase()` and `log()`, and
gets back only the script's return value. Each `agent()` makes a real child agent,
with `delegate`'s limits, links, budget and events. The
script runs in the runtime's `v8-exec` sandbox (no Node globals, no filesystem, no
network), holding a sandbox slot for its run, and a turn resumed on another node
replays it against the children it already made rather than running agent work twice.

```ts
const lead = await agents.upsert("migration-lead", { workflow: { agents: ["worker"], maxAgents: 40 } });
```

```python
lead = await agents.upsert("migration-lead", workflow={"agents": ["worker"], "maxAgents": 40})
```

`workflow` takes `agents`, `instructions`, `maxAgents` (256 by default, up to 4,096),
`maxParallel` (16, up to 64) and `maxDepth`; it goes with the builtin, as `delegate`
does, on an agent, a definition and a stateless run. Progress reaches streams that
ask for sub-agents' events (`?subagents=1`): `workflow_start`,
`workflow_progress`, `workflow_end`, beside each child's `subagent_start` and
`subagent_end`. See `docs/guides/workflows.md` and `docs/reference/limits.md`.

### Workspaces and spend attribution

Workspaces group agents and definitions inside an account. Create, rename,
archive, and assign them on the console's Workspaces page; the workspace
switcher scopes Overview, Agents, Definitions and Usage. Usage shows model and
tool spend by workspace, including native X search. Moving an agent preserves its
earlier attribution, including later provider cost corrections. New agents
inherit their definition's group; sub-agents and forks inherit their parent's.
Existing usage stays Unassigned. The REST API and SDK creation options support
workspace assignment. Account export and deletion include workspace data.

### X search for agents

Agents and stateless runs can enable the `x_search` builtin to search X posts
with Grok, regardless of their main model. Enable it on a definition or directly
on an agent, and add an xAI provider key under Models & keys. The platform's key
is used when available and allowed for the account.

Queries support included or excluded handles and a UTC date range. Results
contain a summary, citations, a truncation indicator and usage counts. Calls are
bounded to two model turns, 1,800 output tokens and a two-minute deadline.

The provider's reported total cost, including model tokens and posts or profiles
fetched, is recorded under `xai/x_search`. Platform-key calls charge prepaid
credit at that cost. The existing web-tools ledger amount includes X searches;
there is no additional flat search fee.

Implementation: `src/x-search.ts`. Test endpoint override:
`AGENT_XAI_RESPONSES_URL` (default `https://api.x.ai/v1/responses`).

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
  background compaction follows such a run.
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
  `AGENT_OUTBOUND_ALLOW_ORIGINS`. (Removed since: see trace-export-removed.)
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
