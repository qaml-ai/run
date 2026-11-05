# Remaining failures by group

The last complete contract run at `d3b9d03b` on `rt-pool-3` was **223 pass / 367 fail**, with 380 out of scope. Node passed all 590 in-scope cases. No new full run was started for wrap-up.

This handoff uses the latest **completed observation for each case**, including focused runs at different revisions. It is not a new aggregate contract score and does not claim the delivery commit passed these contracts. Later code changes without a repeat of the case are still shown as failures. The original full result remains the baseline.

Focused completed results: streaming/messages 12/12 (`cbcbd28d`); human input 20/20 (`626eca88`); decisions 5/5 and delegation 25/39 (`28528f8f`); runs/history 49/53 (`4241d8af`); tools/MCP/sources 28/42 (`d161edd4`); models/providers/definitions 35/68 (`7f79aee3`). A later configuration/provider selection passed 21/26 (`c1a32b21`), including all five custom-provider cases.

The configuration queue, public list/activity/idempotency additions, and unverified reasoning-retry/web-fetch edits are preserved on local `wip/agents-unfinished`, not pushed. The final quick checks validate the retained tree; they do not replace these failing contracts.

Each case below gives its exact name, original test location, observation revision and one-line diagnosis. Group source links identify the existing implementation that defines expected behavior. For groups outside the agents track, the unchanged full-run baseline is the handoff evidence.

## Delegation (14 observed failures)

Expected behavior: `src/client-sessions/delegation.ts`, `src/agent-child.ts`, `src/multi-agent.ts`.

- **a parent messages its finished child, which works again with its history and notifies again; a child messages its parent** (`tests/agent-messaging.test.ts:21`, `28528f8f`): Expected string field/event is missing.
- **two agents messaging each other in a loop stop at the wake cap with agent_loop_limit, and a turn sends at most 20 messages** (`tests/agent-messaging.test.ts:61`, `28528f8f`): Timed out waiting for a turn stopped at the cap
- **a child's message joins its busy parent's running turn at its next step, without a turn of its own** (`tests/agent-progress.test.ts:109`, `28528f8f`): Timed out waiting for subagent_message
- **a child's message cuts its parent's wait_agent short, and the parent reads it next** (`tests/agent-progress.test.ts:141`, `28528f8f`): Child ordering, result or spend response differs from the source contract.
- **a response that starts a sub-agent and, beside it, messages and waits for it: those calls run once it has started** (`tests/agent-progress.test.ts:168`, `28528f8f`): Timed out waiting for the message accepted into its turn
- **two agents waking each other through notifications stop at the wake cap with agent_loop_limit, the notification still in history** (`tests/background-agents.test.ts:131`, `28528f8f`): Timed out waiting for the notification's turn to end
- **a child's spend is charged to its parent when its notification lands, and a parent at its spend limit gets no turn** (`tests/background-agents.test.ts:154`, `28528f8f`): Expected response field is missing (reading toFixed).
- **aborting a parent while a child's notification waits keeps the notification: it lands without a turn** (`tests/background-agents.test.ts:183`, `28528f8f`): Timed out waiting for the notification to queue behind the turn
- **children started together share what the parent may spend, and limits alone bound a tool's spawns without a tool for the model** (`tests/background-agents.test.ts:213`, `28528f8f`): Expected response field is missing (reading map).
- **aborting a parent aborts the children it waits on; the stream shows them to subscribers that ask** (`tests/multi-agent.test.ts:179`, `28528f8f`): HTTP 400 returned; expected 200.
- **aborting a parent answers once its delegate child has ended, charges what the child spent, and deleting the parent deletes the child** (`tests/multi-agent.test.ts:203`, `28528f8f`): HTTP 400 returned; expected 200.
- **a delegate child whose ending no call took, its parent's run over, is landed by the sweep and charged to the parent** (`tests/multi-agent.test.ts:232`, `28528f8f`): Timed out waiting for the parent's spend written
- **delegation stops at its depth limit, and a run's spend limit bounds its children and counts what they spent** (`tests/multi-agent.test.ts:86`, `28528f8f`): Expected spend_limit outcome/metadata is missing.
- **a trusted tool prepares a persistent worker and starts it as a background sub-agent; a busy worker queues the next task** (`tests/tool-spawn.test.ts:15`, `28528f8f`): the second task waited its turn

## Tools / MCP / code mode (14 observed failures)

Expected behavior: `src/builtins.ts`, `src/tool-sources.ts`, `src/mcp.ts`, `src/hosted-mcp.ts`, `src/client-sessions/events.ts`, `sandbox/v8-exec/src/pi-glue.js`.

- **a run for an agent whose tools need its application is refused while none is connected, after a short wait for one reconnecting** (`tests/attach.test.ts:43`, `d161edd4`): 202 rather than 409 in disconnected path
- **one application serves an agent's tools at a time: another connection is refused unless it takes over, and the replaced one is told why** (`tests/attach.test.ts:6`, `d161edd4`): 409 code correct, error message hides takeover=true
- **an agent takes builtins without a definition: at creation, by upsert and by configuration, and only from its tenant** (`tests/builtins.test.ts:117`, `d161edd4`): repeated upsert lacks reconfigured.id
- **web_fetch reads public pages as text, from the model and codemode, and never reaches inside** (`tests/builtins.test.ts:18`, `d161edd4`): codemode .text.length receives undefined; structured tool output absent
- **web_fetch refuses internal addresses when nothing is allowed** (`tests/builtins.test.ts:46`, `d161edd4`): Host does not resolve rather than localhost resolves to ...
- **an agent schedules, lists and cancels its own wake-ups, and wakes up** (`tests/builtins.test.ts:55`, `d161edd4`): &lt;harness&gt; text is not the JSON expected by tool result
- **a schedule of an agent at its spend limit records the 402 and moves to its next occurrence instead of retrying** (`tests/builtins.test.ts:85`, `d161edd4`): lastError is billing Error 402 spend_limit (193 chars) rather than HTTP 402: ...
- **codemode runs on V8 for every tenant, and the limits API refuses an engine** (`tests/code-engine.test.ts:21`, `d161edd4`): engine probe prints other; Pi sandbox is QuickJS, no Intl
- **MCP clients sign in with OAuth: registration, consent, PKCE, rotating refresh tokens, revocation** (`tests/hosted-mcp.test.ts`, `d161edd4`): OAuth create-agent response exposes scoped agent token; source omits it
- **an alias serves everything, names MCP resources as reached, keeps the issuer, and sends browser pages to the public URL** (`tests/hosted-mcp.test.ts`, `d161edd4`): alias metadata assertion reports agents.example.test
- **the hosted MCP endpoint runs the CLI's tools as the caller, and reads no files or environment** (`tests/hosted-mcp.test.ts`, `d161edd4`): 90-second timeout; exact blocking step unconfirmed, suspected early incomplete 9MiB Content-Length request
- **an agent without a definition has MCP servers of its own, called with identity tokens that name it and no definition** (`tests/inline-mcp-servers.test.ts:42`, `d161edd4`): configure mcpServers:null returns 400 instead of clearing
- **an agent shows every tool source and what its model gets, connecting to MCP servers only when asked** (`tests/mcp.test.ts:156`, `d161edd4`): model exposes extra generic computer absent from source catalog
- **history and forks keep capped tool details and deduplicated prompts without changing model content** (`tests/tool-calls.test.ts:187`, `d161edd4`): fork returns 400 Request body too large

## Configuration / definitions (5 observed failures)

Expected behavior: `src/definitions.ts`, `src/client-sessions/configuration.ts`, `src/api-schemas.ts`.

- **an agent's own model, thinking level and prompt addition survive applying its definition** (`tests/definitions.test.ts:177`, `7f79aee3`): Timed out waiting for the addition
- **fileTools: false leaves the model present_file, and the file tools to code** (`tests/definitions.test.ts:217`, `7f79aee3`): Response, event or error shape differs from the asserted source contract.
- **the SDK makes an agent from a definition with its attached server's tools, which survive an apply** (`tests/definitions.test.ts:244`, `7f79aee3`): Expected response field is missing (reading map).
- **public configuration waits between turns, preserves history, and reports validation and outcome** (`tests/definitions.test.ts:328`, `7f79aee3`): HTTP 202 returned; expected 400.
- **agents are made from a definition, record its revision, and take a new one when it is applied** (`tests/definitions.test.ts:85`, `7f79aee3`): application tools come only from an attached server undefined !== []

## Models / routing (26 observed failures)

Expected behavior: `src/model.ts`, `src/model-providers.ts`, `src/model-fallback.ts`, `src/openrouter-model.ts`, `src/virtual-models.ts`.

- **an agent's language: in its prompt once and the same every turn, shown, changed and cleared by PATCH, refused when junk** (`tests/agent-language.test.ts:29`, `7f79aee3`): Expected response field is missing (reading id).
- **existing agents recover from static fallback on their next call; tenant and scope keys never exchange** (`tests/anthropic-federation.test.ts:170`, `c1a32b21`): After static fallback, the next request did not use the expected refreshed bearer credential.
- **models are chosen by name over REST, at creation and mid-conversation** (`tests/api.test.ts:188`, `7f79aee3`): Expected string field/event is missing.
- **an azure model without a deployment, a refused key, a missing deployment and a rate limit each end the run with Azure's reason** (`tests/azure-models.test.ts:146`, `7f79aee3`): HTTP 404 returned; expected 201.
- **Azure Flash uses platform credentials and catalog billing and replays reasoning with tool results** (`tests/azure-models.test.ts:241`, `7f79aee3`): HTTP 404 returned; expected 201.
- **a tenant on the platform's keys runs azure models the platform deploys, through the deployment, billed at the catalog's price** (`tests/azure-models.test.ts:89`, `7f79aee3`): HTTP 404 returned; expected 201.
- **billing: the blocked Azure call is the platform's cost, recorded but never charged; the account pays once, for the fallback's answer** (`tests/content-filter-fallback.test.ts:126`, `7f79aee3`): HTTP 404 returned; expected 201.
- **if DeepSeek's endpoint refuses anyway, the same request is asked again: no host kept off, no order** (`tests/deepseek-replay.test.ts:103`, `7f79aee3`): Provider request, usage or model response differs from the source contract.
- **DeepSeek's refusal as OpenRouter's Chat Completions gives it (127 characters) is classed and retried as it was; the answer names its host** (`tests/deepseek-replay.test.ts:138`, `7f79aee3`): Provider request, usage or model response differs from the source contract.
- **the default is for agents being made: an upsert or a definition applied that names no model leaves an existing agent's** (`tests/default-model.test.ts:83`, `7f79aee3`): Expected response field is missing (reading id).
- **a Codex model on a tenant's endpoint gets the ChatGPT backend's own request, with a placeholder account for the endpoint to replace** (`tests/model-endpoints.test.ts:140`, `7f79aee3`): HTTP 404 returned; expected 200.
- **a tenant endpoint's errors end the turn with its message, without retries** (`tests/model-endpoints.test.ts:192`, `7f79aee3`): Expected string field/event is missing.
- **OpenRouter models on a tenant's endpoint use its Responses API, reasoning carried back, and compact through it** (`tests/model-endpoints.test.ts:61`, `7f79aee3`): Public response or accounting assertion differs; inspect the named contract.
- **a Bedrock model on a tenant's endpoint gets Converse's own request at its region's path, unsigned, with its signatures sent back** (`tests/model-endpoints.test.ts:89`, `7f79aee3`): Public response or accounting assertion differs; inspect the named contract.
- **a tenant cannot give its agent a model object: a free copy of a catalog model on the platform's key is refused** (`tests/model-pricing-trust.test.ts:27`, `7f79aee3`): Validation error wording differs for an unknown agent field.
- **on a platform key a response is billed at the catalog's price, whatever the agent's stored model says, and one without usage is charged an estimate** (`tests/model-pricing-trust.test.ts:51`, `7f79aee3`): Unsupported fixture state: Workers agents have no legacy stored Node model configuration to restore at restart
- **an agent's maxOutputTokens and temperature go on its model calls, are refused where its model takes none, and stay its own** (`tests/model-settings.test.ts:39`, `7f79aee3`): Expected response field is missing (reading id).
- **over the API: the lookup's price reaches an end user's hold, so a dear model is refused where the mid-range price would have started** (`tests/openrouter-model.test.ts:109`, `7f79aee3`): no call was made 1 !== 0
- **a structured run forces final_output from the first request when it is the model's only tool, and on the reminder when it has others** (`tests/structured-output.test.ts:138`, `7f79aee3`): Provider request, usage or model response differs from the source contract.
- **a provider that refuses a forced tool_choice is asked again without it; forcing stops after three requests** (`tests/structured-output.test.ts:166`, `7f79aee3`): Structured-output failure classification differs.
- **codeMode: false leaves out codemode and the runtime's code rules; with no tools at all, the prompt is the instructions and the sender note** (`tests/structured-output.test.ts:185`, `7f79aee3`): Public response or accounting assertion differs; inspect the named contract.
- **a prompt with output ends on a final_output call that fits its schema, which the outcome returns** (`tests/structured-output.test.ts:24`, `7f79aee3`): final_output remains available from stored history + actual - expected + undefined - { - output: { - score: 0.9, - sentiment: 'positive' - } - }
- **a structured run the model ends in text is reminded once, then fails with output_missing; a prompt without output takes the tool away** (`tests/structured-output.test.ts:45`, `7f79aee3`): Expected string field/event is missing.
- **output is refused unless it is a schema for an object, on a prompt that starts its own turn** (`tests/structured-output.test.ts:79`, `7f79aee3`): HTTP 202 returned; expected 400.
- **a tenant with no OpenRouter key falls to what it holds; an upsert keeps the alias, and naming a model leaves it** (`tests/virtual-models.test.ts:185`, `7f79aee3`): Expected response field is missing (reading id).
- **over the API: Particle's failed attempt releases its end user's hold and costs nothing; only the model that answered is charged** (`tests/virtual-models.test.ts:207`, `7f79aee3`): the end user pays once 0 !== -10000

## Files / attachments / images (17 observed failures)

Expected behavior: `src/files.ts`, `src/file-arguments.ts`, `src/tool-files.ts`, `src/workspaces.ts`.

- **fileArguments: other parties' servers are not offered or sent files unless a definition turns it on** (`tests/file-arguments.test.ts`, `d3b9d03b`): HTTP 201 returned; expected 400.
- **files reach a tool as URLs bound to the call: a file at its version, a directory as a snapshot, small ones inline** (`tests/file-arguments.test.ts`, `d3b9d03b`): Expected response field is missing (reading 1).
- **attachments over REST land in the workspace, the transcript keeps references, and the model sees them natively** (`tests/files.test.ts`, `d3b9d03b`): File response/metadata differs from the source contract.
- **signed links: bound to tenant, volume, path, method, expiry, size and content type; tampering fails** (`tests/files.test.ts:98`, `d3b9d03b`): File response/metadata differs from the source contract.
- **POST /v1/images makes images on the platform's OpenAI key for a prepaid tenant, edits images given as base64, multipart or a URL, and is billed per token** (`tests/image-generation-api.test.ts`, `d3b9d03b`): HTTP 404 returned; expected 201.
- **POST /v1/images needs an OpenAI key, and a monthly cap refuses it** (`tests/image-generation-api.test.ts`, `d3b9d03b`): HTTP 401 returned; expected 400.
- **POST /v1/images with volumeId saves the images to the volume and answers their paths** (`tests/image-generation-api.test.ts`, `d3b9d03b`): HTTP 404 returned; expected 201.
- **the TypeScript SDK: images.generate and images.edit from bytes, a Blob or a URL, answered as base64 or saved to a volume** (`tests/image-generation-sdk.test.ts:7`, `d3b9d03b`): HTTP 404 returned; expected 201.
- **a thread with over 20 images, one of them 2,400 px, gets a request where every image is at most 1,568 px; the stored history is unchanged** (`tests/images.test.ts`, `d3b9d03b`): every image but the broken one is shown 23 !== 22
- **an image whose scaling failed for now (its parse job crashed) is tried again on the next request, not held as omitted** (`tests/images.test.ts:187`, `d3b9d03b`): Unsupported fixture state: Workers has no parse-job resize boundary to fail and retry
- **MCP images, audio, blobs and long text are saved to the workspace, under sanitized names** (`tests/tool-files.test.ts`, `d3b9d03b`): Expected response field is missing (reading some).
- **MCP tools take files by {$file}: base64 or a call-bound URL, only from the agent's mounts** (`tests/tool-files.test.ts`, `d3b9d03b`): Expected response field is missing (reading 1).
- **OpenAPI operations upload files (multipart, raw bytes, base64) and save binary responses** (`tests/tool-files.test.ts`, `d3b9d03b`): Expected response field is missing (reading 1).
- **application-attached MCP files are saved to the workspace like a server's** (`tests/tool-files.test.ts`, `d3b9d03b`): Expected response field is missing (reading some).
- **web_fetch saves PDFs and images to the workspace and shows them to the model** (`tests/tool-files.test.ts`, `d3b9d03b`): Public response or accounting assertion differs; inspect the named contract.
- **the REST API and SDK manage volumes within a tenant, and nothing crosses tenants** (`tests/volumes.test.ts:538`, `d3b9d03b`): The validation function is expected to return "true". Received false Caught error: AgentError: File version changed
- **workspaces API validates ownership, inherits definitions, and accounts agent and stateless model calls** (`tests/workspaces.test.ts:48`, `d3b9d03b`): Response, event or error shape differs from the asserted source contract.

## Accounts / auth / money (68 observed failures)

Expected behavior: `src/accounts.ts`, `src/tenants.ts`, `src/key-scopes.ts`, `src/credit-holds.ts`, `src/billing.ts`, `src/busy-agents.ts`, `src/oauth.ts`.

- **an account exports everything it stores, then deletes it all but the ledger, and its identity signs up afresh without new credit** (`tests/account.test.ts`, `d3b9d03b`): HTTP 503 returned; expected 201.
- **the admin site answers only on its hostname, to people Cloudflare Access signed in, with every tenant's stats** (`tests/admin-site.test.ts:25`, `d3b9d03b`): HTTP 200 returned; expected 401.
- **tenants set provider keys over REST; keys are never returned by public endpoints** (`tests/api.test.ts:132`, `d3b9d03b`): Response, event or error shape differs from the asserted source contract.
- **console routes serve the app shell as HTML, never as a download** (`tests/api.test.ts:562`, `d3b9d03b`): HTTP 401 returned; expected 404.
- **a tenant at its agent quota gets 429 with Retry-After and nothing half-created; the same key succeeds once a slot frees** (`tests/api.test.ts:584`, `d3b9d03b`): HTTP 201 returned; expected 429.
- **a tenant's own maxAgents replaces the default limit, and a change applies at the next tenants reload without a restart** (`tests/api.test.ts:615`, `d3b9d03b`): Response, event or error shape differs from the asserted source contract.
- **a tenant's monthly spend cap ends a turn after the response that crosses it, refuses new runs, and a reload raising it lets the turn continue** (`tests/api.test.ts:656`, `d3b9d03b`): Expected spend_limit outcome/metadata is missing.
- **billing recipient API, scanner-safe confirmation, and SES delivery work together** (`tests/billing-mail.test.ts`, `d3b9d03b`): Account, credit or usage response differs from the asserted source contract.
- **a prepaid tenant pays the catalog fallback plus funding when actual cost is absent; spent credit stops runs** (`tests/billing.test.ts`, `d3b9d03b`): HTTP 202 returned; expected 402.
- **free credit brings fewer busy agents (its usage tier) and an hourly spend limit, both lifted by the first purchase** (`tests/billing.test.ts`, `d3b9d03b`): HTTP 201 returned; expected 429.
- **responses on the tenant's own key cost no credit for tokens, but time in turns is charged** (`tests/billing.test.ts`, `d3b9d03b`): HTTP 404 returned; expected 201.
- **streamed OpenRouter actual cost reaches the credit ledger instead of the catalog estimate** (`tests/billing.test.ts`, `d3b9d03b`): Public response or accounting assertion differs; inspect the named contract.
- **a snapshot shows a token's reader only what its scopes and event list let it read** (`tests/browser-tokens.test.ts:119`, `d3b9d03b`): Timed out after 90 seconds; completion/event did not arrive.
- **a browser token reads its one agent's events, state, history and inputs, and nothing else** (`tests/browser-tokens.test.ts:15`, `d3b9d03b`): Response, event or error shape differs from the asserted source contract.
- **a token that redacts usage.cost reads no cost anywhere: the catalog's or the provider's, in events, snapshots, state, history and inputs** (`tests/browser-tokens.test.ts:154`, `d3b9d03b`): Timed out after 90 seconds; completion/event did not arrive.
- **a browser token's scopes, event list and redaction limit what it reads; a forged or expired one reads nothing** (`tests/browser-tokens.test.ts:75`, `d3b9d03b`): Timed out after 90 seconds; completion/event did not arrive.
- **the plugin's path works end to end, with the issuer on another origin than the MCP endpoint and sign-in pages: discovery, registration, email and password sign-in, consent, /v1/me, the review cases' tools, refresh, revocation** (`tests/chatgpt-plugin.test.ts:16`, `d3b9d03b`): Public response or accounting assertion differs; inspect the named contract.
- **the plugin's path works end to end: discovery, registration, email and password sign-in, consent, /v1/me, the review cases' tools, refresh, revocation** (`tests/chatgpt-plugin.test.ts:16`, `d3b9d03b`): Public response or accounting assertion differs; inspect the named contract.
- **through the API: saving lists the server with a credential for the definition, agents get their own, and nothing shows the credential** (`tests/credential-exchange.test.ts`, `d3b9d03b`): Response, event or error shape differs from the asserted source contract.
- **a run on a tenant with too little credit stops before any call, as a spend limit; a small balance caps the call's max_tokens** (`tests/credit-holds.test.ts:114`, `d3b9d03b`): Public response or accounting assertion differs; inspect the named contract.
- **adding a password: a Google account's own address at once, any other address through a link confirmed with the password** (`tests/email-signup.test.ts`, `d3b9d03b`): Expected response field is missing (reading kind).
- **an address a Google account signed up with is not joined, taken over or given a second account: its owner is told to use Google** (`tests/email-signup.test.ts`, `d3b9d03b`): Expected response field is missing (reading kind).
- **email sign-up: a link to finish it with the chosen password makes the tenant and signs in; nothing before that** (`tests/email-signup.test.ts`, `d3b9d03b`): The "string" argument must be of type string. Received type object ({ email: 'accounts@mail.example.test', name: 'camelRun' })
- **mailing a link is limited per source and per address, whether or not the address has an account** (`tests/email-signup.test.ts`, `d3b9d03b`): Response, event or error shape differs from the asserted source contract.
- **password reset: the same answer for any address; the link sets a new password once and ends every password session** (`tests/email-signup.test.ts`, `d3b9d03b`): Expected response field is missing (reading token).
- **sign-up links: tampered, expired and used links fail alike; a second sign-up for an address with an account gets the same answer and a different mail** (`tests/email-signup.test.ts`, `d3b9d03b`): Public response or accounting assertion differs; inspect the named contract.
- **the MCP consent page: sign up there, follow the link, and come back signed in to consent** (`tests/email-signup.test.ts`, `d3b9d03b`): Public response or accounting assertion differs; inspect the named contract.
- **the API: a person's lowBalance, and the end users under their threshold** (`tests/end-user-balance-events.test.ts`, `d3b9d03b`): Account, credit or usage response differs from the asserted source contract.
- **the end-user API: settings, entries, an end user and their ledger, for the tenant only** (`tests/end-user-credits.test.ts:145`, `d3b9d03b`): HTTP 404 returned; expected 200.
- **the history API and the TypeScript SDK: ledger filters and per-day totals, for the tenant only** (`tests/end-user-history.test.ts`, `d3b9d03b`): Unknown API route
- **the lots API and the TypeScript SDK: expiring grants, lots on the end user, marking, refunds by lot, for the tenant only** (`tests/end-user-lots.test.ts`, `d3b9d03b`): Unknown API route
- **a queued run refused as it starts for a bucket limit above 0 carries end_user_credit and bucket_limit: its record, request and run.failed** (`tests/end-user-reasons.test.ts`, `d3b9d03b`): HTTP 404 returned; expected 200.
- **a queued run refused as it starts for a bucket limit of 0 carries end_user_credit and bucket_limit: its record, request and run.failed** (`tests/end-user-reasons.test.ts`, `d3b9d03b`): HTTP 404 returned; expected 200.
- **a queued run refused as it starts for no balance carries end_user_credit and balance: its record, request and run.failed** (`tests/end-user-reasons.test.ts`, `d3b9d03b`): HTTP 404 returned; expected 200.
- **a queued run refused as it starts for the daily limit carries end_user_credit and daily_limit: its record, request and run.failed** (`tests/end-user-reasons.test.ts`, `d3b9d03b`): HTTP 404 returned; expected 200.
- **the TypeScript SDK: a queued run refused as it starts is a failed run with code end_user_credit and its reason, not runtime_error** (`tests/end-user-reasons.test.ts`, `d3b9d03b`): HTTP 404 returned; expected 200.
- **a long reply stops at the end of its end user's credit, mid-stream, and is not retried** (`tests/end-user-runs.test.ts`, `d3b9d03b`): Expected spend_limit outcome/metadata is missing.
- **a run's own bucket is what its start is checked against, and the runs after it that name none (the runtime's own too) inherit it, never "default"** (`tests/end-user-runs.test.ts`, `d3b9d03b`): HTTP 400 returned; expected 202.
- **a run's own bucket, the agent's bucket and a stateless run's each spend their own allowance** (`tests/end-user-runs.test.ts`, `d3b9d03b`): Public response or accounting assertion differs; inspect the named contract.
- **an end user's allowance pays first, then their balance; out of both, the turn stops and their next run is refused** (`tests/end-user-runs.test.ts`, `d3b9d03b`): HTTP 404 returned; expected 200.
- **concurrent replies for one end user share their credit: their holds never add up to more than it** (`tests/end-user-runs.test.ts`, `d3b9d03b`): Public response or accounting assertion differs; inspect the named contract.
- **the TypeScript SDK: endUsers configure, grant, get and ledger; an agent's bucket; a run out of credit fails with code end_user_credit** (`tests/end-user-runs.test.ts`, `d3b9d03b`): Unknown API route
- **usage API and TypeScript SDK parse times, group usage and isolate tenants** (`tests/end-user-usage.test.ts:96`, `d3b9d03b`): Unknown API route
- **end-user events reach an endpoint that selected them, signed** (`tests/end-user-webhooks.test.ts`, `d3b9d03b`): Timed out waiting for the turn to end
- **a scope's baseUrl is a public address the runtime may call, checked when saved and at every call** (`tests/key-scopes.test.ts`, `d3b9d03b`): HTTP 200 returned; expected 400.
- **a scope's baseUrl replaces the provider's root, a keyless entry sends only its gateway's headers, and an agent's modelHeaders come after them** (`tests/key-scopes.test.ts`, `d3b9d03b`): Response, event or error shape differs from the asserted source contract.
- **a scope's model provider need not be the tenant's: an agent may be created on it, and Bedrock takes its key as a bearer token** (`tests/key-scopes.test.ts`, `d3b9d03b`): Expected string field/event is missing.
- **key scopes store sealed entries, and an agent's calls use its scope's current key, gateway and headers, else the tenant's** (`tests/key-scopes.test.ts:10`, `d3b9d03b`): Response, event or error shape differs from the asserted source contract.
- **the platform operator makes a prepaid tenant like a sign-up's, with an API token, credits it and deletes it** (`tests/operator-tenants.test.ts`, `d3b9d03b`): HTTP 404 returned; expected 202.
- **the operations endpoint names its own protected resource, and answers nobody who is not signed in** (`tests/ops-mcp.test.ts:38`, `d3b9d03b`): The "string" argument must be of type string. Received type object (null)
- **only the tenants on AGENT_OPS_ADMINS connect: anyone else is refused at consent, and /mcp is untouched** (`tests/ops-mcp.test.ts:59`, `d3b9d03b`): HTTP 401 returned; expected 403.
- **the tools: read-only rows a dashboard charts, and a token that works here works nowhere else** (`tests/ops-mcp.test.ts:86`, `d3b9d03b`): Public response or accounting assertion differs; inspect the named contract.
- **an allowed origin serves a custom provider over http, while web_fetch still cannot reach it** (`tests/outbound-origins.test.ts:5`, `d3b9d03b`): Response, event or error shape differs from the asserted source contract.
- **imported usage and forks are free; the next real turn is billed once (inline)** (`tests/pi-durable-accounting.test.ts:48`, `d3b9d03b`): Timed out waiting for the import to finish
- **imported usage and forks are free; the next real turn is billed once (process)** (`tests/pi-durable-accounting.test.ts:48`, `d3b9d03b`): Timed out waiting for the import to finish
- **an admin tenant's traffic (camelAI's servers behind a few Cloudflare egress addresses, its users' browser tokens) is never rate limited** (`tests/rate-limits.test.ts`, `d3b9d03b`): HTTP 401 returned; expected 429.
- **creates and runs answer with X-RateLimit-* headers; an upsert that changes nothing is not a create, and gives the same configHash** (`tests/rate-limits.test.ts`, `d3b9d03b`): Response, event or error shape differs from the asserted source contract.
- **the server answers 429 RATE_LIMITED with Retry-After and the limit: per address behind Cloudflare, per tenant for creates and runs** (`tests/rate-limits.test.ts`, `d3b9d03b`): HTTP 200 returned; expected 429.
- **without AGENT_TRUST_CF_CONNECTING_IP, CF-Connecting-IP is ignored and the load balancer's X-Forwarded-For entry counts** (`tests/rate-limits.test.ts`, `d3b9d03b`): Public response or accounting assertion differs; inspect the named contract.
- **a run's own spend limit ends that run once it crosses it, and leaves the agent's limit and later runs alone** (`tests/spend-limits.test.ts`, `d3b9d03b`): Timed out waiting for the turn to end
- **an agent's spend limit ends the turn that crosses it and refuses new prompts until a new limit, which counts from zero** (`tests/spend-limits.test.ts`, `d3b9d03b`): Timed out waiting for the turn to end
- **over the API: uploads need credit, stop at the free limit with STORAGE_LIMIT, and the operator can raise a tenant's limit** (`tests/storage-limits.test.ts`, `d3b9d03b`): HTTP 201 returned; expected 402.
- **an agent with work left that cannot be loaded is tried again with capped backoff, never for good, and says so** (`tests/tenant-reads.test.ts:117`, `d3b9d03b`): Unsupported fixture state: Workers agents do not resume from versioned Postgres agent headers
- **a request whose open-work mark could not be written is not taken, and its retry runs** (`tests/tenant-reads.test.ts:144`, `d3b9d03b`): Unsupported fixture state: Workers request admission does not update Postgres pending_runs
- **?request= keeps a stream or poll to one request's events and response** (`tests/tenant-reads.test.ts:44`, `d3b9d03b`): Timed out after 90 seconds; completion/event did not arrive.
- **a tenant reads its agent's events, state, history and inputs with its own token, and no other tenant can** (`tests/tenant-reads.test.ts:6`, `d3b9d03b`): a tenant's stream is always a watcher + actual - expected + undefined - true
- **a subscriber that goes away before its stream opens gives its place back** (`tests/tenant-reads.test.ts:60`, `d3b9d03b`): HTTP 500 returned; expected 200.
- **a tenant's own watcher bound, from the tenants file, replaces the default** (`tests/tenant-reads.test.ts:82`, `d3b9d03b`): HTTP 200 returned; expected 429.

## Webhooks (9 observed failures)

Expected behavior: `src/webhooks.ts`, `src/api.ts`.

- **registered billing webhooks are delivered by the existing worker with valid signatures** (`tests/billing-alerts.test.ts`, `d3b9d03b`): HTTP 404 returned; expected 201.
- **a rotated usage webhook secret signs beside the old one for a day, and removing the webhook stops events** (`tests/usage-webhooks.test.ts`, `d3b9d03b`): Timed out waiting for the event
- **calls through a tenant's own endpoint are sent too, named as the agent names its model** (`tests/usage-webhooks.test.ts`, `d3b9d03b`): Response, event or error shape differs from the asserted source contract.
- **each model response's usage is POSTed, signed, to the tenant's webhook: retried after a failure, and kept across a restart** (`tests/usage-webhooks.test.ts`, `d3b9d03b`): Timed out waiting for both events attempted
- **a run whose event could not be written when it ended has it written with the agent's next load or run, once** (`tests/webhooks.test.ts`, `d3b9d03b`): Timed out waiting for both runs' events
- **in a rolling deploy, nodes of the previous release see only usage webhook deliveries, and their usage webhook changes take effect** (`tests/webhooks.test.ts`, `d3b9d03b`): Timed out waiting for every delivery attempted
- **a run that ends with an error is sent as run.failed** (`tests/webhooks.test.ts:103`, `d3b9d03b`): Timed out waiting for run.failed
- **the usage webhook still works, apart from endpoints, and gets usage in its original body** (`tests/webhooks.test.ts:118`, `d3b9d03b`): Timed out waiting for the usage event
- **webhook endpoints: registered with the event types they want, managed, and each sent its events in a signed envelope** (`tests/webhooks.test.ts:25`, `d3b9d03b`): Timed out waiting for run.started

## Lifecycle / requests / SDK (41 observed failures)

Expected behavior: `src/client-sessions.ts`, `src/runs.ts`, `src/history.ts`, `src/history-pages.ts`, `src/pi-durable/agent.ts`, `src/api.ts`.

- **the same key with a changed configuration reconfigures the agent instead of refusing; what cannot change says so** (`tests/agent-lifetime.test.ts:108`, `c1a32b21`): Agent detail did not expose tools[0]; the tools property was undefined.
- **the last upsert wins: back to an earlier configuration, and upserts queued behind a running turn** (`tests/agent-lifetime.test.ts:142`, `c1a32b21`): The later upsert returned no reconfigured request while the preceding target was initializing.
- **an agent is made without a model key; its first run says which key to set** (`tests/agent-lifetime.test.ts:50`, `c1a32b21`): Run ended without the required model-key error; top-level record.error was undefined.
- **a key whose agent was deleted or expired makes a fresh agent, with a new token; the old one stays gone** (`tests/agent-lifetime.test.ts:83`, `c1a32b21`): Recreating an expired keyed agent returned 410 CONFIGURATION_FAILED instead of 201.
- **a message streams progress, is sent once when called again, and a full queue is busy** (`tests/agent-mcp.test.ts:87`, `4241d8af`): Configuration, lifecycle or SDK response differs from the source contract.
- **GET /v1/agents pages by cursor, filters by workspace, status and search, and lists activity and the last failure** (`tests/agents-list.test.ts:17`, `4241d8af`): Configuration, lifecycle or SDK response differs from the source contract.
- **an agent's credentials are for the account's own tokens: a browser token gets 403, an agent's token 401, and no browser origin is allowed** (`tests/agents.test.ts:102`, `4241d8af`): HTTP 403 returned; expected 401.
- **an approval: the run waits with its input, and answering it resolves with the resumed run** (`tests/agents.test.ts:174`, `4241d8af`): Configuration, lifecycle or SDK response differs from the source contract.
- **get() takes an existing agent by key or id without changing it; 404 for none, 409 for one made without a key** (`tests/agents.test.ts:83`, `4241d8af`): Missing expected rejection.
- **the OpenAPI document is served without credentials** (`tests/api.test.ts:577`, `d3b9d03b`): HTTP 401 returned; expected 200.
- **close() waits for no call the runtime gave up on, nor when there is nothing to finish** (`tests/deploy-drain.test.ts:117`, `d3b9d03b`): Timed out after 90 seconds; completion/event did not arrive.
- **a call cut off with its connection tells the model, in plain words, that it may or may not have run** (`tests/deploy-drain.test.ts:78`, `d3b9d03b`): Response, event or error shape differs from the asserted source contract.
- **an unknown path is a 404 that says where to start, and a known one without credentials a 401 that says how to get them** (`tests/docs.test.ts:104`, `d3b9d03b`): HTTP 401 returned; expected 404.
- **the docs are served without credentials: llms.txt, llms-full.txt and every page, the operators' too, pointing at this runtime** (`tests/docs.test.ts:11`, `d3b9d03b`): HTTP 401 returned; expected 200.
- **coding agents' setup skill is at /SKILL.md (and /skill.md), uncached; /docs sends people to the docs site** (`tests/docs.test.ts:49`, `d3b9d03b`): HTTP 401 returned; expected 200.
- **search engines may crawl everything but list neither the console nor the docs' Markdown copies; the API and MCP answer as before** (`tests/docs.test.ts:69`, `d3b9d03b`): HTTP 401 returned; expected 200.
- **every error body names a machine-readable code beside its message** (`tests/errors.test.ts:5`, `d3b9d03b`): Response, event or error shape differs from the asserted source contract.
- **idle sockets outlive the load balancer's 360 s; a drain answers a long poll under way in full, with Connection: close** (`tests/http-drain.test.ts:15`, `d3b9d03b`): Response, event or error shape differs from the asserted source contract.
- **a response carrying a secret shown once is never kept or replayed: its key's retry is a conflict** (`tests/idempotency.test.ts:35`, `4241d8af`): Public response or accounting assertion differs; inspect the named contract.
- **a key whose request died mid-way is taken over after a while, and a body past the limit is refused before it is read whole** (`tests/idempotency.test.ts:58`, `4241d8af`): while it may still be running + actual - expected [ + 201, + undefined - 409, - 'IDEMPOTENCY_IN_PROGRESS' ]
- **an Idempotency-Key header on any POST replays its first success, refuses other parameters, and names a prompt's request** (`tests/idempotency.test.ts:7`, `4241d8af`): Public response or accounting assertion differs; inspect the named contract.
- **a child's run's identity tokens name its parent (par) and its chain's first agent (root), from the signed chain** (`tests/identity-tokens.test.ts`, `d3b9d03b`): Response, event or error shape differs from the asserted source contract.
- **tool servers with auth "runtime" get a short-lived token the runtime signs, naming the agent's subject, context and the turn's actor** (`tests/identity-tokens.test.ts`, `d3b9d03b`): Response, event or error shape differs from the asserted source contract.
- **an oversized resumed range fails once, clears pending work, and remains readable and abortable** (`tests/pi-durable-context-guard.test.ts:107`, `4241d8af`): Unsupported fixture state: Workers agents have no Postgres resume_failures or resume_after
- **the UI registry's JSON is served at /r/<name>.json without credentials, pointing at this runtime** (`tests/registry.test.ts`, `d3b9d03b`): HTTP 401 returned; expected 200.
- **a rotation right after an upsert waits for the upsert's header write: it is never refused, and the token it replaced is** (`tests/revocation.test.ts`, `d3b9d03b`): HTTP 404 returned; expected 200.
- **an agent's token can be rotated: the old one stops working at once, and credentials give the new one** (`tests/revocation.test.ts`, `d3b9d03b`): HTTP 404 returned; expected 200.
- **a run's messages read as it ends are its messages, though its agent stops while answering** (`tests/runs-messages-at-end.test.ts:8`, `4241d8af`): Timed out after 90 seconds; completion/event did not arrive.
- **runs count against busy agents and runs per minute, as agent runs do, and not against agent creates** (`tests/runs.test.ts:161`, `4241d8af`): Expected response field is missing (reading name).
- **the TypeScript SDK: agents.run in one call, runs.stream as it happens, runs.get, abort and messages** (`tests/runs.test.ts:254`, `4241d8af`): Timed out after 90 seconds; completion/event did not arrive.
- **a lazy handle's stream() connects for the run, yields it from its start, and lets the stream go after** (`tests/sdk-lazy-connections.test.ts`, `4241d8af`): one stream while the run streams 0 !== 1
- **handles that need the stream keep it: onEvent, served tools, or connection: eager** (`tests/sdk-lazy-connections.test.ts`, `4241d8af`): onEvent connects at once 0 !== 1
- **scoped configuration persists allowed fields and rejects provider credentials or endpoints** (`tests/service-api.test.ts:62`, `4241d8af`): Configuration, lifecycle or SDK response differs from the source contract.
- **an agent's question shows on its call, is answered through the store, and the turn goes on** (`tests/ui-chat.test.ts`, `d3b9d03b`): Timed out waiting for the resumed turn
- **answers go to the user's own agent as the user; another user's input is not theirs to answer** (`tests/ui-handler.test.ts`, `d3b9d03b`): HTTP 404 returned; expected 200.
- **the handler mints a browser token for the user's own agent, and each user and thread has its own** (`tests/ui-handler.test.ts`, `d3b9d03b`): HTTP 401 returned; expected 403.
- **a watcher (poll) folds the stream into Pi messages as they grow, tool arguments included, and renews its token** (`tests/watch.test.ts`, `d3b9d03b`): Timed out waiting for the watcher to connect
- **a watcher (sse) folds the stream into Pi messages as they grow, tool arguments included, and renews its token** (`tests/watch.test.ts`, `d3b9d03b`): Public response or accounting assertion differs; inspect the named contract.
- **a watcher joining a turn whose snapshot was too large to carry its messages still places what follows** (`tests/watch.test.ts`, `d3b9d03b`): Timed out after 90 seconds; completion/event did not arrive.
- **a watcher whose streams deliver nothing (a proxy that buffers them) falls back to long polls** (`tests/watch.test.ts`, `d3b9d03b`): Timed out waiting for the fallback to polls
- **a watcher whose token hides the running turn still knows a turn runs** (`tests/watch.test.ts`, `d3b9d03b`): Timed out after 90 seconds; completion/event did not arrive.

## Schedules / search / other platform (18 observed failures)

Expected behavior: `src/scheduler.ts`, `src/api.ts`.

- **a run waiting on a person exits 2 and resumes once answered** (`tests/cli.test.ts`, `d3b9d03b`): Expected response field is missing (reading 0).
- **the CLI deploys a manifest, runs its agent, and manages agents and definitions** (`tests/cli.test.ts`, `d3b9d03b`): Public response or accounting assertion differs; inspect the named contract.
- **an account's export holds its journey: what this runtime kept and what the store holds; an account journey never knew has none** (`tests/journey-server.test.ts:120`, `d3b9d03b`): Timed out waiting for the token's event to reach the store
- **an email sign-up is an account made when its mailed link is finished, in the browser that finishes it** (`tests/journey-server.test.ts:148`, `d3b9d03b`): Timed out waiting for the sign-up to reach the store
- **a runtime with journey events off serves the console as ever: no tag, no cookie, no endpoint** (`tests/journey-server.test.ts:46`, `d3b9d03b`): HTTP 401 returned; expected 200.
- **with journey events on, an arrival is noted through the redirect, the browser gets its visitor id, and the console's pages reach the store** (`tests/journey-server.test.ts:57`, `d3b9d03b`): Response, event or error shape differs from the asserted source contract.
- **with journey events on, making an agent and running it tells the store of the agent, the day's activity and the account's first run** (`tests/journey-server.test.ts:88`, `d3b9d03b`): Timed out waiting for the agent, the day and the first run to reach the store
- **public accounts can email their verified address and cannot email strangers or suppressed recipients** (`tests/schedule-api.test.ts:21`, `d3b9d03b`): HTTP 400 returned; expected 403.
- **calendar schedules and owner-configured email round trip through the API without crossing accounts** (`tests/schedule-api.test.ts:7`, `d3b9d03b`): HTTP 400 returned; expected 201.
- **on a runtime configured by AGENT_TENANT, a run without a model key also names AGENT_TENANT_API_KEYS** (`tests/selfhost.test.ts:48`, `d3b9d03b`): Response, event or error shape differs from the asserted source contract.
- **a private runtime names no URL to browsers: AGENT_BROWSER_URL overrides the browser token's url, or empty leaves it out, and links carry their path on the runtime** (`tests/selfhost.test.ts:57`, `d3b9d03b`): Response, event or error shape differs from the asserted source contract.
- **web_fetch has Firecrawl render JavaScript shells, and only those, charging a platform render** (`tests/web-render.test.ts`, `d3b9d03b`): HTTP 404 returned; expected 201.
- **a definition pins web_search's providers; a platform search is charged at the answering provider's price and counted in the hour's ledger entry** (`tests/web-search.test.ts`, `d3b9d03b`): HTTP 404 returned; expected 201.
- **a search key the operator set for a tenant (its apiKeys) is used, and is not counted as the platform's** (`tests/web-search.test.ts`, `d3b9d03b`): Expected response field is missing (reading token).
- **an operator's tenant without a key of its own searches on the platform's, recorded as platform usage and never charged; its own key wins; platformKeys: false keeps the refusal** (`tests/web-search.test.ts`, `d3b9d03b`): Expected response field is missing (reading token).
- **codemode's searches on the platform's key stop once the tenant's credit is spent, without waiting for the next model request** (`tests/web-search.test.ts`, `d3b9d03b`): HTTP 404 returned; expected 201.
- **web_search uses the tenant's own search key, else the platform's billed to credit, and pairs with web_fetch** (`tests/web-search.test.ts`, `d3b9d03b`): HTTP 404 returned; expected 201.
- **X search works in agents and stateless runs, uses tenant keys first and bills only platform requests** (`tests/x-search.test.ts`, `d3b9d03b`): Response, event or error shape differs from the asserted source contract.

## Python SDK (9 observed failures)

Expected behavior: `src/api.ts`, `src/client-sessions.ts`.

- **PythonSDKTest.test_an_approval_answered_by_on_input_resumes_the_turn** (`tests/python_sdk.py`, `d3b9d03b`): Lists differ: [] != ['d1'] Second list contains 1 additional elements. First extra element 0: 'd1' - [] + ['d1']
- **PythonSDKTest.test_an_approval_answered_through_the_run_resumes_it** (`tests/python_sdk.py`, `d3b9d03b`): Backend operation failed
- **PythonSDKTest.test_end_users_credit_their_users_and_a_run_spends_from_its_bucket** (`tests/python_sdk.py`, `d3b9d03b`): Unknown API route
- **PythonSDKTest.test_images_on_their_own** (`tests/python_sdk.py`, `d3b9d03b`): Unknown account
- **PythonSDKTest.test_key_scopes_tokens_usage_webhooks_and_rotated_credentials** (`tests/python_sdk.py`, `d3b9d03b`): list index out of range
- **PythonSDKTest.test_lazy_handles_hold_no_stream_while_idle_run_without_one_and_stream_for_a_run** (`tests/python_sdk.py`, `d3b9d03b`): Tenant concurrency limit
- **PythonSDKTest.test_run_with_output_returns_a_pydantic_model_or_the_json_schema_value** (`tests/python_sdk.py`, `d3b9d03b`): Tenant concurrency limit
- **PythonSDKTest.test_stateless_runs_one_call_stream_get_abort_and_no_agent_left** (`tests/python_sdk.py`, `d3b9d03b`): Public response or accounting assertion differs; inspect the named contract.
- **PythonSDKTest.test_the_sync_client_upserts_runs_streams_answers_and_runs_statelessly** (`tests/python_sdk.py`, `d3b9d03b`): Backend operation failed
