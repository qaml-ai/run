# Models and keys

## Choosing a model

Agents name a model as `provider/model-id` from the catalog: `GET /v1/models`
(`?available=true` for the ones your account can use now), or the console's
**Models & keys**. For example `anthropic/claude-sonnet-5-5`,
`openai/gpt-5.2`, `openrouter/anthropic/claude-sonnet-5`. Change an agent's model
between runs with `upsert` (a changed `model`) or `agent.configure({ model })`;
its history carries over.

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
(`PUT /v1/providers/:provider/key`, or the console), else, for prepaid accounts,
the platform's key, charged to your credit. Agents cannot be made on a provider
none of these has a key for.

## Your own model endpoint

A tenant can have its agents' model calls go through its own pass-through
gateway, e.g. a proxy that checks credit per call, swaps in the real provider
key (its customers' own, a subscription) and meters usage, the way Cloudflare's
AI Gateway does. The runtime speaks each provider's native protocol to it, so
nothing is translated: the gateway forwards the bytes as they are. Its entry in
the tenants file names the endpoint as a provider:

```json
"camel": {"tokenSha256": "…", "modelEndpoints": {"chiridion": {
  "baseUrl": "https://camelai.com/agent-runtime/llm",
  "models": {"openrouter/deepseek/deepseek-v4:free": {"contextWindow": 128000, "maxTokens": 8192, "reasoning": true, "input": ["text"]}}
}}}
```

- Agents name its models as `<name>/<provider>/<model id>`, e.g.
  `"chiridion/anthropic/claude-opus-5"` or
  `"chiridion/openrouter/anthropic/claude-sonnet-5:nitro"`, at creation, in a
  definition or through `PATCH /v1/agents/:id/configuration`. Bedrock models also
  name their region: `"chiridion/amazon-bedrock/us-west-2/us.anthropic.claude-sonnet-5"`.
  The model is Pi's catalog model `<provider>/<model id>` (its metadata, API and
  compatibility; a routing variant like `:nitro` or `:free` is looked up without
  the suffix). Or it is one declared in `models` under everything after
  `<name>/`. `GET /v1/models` lists the declared ones. The model id is sent
  exactly as given, variant and all.
- `<baseUrl>/<provider>` stands for the provider's API root below. The gateway
  strips `<baseUrl>/<provider>` (plus the region, for Bedrock) and appends the
  rest of the path, query included, to the root. The runtime puts its identity
  token where the provider takes its key.

  | provider | upstream root | requests | key header |
  |---|---|---|---|
  | `anthropic` | `https://api.anthropic.com` | `POST /v1/messages?beta=true` | `x-api-key` |
  | `openai` | `https://api.openai.com/v1` | `POST /responses` | `Authorization: Bearer` |
  | `openrouter` | `https://openrouter.ai/api` | `POST /v1/responses`; Anthropic models `POST /v1/messages?beta=true` | `Authorization: Bearer`; `x-api-key` |
  | `google` | `https://generativelanguage.googleapis.com/v1beta` | `POST /models/<id>:streamGenerateContent?alt=sse` | `x-goog-api-key` |
  | `amazon-bedrock` | `https://bedrock-runtime.<region>.amazonaws.com`, from `<baseUrl>/amazon-bedrock/<region>` | `POST /model/<URL-encoded id>/converse-stream` | `Authorization: Bearer` (unsigned; no SigV4) |
  | `openai-codex` | `https://chatgpt.com/backend-api` | `POST /codex/responses` (SSE, body `Content-Encoding: zstd`) | `Authorization: Bearer`, with `chatgpt-account-id: passthrough` |

  OpenRouter's models use its Responses API, stateless (`store: false`, the whole
  conversation each call), with reasoning kept and sent back as it came
  (`encrypted_content` or `signature`). Its Anthropic models keep its Messages API,
  as in Pi's catalog, because Responses gets them no prompt caching. Bedrock
  requests are HTTP/1.1, and their ids are sent as given: a model id
  (`anthropic.claude-sonnet-5`) or an inference profile's (`us.…`, `eu.…`,
  `global.…`); Pi's catalog has both.
  `openai-codex` is ChatGPT's Codex backend, e.g.
  `"chiridion/openai-codex/gpt-5.5"`: the tenant replaces `Authorization` with
  the user's ChatGPT access token and sets the real `chatgpt-account-id`. Its
  requests are stateless too, and also carry `originator`, `OpenAI-Beta`, and,
  in a turn, `session-id` and `x-client-request-id` (the agent's id), which the
  backend takes as they are.
- Every call also carries the token as `X-Agent-Runtime-Identity`. This is the
  EdDSA JWT that MCP servers with `auth: {"type": "runtime"}` get (see
  [Identity tokens](tools.md#identity-who-a-call-is-for)). Its `aud` is the
  endpoint's `baseUrl` exactly as configured, and it has the same claims:
  `tenant`, `agent`, `sub`, `act` (the turn's actor), `ctx` and `definition`. A
  fresh token is minted for every call, compaction summaries included, and lasts
  two minutes. Verify it against `/.well-known/jwks.json`; the runtime sends no
  key.
- The runtime does not retry the endpoint's errors, since the gateway retries
  itself. A refusal before the stream (e.g. an HTTP 402 or 429 in the
  provider's error format), a 5xx or an error mid-stream ends the turn, with the
  message as the outcome's `error`. A context overflow still compacts and
  continues once.
- Calls to it cost the runtime nothing. They are counted in `/v1/usage` under
  `<name>/<provider>/<model id>` at zero cost, and are never charged as platform
  tokens or counted toward `maxMonthlyCost`. Agent time is charged as with a
  tenant's own key.
- The endpoint is the operator's: it must be HTTPS (plain HTTP only to
  localhost, for development), and its name cannot be one of Pi's providers.
  Changes apply from the next tenants reload to agents created or configured
  after it.

## Key scopes

An application that serves many customers can give each its own provider
credentials, so its agents call providers directly with that customer's keys: a
**key scope** per customer (e.g. `org_abc123`), holding one entry per provider.

```http
PUT /v1/key-scopes/org_abc123/providers/openrouter
{"apiKey": "sk-or-…", "baseUrl": "https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/openrouter",
 "headers": {"cf-aig-authorization": "Bearer <gateway token>"}}
```

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
  ids are the catalog's, inference profiles included
  (`amazon-bedrock/us.anthropic.claude-sonnet-5`).
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
  scope for the model's provider, else the tenant's own key, else an admin's,
  else (prepaid) the platform's. It is read at the call, so a changed key applies
  to every agent of the scope from its next call, within five seconds. An agent may be
  created on a provider only its scope has a key for.
- Scope keys are the tenant's own: no platform token charge, like a tenant's key
  (agent time is charged as usual), and their calls are counted in `/v1/usage`
  under the model as usual.

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
the SDKs' `run()` fails with code `spend_limit`. Only you can set it, not the
agent's own token.

A run can have a budget of its own: `spendLimit: {"usd": n}` on
`POST /v1/agents/:id/prompt` (the SDKs' `run`, `stream` and `prompt` take
`spendLimit`, `spend_limit=` in Python). The run ends the same way once it has
spent that, before its next model request; the agent's own limit is unchanged,
and still counts the run. To give each prompt what is left of a budget you keep,
send it with the prompt instead of reconfiguring the agent.
