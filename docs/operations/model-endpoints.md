# Model endpoints

A tenant can have its agents' model calls go through its own pass-through
gateway, e.g. a proxy that checks credit per call, swaps in the real provider
key (its customers' own, a subscription) and meters usage, the way Cloudflare's
AI Gateway does. The runtime speaks each provider's native protocol to it, so
nothing is translated: the gateway forwards the bytes as they are. Its entry in
the tenants file names the endpoint as a provider:

```json
"acme": {"tokenSha256": "…", "modelEndpoints": {"gateway": {
  "baseUrl": "https://gateway.acme.example/llm",
  "models": {"openrouter/deepseek/deepseek-v4:free": {"contextWindow": 128000, "maxTokens": 8192, "reasoning": true, "input": ["text"]}}
}}}
```

- Agents name its models as `<name>/<provider>/<model id>`, e.g.
  `"gateway/anthropic/claude-opus-5"` or
  `"gateway/openrouter/anthropic/claude-sonnet-5:nitro"`, at creation, in a
  definition or through `PATCH /v1/agents/:id/configuration`. Bedrock models also
  name their region: `"gateway/amazon-bedrock/us-west-2/us.anthropic.claude-sonnet-5"`.
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
  `"gateway/openai-codex/gpt-5.5"`: the tenant replaces `Authorization` with
  the user's ChatGPT access token and sets the real `chatgpt-account-id`. Its
  requests are stateless too, and also carry `originator`, `OpenAI-Beta`, and,
  in a turn, `session-id` and `x-client-request-id` (the agent's id), which the
  backend takes as they are.
- Every call also carries the token as `X-Agent-Runtime-Identity`. This is the
  EdDSA JWT that MCP servers with `auth: {"type": "runtime"}` get (see
  [Identity tokens](../guides/tools.md#identity-who-a-call-is-for)). Its `aud` is the
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
