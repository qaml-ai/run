# Errors

Three kinds of failure, and where each shows:

1. **The API refused a request**: an HTTP status and a JSON body
   `{"error": "<message>"}` ([below](#http-errors)). The SDKs throw `AgentError`
   with `status`.
2. **A run failed**: the request was accepted, and the run ended badly. Its
   outcome says why ([Run failures](#run-failures)); the SDKs' `run()` throws
   `RunError` with the run, unless `throwOnError: false`.
3. **A tool call did not complete** within a run that otherwise went on: the
   model was told, and the run's outcome lists it in `toolErrors`
   ([Tool errors](#tool-errors)). Nothing throws; check them where a tool's
   side effect matters.

## HTTP errors

Error bodies are `{"error": "<message, for people>", "code": "<for code>"}`
(`type: "error"` too on some routes). The message may change; the code does not,
so switch on `code` (the SDKs' `AgentError.code`). Codes may be added: treat an
unknown one by its status. A conflict about an input also carries the input as it
now is (`"input"`). Every 429 and 503 has `Retry-After`; the SDKs honour it and
retry.

| Status | `code` | Meaning |
| --- | --- | --- |
| 400 | `INVALID_REQUEST` | The request is malformed or invalid; the message says how |
| 400 | `INVALID_HISTORY` | An imported history (`initialMessages`) has a message it cannot take; the message names which, and what it lacks |
| 401 | `UNAUTHORIZED` | No valid token; the message says where to create one (https://run.camelai.com/console/tokens) |
| 402 | `SPEND_LIMIT` | A spend limit is reached: the agent's, or the account's monthly cap |
| 402 | `INSUFFICIENT_CREDIT` | The account's prepaid credit is spent: no runs start and no files are stored |
| 403 | `FORBIDDEN` | The token may not do this |
| 404 | `NOT_FOUND` | No such agent, request, input or other resource for this account, or no such path at all (the message points at `/llms.txt`) |
| 409 | `IDEMPOTENCY_CONFLICT` | The Idempotency-Key or request id was used for another request |
| 409 | `IDEMPOTENCY_IN_PROGRESS` | The first request with this Idempotency-Key is still running; retry |
| 409 | `APPLICATION_CONNECTED` | Another connection serves this agent's tools; connect with `?takeover=true` to replace it |
| 409 | `APPLICATION_NOT_CONNECTED` | The agent's tools need its application and none is connected; connect it, or send `allowDisconnected: true` |
| 409 | `REPLAY_GAP` | The Last-Event-ID is behind the buffer; read `/state` (or ask for a snapshot) and continue from its cursor |
| 409 | `CONFLICT` | Another conflict, named in the message |
| 410 | `GONE` | The agent was deleted or has expired |
| 413 | `TOO_LARGE` | The request body is too large |
| 413 | `HISTORY_TOO_LARGE` | An imported history is over 16 MB of JSON |
| 429 | `BUSY_AGENT_LIMIT` | The account has as many agents busy as its [usage tier](limits.md#usage-tiers) allows; `busyAgents` in the body has the limit and the next tier. Retry after `Retry-After`, or when one of its runs ends |
| 429 | `RATE_LIMITED` | Too many agents, requests or subscribers at once; retry after `Retry-After` |
| 503 | `UNAVAILABLE` | Retry after `Retry-After`: capacity, an agent moving, a node draining |
| 507 | `STORAGE_LIMIT` | The account's storage limit would be passed; the body has `limit` and `used`, in bytes |
| 500 | `INTERNAL` | A bug; retry, and report it with the request id |

In more detail:

| Status | Meaning | What to do |
| --- | --- | --- |
| 400 | The request is malformed: a field fails validation (the message names it and what it takes), an unknown option, a blank `text`, an invalid request id or agent key, an answer that does not fit its input, an answer that names no one for an input meant for particular people (`This input is for …: answer with from or actor naming who answers`) | Fix the request; retrying it unchanged fails again |
| 401 | No token, an unknown or wrong token, or an expired browser token (`This browser token has expired; mint a new one`); an agent's token used on another agent | Send `Authorization: Bearer <token>` with a valid key. A browser: mint a new browser token (the watcher's `getToken`) |
| 402 | Payment required: the tenant's prepaid credit is used up (runs and file writes are refused), or its monthly model spend cap is reached. Queued runs fail with the same message | Add credit in the console, or raise the cap |
| 403 | Authenticated but not allowed: a browser token outside its agent or its scopes, an agent token changing what only the tenant may (`keyScope`, `spendLimit`, `modelHeaders`), a person not allowed to answer an input, a write to a read-only mount, an expired signed link | Use a token that may do it (usually the tenant's API key, server-side) |
| 404 | No such agent, request, input, volume, file, definition, schedule, webhook or route; or the feature is not enabled on this runtime. Another tenant's agent is a 404 too | Check the id. A deleted agent is 404 on `/v1/agents/:id` |
| 405 | A signed link used with the other method | Use the method it was made for |
| 409 | A conflict: see [409s](#409s) | Depends on the case |
| 410 | The agent was deleted or expired (`Session expired or revoked`, on `/clients/:id/*`) | Stop using that id and token. With a key, `upsert` it again: the key makes a fresh agent |
| 412 | A versioned write lost (a volume file changed since the `version` you gave) | Read it again and retry with the new version |
| 413 | Too large: the request body, inline files over 4 MiB, a file over 256 MiB, an upload over a link's `maxBytes` | See [Limits](limits.md); upload large files first and attach them by path |
| 415 | An upload through a signed link with another content type | Send the type the link names |
| 422 | A channel's credentials were rejected by the provider (Slack, Telegram, Discord) | Fix the bot token |
| 429 | Too many: the tenant's agents awake at once, the agent's 32 open requests, event-stream subscribers, or free credit's hourly allowance | Retry after `Retry-After` (the SDKs do, up to 8 times) |
| 500 | A bug | Retry; report it with the request id |
| 503 | The runtime cannot serve it right now: a node is draining or starting, lost ownership of an agent, has no room for its work, or the database is failing over; also a feature this runtime is not configured for | Retry after `Retry-After` (the SDKs retry); nothing happened |
| 507 | A volume is full (100,000 files), or the account's storage limit would be passed (`STORAGE_LIMIT`, with `limit` and `used` in bytes) | Delete files, or use another volume; for the account's limit, delete files or volumes, or buy credit (free credit stores 1 GB) |

### 409s

| Message | Meaning | What to do |
| --- | --- | --- |
| `REPLAY_GAP: recover from session state` | The stream cannot replay from your `Last-Event-ID` | Reconnect with `?snapshot=1` (the SDKs do), and recover settled outcomes from `/state` |
| `APPLICATION_CONNECTED: another connection serves this agent's tools…` | Another process serves this agent's tools. The SDKs raise it as `code: "APPLICATION_CONNECTED"` | Close the other one; or connect with `takeover: true` to replace it; or connect without serving tools (`attach: false`) to run the agent from here |
| `APPLICATION_NOT_CONNECTED: …` | A run (prompt, continue, execute, steer, follow-up) of an agent with application tools while no process serves them (after about 3 s' grace). The SDKs raise it as `code: "APPLICATION_NOT_CONNECTED"` | Start or reconnect the process that serves the tools; serve them over HTTP instead; or pass `allowDisconnected: true` to run without them |
| `Not the agent's current connection; reconnect` | An MCP answer on a connection that was replaced | Reconnect (the SDKs do) |
| `Request ID reused with different arguments` | The same request id (`idempotencyKey`) sent with another prompt | Use a new id for a new message; the same id only to retry the same one |
| `This Idempotency-Key was sent with another request…` | The same `Idempotency-Key` header on a different method, path or body | A key is for one request |
| `A request with this Idempotency-Key is still running; retry` / `…just finished; retry` | A retry raced the first request | Retry shortly: it then gets the first one's answer |
| `An existing agent's subject, context, definition, mounts cannot change…` | An upsert of an existing key with a different value for a field set only at creation | Delete the agent (`DELETE /v1/agents/:id`) or use another key |
| `Idempotency key belongs to another tenant` | Two tenants' keys cannot collide in practice; this guards it | Use another key |
| `This input is already answered` (or declined, cancelled, expired, superseded) | Someone answered first. The body's `input` says how. Answering again with the same answer is 200 | Show the input as it is |
| `The definition is at revision N, not M` / `The definition changed meanwhile; retry` | A definition update with a stale `revision` | Read it again and retry |
| `A volume keeps at most 100 snapshots…`, `A tenant has at most 16 webhook endpoints`, `Channel … uses this definition…`, `Volume … already exists` | A count limit or a dependency | Remove one first |

## Run failures

A run ends in one of three ways: it answered, it waits on people
(`stopped: "input_required"`), or it failed. It failed when:

| Code (SDK `RunError.code`) | Outcome | Meaning |
| --- | --- | --- |
| `model_error` | `result.error` is set | The model provider refused or failed (after 3 retries for transient failures): a bad request, an invalid key, content refused, context overflow that compaction could not fix |
| `output_missing` | `result.code` (with `result.error`) | A run sent with `output` ended without the model calling `final_output`: it answered in prose twice, the second time after a reminder. `text` has what it said. Send the prompt again, make the instructions say what the answer is for, or use a stronger model |
| `output_invalid` | (the SDKs only) | The output fit the JSON Schema the runtime checked, but not the zod or pydantic schema the SDK parsed it with (a refinement or validator the JSON Schema cannot say) |
| `spend_limit` | `result.stopped: "spend_limit"` | The agent's spend limit (or the tenant's monthly cap) stopped the turn after the response that crossed it; its tool calls ran. Raise the limit and send the next message |
| `runtime_error` | `outcome.error` (no `result`) | The runtime could not carry the run out: e.g. the agent's model has no key, the agent was deleted, code execution failed, a queued run refused for credit |
| (any, with `uncertain`) | `outcome.uncertain: true` | A restart cut the run short where it could not resume (a code execution, or a turn resumed twice already): its tool calls may or may not have taken effect. Check before retrying |

A request record (`GET …/requests/:requestId`, `GET …/state`) puts an ended run's
`error`, whichever kind, and `stopped` on top: `error` set means it failed.

A failed model response that is retried is retracted from history (`message_retracted`); the last one stays, with its `errorMessage`. A run
whose node was lost mid-turn resumes on another (`turn_resumed`), with any tool
call whose answer was lost marked "outcome unknown" for the model; tool calls
are never sent twice.

## Tool errors

A run's outcome lists each tool call that did not complete as
`toolErrors: [{tool, toolCallId?, innerCallId?, code, outcomeUnknown?, message}]`
(the SDKs: `run.toolErrors`). The model got the same message as the call's
result and carried on.

| `code` | Meaning | `outcomeUnknown` |
| --- | --- | --- |
| `timeout` | No answer (or progress) within the tool's deadline | yes: it may have taken effect |
| `connection_lost` | The connection the call went out on closed before its answer: the process serving the tools crashed, or was stopped without `close()`, or its call outlived `close()`'s drain. See [deploying a tool process](../guides/tools.md#deploying-a-tool-process) | yes |
| `not_connected` | No process served the agent's tools (no application attached), so the call did not run. Typical for REST, schedules and channels driving an agent whose tools live in a process that is not running: serve them over HTTP instead ([Tools](../guides/tools.md)) | no |
| `source_unavailable` | Its MCP server could not be reached, listed or authenticated with | no |
| `failed` | Anything else that kept it from running or answering | no |

A tool that ran and reported its own failure (threw, or answered `isError`) is
not a tool error: that is the tool's answer, which the model reads.

`sourceErrors: [{kind, source, message}]` lists tool sources (MCP servers,
OpenAPI specs) that could not be listed when the run began, so the model went
without their tools.

Every attempt at one tool call carries the same idempotency key
(`_meta["agent-runtime/idempotencyKey"]`, an OpenAPI operation's
`Idempotency-Key` header, the SDKs' `context.idempotencyKey`): key side effects
by it, and a call that runs twice acts once.

## SDK errors

| | TypeScript | Python |
| --- | --- | --- |
| Any failure | `AgentError`: `message`, `status` (HTTP status, or 0 for a run's or the connection's), `code?`, `requestId?`, `uncertain?`, `retryAfterMs?` | `AgentError`: `status`, `code`, `request_id`, `uncertain`, `retry_after` (seconds) |
| A failed run | `RunError extends AgentError`: `run` (the `Run`, `status: "failed"`, `error: {code, message, uncertain?}`) | `RunError`: `run` |
| Another process took the agent's tools | `code: "APPLICATION_REPLACED"`, through `onError`; the client goes on without serving them | the same, through `on_error` |
| A tool server's token check | `RuntimeTokenError` (`serveTools`, `verifyRuntimeToken`): the call gets 401 | `RuntimeTokenError` |

Stopping a wait (`signal`, `timeoutMs`; Python `timeout`) throws the signal's
reason (an `AbortError` or `TimeoutError`), or an `AgentError` saying the request may still be running:
the run goes on in the runtime. Wait for it again with the same
`idempotencyKey`, or `waitForRequest(id)`.
