# Limits

Every limit a developer can hit, from the runtime's code. Sizes: KiB = 1024
bytes, MiB = 1024 KiB. Past a size limit the request is refused (400 or 413);
past a count or rate limit, 409 or 429 (with `Retry-After`). See
[Errors](errors.md) for what to do about each.

## Agents

| Limit | Value |
| --- | --- |
| An agent's key (`Idempotency-Key` on `POST /v1/agents`, the SDKs' `upsert(key)`) | 1–80 characters of `A-Z a-z 0-9 _ -` |
| Lifetime (`ttlSeconds`) | 60 s to 31,622,400 s (366 days), or `null`: until deleted. Default: until deleted for an agent made with a key; 1 day for one made without |
| Create body (`POST /v1/agents`, with `initialMessages`) | 18 MiB |
| Imported history (`initialMessages`) | 16 MB of JSON (`HISTORY_TOO_LARGE`, 413) |
| `systemPrompt`, `systemPromptAppend` | 32,000 characters each |
| `modelHeaders` | at most 20 headers, 8 KB in all; never auth headers |
| `spendLimit.usd` | 0 to 1,000,000 |
| `subject` | a string; `context`: at most 4 KB |
| Mounts | at most 16 per agent |
| Agents busy at once per account | by [usage tier](#usage-tiers), across the whole runtime (not per node). An agent is busy while it has a run open, running or queued; a busy agent queues more runs without another slot. A run past the limit gets 429 `BUSY_AGENT_LIMIT` (below) |
| Tools in an agent's catalog | 4,096 tools, 16 MiB of schemas; at most 64 declared directly to the model (the rest are reached from js_exec) |

### Usage tiers

An account's tier comes from what it has paid for credit in total, net of refunds.
Starting credit and other grants do not count. A payment moves the account up as soon as it lands.

| Tier | Paid in total | Agents busy at once |
| --- | --- | --- |
| Free | nothing yet | 8 |
| Tier 1 | $5 | 25 |
| Tier 2 | $50 | 100 |
| Tier 3 | $250 | 250 |
| Tier 4 | $1,000 | 1,000 |

`GET /v1/billing` has `busyAgents`: the limit, how many are busy now, the tier, and the next one
(`next: {tier, paid, limit}`); the console's Billing page shows the same. An account whose limit
the operator set has `source: "tenant"` and no tier. Self-hosted runtimes set the tiers with
`AGENT_USAGE_TIERS` ([configuration](../operations/configuration.md)).

At the limit, a run (a prompt, `continue` or `execute`) gets 429 with `Retry-After`:

```json
{
  "error": "This account has 8 agents busy, the most its usage tier (Free) allows; retry when one finishes. Tier 1 (25 busy agents) applies once the account has paid $5 in total for credit.",
  "code": "BUSY_AGENT_LIMIT",
  "busyAgents": { "busy": 8, "limit": 8, "source": "tier", "tier": "Free", "paid": 0, "next": { "tier": "Tier 1", "paid": 5000000, "limit": 25 } }
}
```

Amounts are micro-USD. The SDKs retry it after `Retry-After`, like any 429. Creating agents,
reading them and sending them input do not count; only runs do.

## Runs and requests

| Limit | Value |
| --- | --- |
| Request id (a prompt's `requestId`, the SDKs' `idempotencyKey`) | 1–80 characters of `A-Z a-z 0-9 _ -` |
| Settled requests kept per agent for idempotent retries | the most recent 256 |
| Open requests per agent (running and queued) | 32; more is 429 `Too many requests queued for this agent` |
| Prompt body (`POST /v1/agents/:id/prompt`) | 6 MiB, with inline files |
| Request body over an agent's own token (`/clients/:id/requests`, `/mcp`) | 1.1 MB (1,100,000 bytes) |
| `text` | must not be blank |
| `from` | `id` 1–200 characters; `name`, `username` at most 200 each |
| `metadata` | at most 16 keys of 1–64 characters, string values of at most 512 characters |
| `configure` body | 1 MiB |
| Provider retries within a turn | 3 attempts, backing off from 2 s (overload, rate limits, 5xx, dropped streams); context overflow is not retried |
| Wait | none: a run may take as long as it takes, or wait on people for days. The SDKs have no default timeout |
| `Idempotency-Key` header (any other POST) | 1–255 characters; its answer is kept for 24 hours |

## Files

| Limit | Value |
| --- | --- |
| Files attached to one message | 20 |
| Inline (base64) file bytes in one message | 4 MiB in all, decoded; upload larger ones first (`PUT …/uploads/:requestId/:name`) and attach them by path |
| One file (upload, volume write) | 256 MiB |
| An upload's whole request | 15 minutes (other requests: 30 s without progress in the SDKs) |
| Image the model sees natively | 5 MiB and 8,000 pixels a side (larger ones are described in text) |
| PDF the model sees natively | 16 MiB and 100 pages |
| Files in one model request | 24 MiB and 100 images; older files past that are described in text |
| Parsing an untrusted file for its text | 32 MiB in, 10 s, 1,000,000 characters out |
| Files a run lists in its outcome | 100 written (`files`), 20 presented (`presented`) |
| Signed links (`POST …/links`) | `expiresIn` 1 to 86,400 s, default 900 |
| A volume | 100,000 files, 100 snapshots; the change feed keeps the last 1,000 changes; a listing page is at most 1,000 files |
| Channel attachments | 10 files a message, 25 MiB each, 100 MiB in all |
| Storage per tenant | 1 GB (10^9 bytes) on free credit, 100 GB once it has bought credit; an operator can set another per tenant. Counted as the storage charge counts it: file contents (each distinct content once), agents' history logs and volumes' file trees. A write that would pass it is refused with 507 `STORAGE_LIMIT`, its body carrying `limit` and `used` in bytes: delete files or volumes to make room. Uploads, file writes and tool outputs all count |
| Storing on spent credit | a prepaid tenant at a zero balance cannot store more: uploads, file writes and tool outputs get 402 `INSUFFICIENT_CREDIT`. Reading and deleting still work |

## Tools

| Limit | Value |
| --- | --- |
| A tool result the model reads | 32,000 characters; a longer one is saved whole (up to 700 KB) to `/workspace/tool-results/<toolCallId>.txt` |
| Attached tool call deadline (tools in your process) | 15 s without an answer by default; a tool's own `timeoutMs` from 1 s to 20 minutes |
| Remote MCP server call deadline | the source's `timeoutMs` (1 s to 20 minutes), default 60 s |
| OpenAPI operation deadline | the source's `timeoutMs` (1 s to 20 minutes), default 30 s |
| Progress | each progress notification restarts a call's deadline, up to 20 minutes in all. Progress events are published at most every 250 ms per call |
| One MCP result from the SDKs (a tool's return value) | 1 MiB of JSON |
| A remote MCP server's response | 8 MiB |
| An OpenAPI spec | 8 MiB; at most 1,024 operations allowed (`allowTools`) |
| Tool sources per definition | 64 MCP servers, 64 OpenAPI specs; `allowTools`/`denyTools` at most 512 names (MCP) |
| A file in a tool's arguments (base64) | 4 MiB |
| A binary tool response saved to the workspace | 64 MiB; 64 MiB per call and 256 MiB per run saved in all |
| An MCP text resource shown inline | 64 KiB (longer ones are saved as files) |

### js_exec (code the model writes) and `execute`

| Limit | Value |
| --- | --- |
| Wall time | 30 s by default, at most 120 s (`timeoutMs`) |
| Guest CPU time | 2 s of executing code (time waiting on tools does not count) |
| Memory | 32 MiB WebAssembly memory, 16 MiB QuickJS heap, 256 KiB stack |
| Output | 32,000 characters by default, at most 128,000 (`maxOutputCharacters`); 1,024 chunks |
| Tool calls | 256 per script, at most 32 in flight |
| Tool traffic | arguments at most 128 KiB of JSON a call, results at most 1 MiB, 8 MiB in all |
| One `fs.readFile` / `fs.writeFile` | 700 KiB |

## People

| Limit | Value |
| --- | --- |
| How long an input waits | 7 days by default; a definition's `humanInput.expiresInSeconds` from 60 s to 30 days, never past the agent's expiry |
| Inputs one tool call may ask at once | 8 |
| An input's message, an approval's shown arguments | 4,000 characters |
| Answers in one batch (`POST …/inputs`) | 1–100; one answer's body 256 KiB |
| Approvers (`humanInput.approvers`) | 100 |
| `ask_user` | 1–4 questions, each with 2–4 options and a header of at most 12 characters |

## Streams and browsers

| Limit | Value |
| --- | --- |
| One SSE frame | 1.1 MB; a larger event is sent as `event_omitted` |
| Events buffered per agent for replay | the last 512, at most 2 MiB; a cursor behind them gets a snapshot (or `REPLAY_GAP`) |
| A snapshot's messages | about 1 MB; more is `truncated: true` (read history) |
| Long poll `wait` | at most 25 s |
| Read-only subscribers (watchers and waiting polls) | 32 per agent, 1,024 per tenant on a node (or the tenant's `maxWatchers`), 4,096 per node; past it, 429 |
| Browser token lifetime | 5 to 3,600 s, default 900; its stream ends when it expires |
| Browser token `events` list | 64 types |
| History page (`?limit=`) | 1 to 500 messages, default 50 |

## Schedules, channels and webhooks

| Limit | Value |
| --- | --- |
| Schedules per agent | 100 |
| Repeating schedules | `everySeconds` at least 60 |
| Schedule body | 64 KiB |
| Channel senders | `perSenderPerMinute` 1–600 (default 10), `turnsPerDay` 1–1,000,000 (default 1,000); `allow` at most 1,000 senders |
| Channel daily turns | count messages and, since they also post, turns started through the API or a schedule; past the limit those do not post |
| Camel Discord servers per account | 10, or 1 on free credit (an operator can change either) |
| A Camel Discord server | `perSenderPerMinute` 1–100 (default 5), `turnsPerDay` 1–10,000 (default 100; at most 500 on free credit); no `schedule` builtin |
| Webhook endpoints per tenant | 16 |
| A webhook delivery | 10 s to answer; retried until delivered, for up to 3 days |
| A rotated webhook secret | keeps signing beside the new one for 24 hours |

## Spending

| Limit | Value |
| --- | --- |
| An agent's spend limit | from when it is set: new prompts are refused, and a running turn stops after the response that crossed it (`stopped: "spend_limit"`) |
| A tenant's monthly cap (`maxMonthlyCost`) | 402 for new runs once reached |
| Prepaid credit | 402 at a zero balance, for runs and for storing files; free credit allows $1 of usage per hour (429 past it) |
