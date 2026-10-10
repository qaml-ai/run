# Models and keys

## Choosing a model

Agents name a model as `provider/model-id` from the catalog: `GET /v1/models`
(`?available=true` for the ones your account can use now), or the console's
**Models & keys**. For example `anthropic/claude-sonnet-5-5`,
`openai/gpt-5.2`, `openrouter/anthropic/claude-sonnet-5`. Change an agent's model
between runs with `upsert` (a changed `model`) or `agent.configure({ model })`;
its history carries over. `?available=true` answers `[]` when your account has
no key any model can use (a self-hosted runtime before its first key, say); that
response's `X-Camelrun-Hint` header says how to set one.

Each model in the list says whether it streams tool-call arguments as it writes
them (`toolCallStreaming`; the console's **Tool args** column). With `true`,
`toolcall_delta` events arrive while the model writes a call's arguments, so a
page that renders what a tool writes (a section, a card, a form) can show it as it
is written. With `false`, the arguments arrived in one piece when the call was
complete, at least sometimes, so you cannot count on streaming: Gemini, most GLM
4.x and Mercury 2 through OpenRouter do this, for example, and some models do it
only on some of the hosts a gateway routes them to. `"unknown"` means the model
has not been measured (or its probe failed), not that it streams. The values come
from probing each model through the runtime several times
(`scripts/probe-tool-streaming.ts`); a latency-first app that renders tool output
should pick a model that says `true`.

A model on a server of your own that speaks OpenAI's or Anthropic's API (vLLM,
Ollama, a gateway, a hosted API the catalog lacks) is named the same way once
you add its server as a provider, your account's or a key scope's: see
[Custom models](custom-models.md).

An agent that names no model (and whose definition names none) gets the
runtime's default: Claude Sonnet 5.5 on run.camelai.com, on the first of
Anthropic (`anthropic/claude-sonnet-5-5`), OpenRouter
(`openrouter/anthropic/claude-sonnet-5.5`) and Bedrock
(`amazon-bedrock/global.anthropic.claude-sonnet-5-5`) you have a key for (its
key scope's keys count too), else `openrouter/openai/gpt-6-luna`. It is chosen
when the agent is made and stays its model. `GET /v1/me` says which
(`defaultModel`; `runtime.me()` in the SDKs).

A model call uses, in order: the key of the agent's [key scope](#key-scopes) for
the model's provider, else your account's own key for the provider
(`PUT /v1/providers/:provider/key`, or the console), else the platform's key,
charged to your credit. An account that signed up before billing never uses the
platform's. A provider with your own key never uses the platform's. An agent on
a provider none of these has a key for is still made, and its runs fail with
`model_key_missing`, naming the key to set. Web search and `web_fetch`'s page
rendering take their keys (`exa`, `brave`, `parallel`, `firecrawl`) the same way,
without key scopes.

`PUT /v1/providers/:provider/key` checks the key with the provider before it
stores it, and refuses one the provider rejects. `{"apiKey": "…", "verify": false}`
stores it unchecked (a placeholder, a key for a provider the runtime cannot
reach yet). A run on a key the provider refuses fails with `model_key_invalid`.

A self-hosted runtime's operator can also give an account keys, and route its
model calls through a gateway of the operator's own: see
[Billing](../operations/billing.md) and [Model endpoints](../operations/model-endpoints.md).

### Amazon Bedrock

Bedrock takes a [Bedrock API key](https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys.html),
sent as a bearer token, and the AWS region to call. It is the only credential
the runtime takes for Bedrock: no AWS access keys, no SigV4 signing, and never
AWS credentials the runtime's own host has.

- For the whole account: `PUT /v1/providers/amazon-bedrock/key` with
  `{"apiKey": "…", "region": "us-west-2"}`, or the console's Models page. The
  region is required. The key is not checked when saved (Bedrock has no free
  call for it): the first model call is.
- For one key scope: `PUT /v1/key-scopes/:scope/providers/amazon-bedrock` with
  `{"apiKey": "…", "region": "us-west-2"}`, or a regional `baseUrl`
  (`https://bedrock-runtime.<region>.amazonaws.com`) the region is read from
  (see [Key scopes](#key-scopes)).

Name Bedrock's Claude models by an inference profile:
`amazon-bedrock/global.anthropic.claude-sonnet-5-5` (routed anywhere, the
catalog's price), or a geography's, such as `us.` or `eu.` (kept in that
geography, a tenth dearer). Bedrock refuses a Claude model's base id
(`anthropic.claude-sonnet-5-5`) on demand, so `GET /v1/models` lists the
profiles only, and an agent that names a base id is called through its global
profile. An inference profile's geography must include the key's region.

### Output length and temperature

Two settings shape each model response. `maxOutputTokens` is the most the model
writes in one response. It must be at most the model's own maximum (`maxTokens`
in `GET /v1/models`), which is also the default. A response that reaches it ends
with `stopReason: "length"`. On a Claude model with a thinking budget (models
before adaptive thinking, such as Claude Sonnet 4.5), the budget comes on top.
Elsewhere, reasoning counts toward it.

`temperature` (0 to 2) sets how varied the model's sampling is: lower is more
deterministic. The default is the provider's. Not every model takes one, and a
temperature a model would refuse would fail every run, so the runtime refuses it
with a 400 where you set it:

- Claude Opus 4.7 and later, Sonnet 5.5 and Fable 5.1 take none, wherever they are
  served (Anthropic, Bedrock, OpenRouter).
- A model that always reasons takes none: OpenAI's o-series and GPT-5, Claude Fable 5.
- A reasoning model takes none while it reasons: its `thinkingLevel` must be `off`.
  Give `"thinkingLevel": "off"` with the temperature, or `"temperature": null` with
  a new thinking level.

Set them when you make an agent, for a [stateless run](stateless-runs.md), or for
every agent of a [definition](definitions.md). Change them with
`PATCH /v1/agents/:id/configuration`; `null` removes either. The same check runs
there, against the model and thinking level the agent will have. `GET /v1/agents/:id`
shows both (`null` when unset).

```json
{"model": "anthropic/claude-sonnet-5", "maxOutputTokens": 2000, "temperature": 0.2}
```

Compaction summaries keep the runtime's own settings. If a later change makes a
temperature inapplicable (a definition applied with a new model or thinking level),
the agent's calls leave it out rather than fail.

### Prompt caching

The runtime marks the system prompt and tools (and the latest message) as a
cached prefix on Anthropic's API and on Bedrock's Claude models; OpenAI and
others cache on their own. The prefix is the same bytes from run to run (no
dates or ids in it; files and the sender of a message go in the messages), so
from an agent's second run on, `usage.cacheRead` counts what came from the cache.
A provider caches only a prefix past its minimum: on Anthropic 1,024 tokens for
Sonnet 5 and Opus 4.8, 2,048 for Opus 4.7, 4,096 for Haiku 4.5 and Opus 4.6.
An agent's runtime prompt and tools come to about 2,000 tokens, so on Haiku 4.5
a short-instruction agent caches nothing (`cacheRead: 0`) until its prefix
passes 4,096 tokens; on Sonnet 5 its second run reads about 2,400 tokens from
the cache. An agent that needs no tools can drop most of that prefix instead
(`codeMode: false`; see [Tools](tools.md#without-code-codemode-false)).

## Key scopes

An application that serves many customers can give each its own provider
credentials, so its agents call providers directly with that customer's keys: a
**key scope** per customer (e.g. `org_abc123`), holding one entry per provider.

```http
PUT /v1/key-scopes/org_abc123/providers/openrouter
{"apiKey": "sk-or-…", "baseUrl": "https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/openrouter",
 "headers": {"cf-aig-authorization": "Bearer <gateway token>"}}
```

In Python, `await agents.runtime.set_scope_key("org_abc123", "openrouter", api_key=…, base_url=…, headers=…)`;
`key_scope(scope)`, `delete_scope_key(scope, provider)` and `delete_key_scope(scope)` read and remove them.

- An entry is `{apiKey?, baseUrl?, headers?, region?}`. `headers` are sent with
  every call, sealed like the key. The provider is any model provider of
  `GET /v1/providers` that takes a key, or `amazon-bedrock`.
- `baseUrl` (HTTPS, on a public address: it is checked when saved, and each call
  goes through the same [outbound guard](tools.md#outbound-calls) as MCP servers
  and `web_fetch`; Google's and Mistral's clients can't be kept to it, so their
  entries take no `baseUrl`) replaces the provider's API
  root in each request's URL, as an AI gateway's provider path stands for it
  (Cloudflare AI Gateway's `…/openrouter`, `…/anthropic`, `…/openai`):

  | provider | root `baseUrl` replaces | requests |
  |---|---|---|
  | `openrouter` | `https://openrouter.ai/api/v1` | `POST <baseUrl>/responses`; Anthropic models (its Messages API) `POST <baseUrl>/messages?beta=true` |
  | `anthropic` | `https://api.anthropic.com` | `POST <baseUrl>/v1/messages?beta=true` |
  | `openai` | `https://api.openai.com/v1` | `POST <baseUrl>/responses` (or `/chat/completions`, per the catalog's API for the model) |
  | `amazon-bedrock` | `https://bedrock-runtime.<region>.amazonaws.com` | `POST <baseUrl>/model/<URL-encoded id>/converse-stream` |
  | others | the model's base URL in `GET /v1/models` | as the provider's API appends |

- `apiKey` may be left out for `openrouter`, `anthropic` or `openai` behind a
  `baseUrl`: a gateway that holds the provider's key itself (authenticated by,
  say, `cf-aig-authorization` in `headers`). Its calls send no `Authorization` or
  `x-api-key` header, only the entry's `headers`.
- For `amazon-bedrock` the key is a Bedrock API key, sent as a bearer token (no
  SigV4), and the entry needs its region: `region`, or a regional `baseUrl`
  `https://bedrock-runtime.<region>.amazonaws.com`, which it is read from. Model
  ids are the catalog's inference profiles
  (`amazon-bedrock/us.anthropic.claude-sonnet-5`); see [Amazon Bedrock](#amazon-bedrock).
- `GET /v1/key-scopes/:scope` lists the providers set, with each key's last four
  characters, `baseUrl`, `region` and the extra headers' names, never a secret.
  `DELETE /v1/key-scopes/:scope/providers/:provider` removes an entry, and
  `DELETE /v1/key-scopes/:scope` the whole scope. Scope ids are 1–100 letters,
  digits, `_`, `.` and `-`. Keys and headers are stored sealed, bound to your account, the scope and the provider.
- An agent gets `keyScope` at creation (`POST /v1/agents`,
  the SDKs' `createAgent`), or through `PATCH /v1/agents/:id/configuration`
  (`null` clears it; the agent's own token cannot change it). Applying a
  definition keeps it. Models are named as usual, e.g.
  `openrouter/anthropic/claude-sonnet-5` (a routing variant like `:nitro` too),
  `anthropic/claude-opus-5` or `amazon-bedrock/us.anthropic.claude-sonnet-5`.
  OpenRouter's models are called through its Responses API (stateless, reasoning
  carried back as it came), whatever key they use, except Anthropic's, which keep
  its Messages API for prompt caching: the same rule as on a tenant's endpoint.
- Each model call, compaction summaries included, takes the key of the agent's
  scope for the model's provider, else the tenant's own key, else the
  platform's (see above). It is read at the call, so a changed key applies
  to every agent of the scope from its next call, within five seconds. An agent may be
  created on a provider only its scope has a key for.
- Scope keys are the tenant's own: no platform token charge, like a tenant's key
  (agent time is charged as usual), and their calls are counted in `/v1/usage`
  under the model as usual.
- A scope's (else the tenant's, else the platform's) `openai` key also transcribes
  its agents' audio, and `POST /v1/transcriptions` with that `keyScope` (see
  [Voice and audio](voice.md)), and makes images for `POST /v1/images` with that
  `keyScope` (see [Images](images.md)).

## Model headers

`modelHeaders: {name: value}` at creation or through `PATCH
/v1/agents/:id/configuration` are non-secret headers sent on each of the agent's
model calls, compaction included, e.g. `{"cf-aig-metadata": "{\"org\": …, \"thread\": …}"}`
to label a shared gateway's logs per conversation. A PATCH replaces them whole;
`null` or `{}` removes them. They come after a key scope entry's `headers` (and
win on a clash). At most 20 and 8 KB; `authorization`, `x-api-key`,
`x-goog-api-key`, `cf-aig-authorization`, `chatgpt-account-id`,
`x-agent-runtime-identity`, `x-amz-*` and transport headers (`host`,
`content-length`, `content-type`, `transfer-encoding`, `connection`) are refused
with 400. Only the tenant sets them; `GET /v1/agents/:id` shows them.

## Spend limits

`spendLimit: {"usd": n}` at creation or through `PATCH /v1/agents/:id/configuration`
is the most the agent may spend on model calls from then on: their cost as the
[webhooks](webhooks.md) (`usage.recorded`) reports it (the provider's own when it reports
one, else the catalog price), turns and compaction summaries, whoever's key they
ran on. Setting a value starts counting from zero; `null` removes it. A PATCH applies it at once, ahead of runs already queued. `GET /v1/agents/:id`
shows `spendLimit: {usd, spent}`. An agent at or over its limit gets 402 for new
`prompt` and `continue` runs, and a running turn ends after the response that
crossed it (its tool calls run and are recorded), with `stopped: "spend_limit"`:
the SDKs' `run()` fails with code `spend_limit`. The result's `limit` says which
limit it was: `"run"` (the run's own budget, below), `"agent"` (the agent's),
`"tenant"` (your account's monthly cap) or `"credit"` (your prepaid credit ran out).
Only you can set it, not the agent's own token.

A run can have a budget of its own: `spendLimit: {"usd": n}` on
`POST /v1/agents/:id/prompt` (the SDKs' `run`, `stream` and `prompt` take
`spendLimit`, `spend_limit=` in Python). The run ends the same way once it has
spent that, before its next model request; the agent's own limit is unchanged,
and still counts the run. To give each prompt what is left of a budget you keep,
send it with the prompt instead of reconfiguring the agent.

## Run limits

A run also stops at **1,000 model responses** (compaction summaries count) or
**2 hours** from when it began, whichever comes first, so a model that never stops
calling tools ends on its own. Like a spend limit, the turn ends after the response
that reached the limit (its tool calls run and are recorded), before the next model
request, with `stopped: "turn_limit"` and `code: "turn_limit"`; the reason is in
`error`, e.g. `This run stopped at its limit of 1000 model responses. Send another
message to continue`. The history stays valid: the next message picks up from there.
The SDKs' `run()` fails with code `turn_limit`.

Lower them for an agent with `runLimits: {"maxResponses": n, "maxSeconds": n}` (the
SDKs' `runLimits`, `run_limits=` in Python) when you make it, or with
`PATCH /v1/agents/:id/configuration` (`null` removes them), or for every agent of a
[definition](definitions.md) with its `runLimits`. An agent's own stay when its
definition is applied. One run can lower them further: `runLimits: {"maxResponses": n,
"maxSeconds": n}` on `POST /v1/agents/:id/prompt` (the SDKs' `run`, `stream`, `prompt`
and `send` take `runLimits`, `run_limits=` in Python) applies to that run alone, and
only where it is lower than the agent's. Values above the runtime's maximums count as the maximums,
which its operator sets (see [Configuration](../operations/configuration.md),
`AGENT_MAX_RUN_RESPONSES`). Only you can set them, not the agent's own token. They are counted on the node running the
turn: a turn resumed on another node after its node was lost counts again from there.

### Context size

A long history is compacted (its older part summarized) before a request would not fit the model's context window.
On a model with a large window that is late: every request reads the whole context, so a long-lived agent pays for
its history on each step long before it nears a million tokens. `runLimits.contextTokens` (at least 20,000) keeps
each of the agent's requests within that many tokens instead: compaction starts in the background somewhat below
it, and the summary, the recent messages and the system prompt carry on from there. Set it like the other run
limits, on the agent or its definition; a single run cannot set it. For a chat agent whose turns mostly need what
happened recently, 100,000 is a reasonable start.
