# Custom models

Any server that speaks OpenAI Chat Completions, OpenAI Responses or Anthropic
Messages can be a provider of your own: a hosted API the catalog lacks, a model
the catalog has not caught up with yet, a gateway, or your own vLLM, Ollama or
LM Studio. You name the provider, list its models, and your agents use them
like catalog models: `<name>/<model id>`. A provider can be your account's, or
one [key scope](#in-a-key-scope)'s, for one customer's agents only.

```ts
await agents.runtime.setProvider("acme-llm", {
  type: "openai-completions",
  baseUrl: "https://llm.acme.example/v1",
  apiKey: process.env.ACME_LLM_KEY,
  models: [{ id: "acme-70b", contextWindow: 131072, maxOutputTokens: 8192, pricing: { input: 0.6, output: 0.8 } }],
});
const agent = await agents.upsert("support", { model: "acme-llm/acme-70b" });
```

In Python, `await agents.runtime.set_provider("acme-llm", base_url=..., api_key=..., models=[...])`.
Over HTTP, `PUT /v1/providers/acme-llm` with the same body.

## The provider

`PUT /v1/providers/{name}` adds a provider or replaces it:

| Field | |
| --- | --- |
| `type` | the API it speaks: `"openai-completions"`, OpenAI Chat Completions (`POST <baseUrl>/chat/completions`); `"openai-responses"`, OpenAI Responses (`POST <baseUrl>/responses`); `"anthropic-messages"`, Anthropic Messages (`POST <baseUrl>/v1/messages`). All stream |
| `baseUrl` | the API root, public and `https` (see [Where the server can be](#where-the-server-can-be)): with `/v1` for OpenAI's APIs (`https://api.example.com/v1`), without for Anthropic's (`https://api.example.com`) |
| `apiKey` | sent as `Authorization: Bearer <apiKey>` (`x-api-key` for Anthropic Messages). Leave it out when you save again to keep the stored key; `null` removes it, for a server that takes none |
| `headers` | more headers for each call, e.g. `{"api-key": "…"}` for a server that takes its key that way. Stored sealed like the key; left out keeps them, `null` removes them. The runtime sets `Authorization` itself |
| `models` | the models to use, 1 to 200 (below) |

- The name is 1 to 40 lowercase letters, digits and `-`. It can't be a built-in
  provider's (`openai`, `groq`, `openrouter` and the rest of
  `GET /v1/providers`) or one of your model endpoints'.
- The key and headers are sealed like your other keys and never shown again.
  `GET /v1/providers` lists your providers after the built-in ones: under
  `custom` their address, header names and models, and under `key` the key's
  last four characters.
- A rotated key, a new address or new headers reach agents at their next model
  call, with no reconfiguration. A model's declaration (its context window,
  pricing, `compat`) is taken when an agent takes the model: agents already on
  it take a changed declaration when configured with it again
  (`PATCH /v1/agents/:id/configuration` with `{"model": "<name>/<id>"}`).
- Deleting the provider (`DELETE /v1/providers/{name}`) fails its agents at
  their next call, until it is set again or they move to another model.
- A [key scope](models-and-keys.md#key-scopes) can have its own entry for your
  provider (`PUT /v1/key-scopes/{scope}/providers/{name}`, `{apiKey?, baseUrl?,
  headers?}`). Agents in the scope then call with that key, address or headers,
  e.g. each customer's own deployment. What the entry gives replaces the
  provider's own (its `headers` all of the provider's); what it leaves out is the
  provider's, the key included. Deleting the provider deletes its scopes' entries.

## In a key scope

A [key scope](models-and-keys.md#key-scopes) can have providers of its own, for
its agents only: each customer's own endpoint, under the same name in every
scope.

```bash
curl -X PUT https://agents.camelai.dev/v1/key-scopes/org_42/model-providers/custom \
  -H "Authorization: Bearer $CAMELAI_API_KEY" -H "Content-Type: application/json" \
  -d '{"type": "openai-responses", "baseUrl": "https://bedrock-mantle.us-west-2.api.aws/openai/v1",
       "apiKey": "'"$ORG_42_BEDROCK_API_KEY"'", "models": [{"id": "openai.gpt-5.6-terra", "contextWindow": 200000, "reasoning": true}]}'
```

An agent in `org_42` (`keyScope: "org_42"`) then names `custom/openai.gpt-5.6-terra`.

- The body, the name's rules and the limits are those of your own providers
  (above): up to 20 per scope, besides your account's 20.
- Only agents in the scope see its providers. An agent elsewhere, in another
  scope or none, that names the model gets `Unknown model`, and its calls never
  use the scope's key. In its scope, a provider shadows one of your account's
  with the same name.
- A model is resolved in the agent's scope when it is made or configured, and
  in the new scope when `PATCH /v1/agents/:id/configuration` moves it (give the
  `model` there too). Definitions name your account's providers only.
- `GET /v1/key-scopes/{scope}/model-providers` lists the scope's (never their
  key or header values), `DELETE …/model-providers/{name}` deletes one, and
  deleting the scope (`DELETE /v1/key-scopes/{scope}`) deletes them all.
  `GET /v1/models?keyScope={scope}` lists models as the scope's agents see them.

## Models

Each model is `{id, contextWindow, maxOutputTokens?, input?, reasoning?, pricing?, compat?}`:

| Field | |
| --- | --- |
| `id` | the model's id on the server, sent as `model`. Agents name it `<provider>/<id>`; an id may contain `/` and `:` |
| `contextWindow` | its context window in tokens. A long history is summarized (compacted) to keep each request within it |
| `maxOutputTokens` | the most it writes in a reply. Default 8,192, or half a smaller context window |
| `input` | `["text", "image"]` for a model that sees images: attached and read images are shown to it. Default `["text"]`: images are described in text |
| `reasoning` | `true` for a model that reasons, so `thinkingLevel` applies |
| `pricing` | `{input, output, cacheRead?, cacheWrite?}` in USD per million tokens. It is what runs cost in usage, [spend limits](models-and-keys.md#spend-limits) and webhooks. Without it, the model's runs cost 0 |
| `compat` | switches for a server that differs from OpenAI's (below) |

`GET /v1/models` lists your providers' models before the catalog's, all `available`.

A model whose id the catalog knows for the provider's API (Anthropic's models
over Anthropic Messages, OpenAI's over OpenAI's APIs: a gateway in front of
them) is called as the catalog calls it, such as which thinking settings it
takes. What you declare wins, and its price is yours (`pricing`), not the
catalog's.

### Servers that differ from OpenAI's

For Chat Completions servers. The runtime streams, sends tools as OpenAI function tools and reads tool calls
as they arrive in pieces. It copes with what many servers leave out:

- A stream without usage costs nothing and counts no tokens. Set
  `compat.supportsUsageInStreaming: false` if the server refuses
  `stream_options`.
- A server that ends its streams without `finish_reason` needs
  `compat.supportsFinishReason: false`: the reply then ends as a tool call or a
  stop by what came. Without it such a stream fails, rather than risk taking a
  reply cut off mid-way for a whole one.

Other switches, per model:

| `compat` | |
| --- | --- |
| `supportsFinishReason` | `false` for a server that ends streams without `finish_reason` |
| `maxTokensField` | `"max_tokens"` for a server that doesn't take `max_completion_tokens` |
| `supportsDeveloperRole` | `false` sends the system prompt as a `system` message, not `developer` |
| `supportsReasoningEffort` | whether the server takes `reasoning_effort` |
| `thinkingFormat` | how reasoning is asked for: `openai` (`reasoning_effort`), `openrouter`, `deepseek`, `together`, `zai`, `qwen` or `qwen-chat-template` |

## Where the server can be

The runtime calls the address you give from the public internet, through the
same [outbound guard](tools.md#outbound-calls) as MCP servers and `web_fetch`.
The address is checked when you save the provider, and again at every call:
it must be `https`, and its host must resolve to public addresses only.
Loopback, private and link-local addresses are refused, so `localhost` and your
LAN are unreachable.

A server on your own machine or network needs a public `https` address in front
of it, such as a tunnel. Keep it behind a key: anyone with the address can call
it.

A [self-hosted runtime](../operations/self-host.md#networking) can call servers
on its own network: its operator names their range in
`AGENT_OUTBOUND_ALLOW_CIDRS` (e.g. `10.1.2.0/24` for a vLLM or Ollama host), and
sets `AGENT_OUTBOUND_ALLOW_HTTP=true` if they have no TLS. That opens the range
to every agent's tools too, so keep it narrow.

## Billing

Your own providers are yours: their calls never use the platform's keys, and
their tokens are never charged to prepaid credit. Usage records what the
declared `pricing` says each run cost. That feeds spend limits, the usage
pages, and the `usage.recorded` and `run.completed` webhooks.

## Examples

### A Groq model the catalog doesn't have yet

Groq is a built-in provider: set its key (`PUT /v1/providers/groq/key`) and use
`groq/<model>` for any model in `GET /v1/models`. For one the catalog lacks,
add Groq's API under a name of your own:

```bash
curl -X PUT https://agents.camelai.dev/v1/providers/groq-preview \
  -H "Authorization: Bearer $CAMELAI_API_KEY" -H "Content-Type: application/json" \
  -d '{"type": "openai-completions", "baseUrl": "https://api.groq.com/openai/v1", "apiKey": "'"$GROQ_API_KEY"'",
       "models": [{"id": "new-model-preview", "contextWindow": 131072, "maxOutputTokens": 8192,
                   "pricing": {"input": 0.2, "output": 0.6}}]}'
```

Then name it `groq-preview/new-model-preview`.

### Ollama on your machine, through a tunnel

Ollama serves Chat Completions at `http://localhost:11434/v1`. Give it a public
`https` address with a tunnel. With a [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/),
route a hostname of yours to it (`ollama.example.com` → `http://localhost:11434`)
and put [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/identity/service-tokens/)
in front with a service token, so only calls carrying the token get through:

```ts
await agents.runtime.setProvider("home-ollama", {
  type: "openai-completions",
  baseUrl: "https://ollama.example.com/v1",
  apiKey: null,
  headers: { "CF-Access-Client-Id": process.env.ACCESS_CLIENT_ID!, "CF-Access-Client-Secret": process.env.ACCESS_CLIENT_SECRET! },
  models: [{ id: "qwen3:32b", contextWindow: 40960, reasoning: true, compat: { maxTokensField: "max_tokens" } }],
});
const agent = await agents.upsert("local-helper", { model: "home-ollama/qwen3:32b" });
```

If the tunnel's address changes, save the provider again with the new
`baseUrl`; agents follow at their next call.
