# Self-hosting

The runtime runs on any host with Docker: one container, and Postgres. Nothing
in it needs AWS. The hosted service's ECS features (task protection, retirement
on deploys, Secrets Manager) turn on only when their settings are present.

## What you need

- Docker Engine with Compose v2, on `linux/amd64` or `linux/arm64`.
- 1 vCPU and 2 GB of memory for the runtime is enough for tens of agents awake
  at once; agents asleep cost only storage. Postgres 14 or later (the example
  runs 16).
- Outbound HTTPS to your model providers.
- Nothing public: your application reaches it on a private network, and
  browsers through your application (see [Networking](#networking)). A reverse
  proxy that terminates TLS only if other hosts or browsers reach it directly.

The image is `ghcr.io/qaml-ai/run:<version>`. It needs no extra
privileges: no `--privileged`, no added capabilities, no Docker socket, no
gVisor. Its entrypoint, `agent-launcher`, starts as root inside the container,
runs each [sandbox process](sandbox.md) for `js_exec` as its own uid under a
seccomp filter with `no_new_privs`, and runs the runtime itself as `node`; that
takes only Docker's default capabilities (`SETUID`, `SETGID`). A seccomp or
AppArmor profile stricter than Docker's default can stop it: the runtime then
refuses to start (`AGENT_SANDBOX_REQUIRED=1`) rather than run code unsandboxed.

## Start it

`deploy/selfhost/` in the repository has a Compose file and an example
environment:

```sh
cd deploy/selfhost
cp .env.example .env    # fill it in; secrets: openssl rand -hex 32
docker compose up -d
curl -s localhost:8790/healthz
```

Then, with the operator token from `.env`:

```sh
curl -s localhost:8790/v1/me -H "Authorization: Bearer $AGENT_OPERATOR_TOKEN"
```

Agents can be made before any model key is set, but their runs fail until one
is: set `AGENT_TENANT_API_KEYS`, or `PUT /v1/providers/:provider/key` (or point
agents at a [fake LLM](#local-harnesses-evals-end-to-end-tests) to try it
without one).

`AGENT_URL=http://localhost:8790 AGENT_RUNTIME_TOKEN=<token> SMOKE_PROMPT=1 node
--experimental-strip-types deploy/smoke.ts` checks the sandbox, a client tool
and a real model turn end to end.

Upgrade by changing `AGENT_RUNTIME_IMAGE` (or pulling `latest`) and `docker
compose up -d`: the new container applies database migrations as it starts. On
`docker compose stop` the runtime lets running turns finish (up to
`AGENT_DRAIN_TIMEOUT_MS`, 100 s) before it exits.

## Configuration

Everything in `.env` reaches the runtime; [Configuration](configuration.md) has
every setting. The ones a self-hosted runtime needs:

| Variable | |
| --- | --- |
| `AGENT_TENANT`, `AGENT_OPERATOR_TOKEN` | the one tenant it serves and that tenant's operator token (at least 24 characters): what your application sends as `Authorization: Bearer`. For several tenants, give the whole [tenants file](configuration.md) instead, as `AGENT_TENANTS_JSON` or a mounted `AGENT_TENANTS_FILE` |
| `AGENT_TENANT_API_KEYS` | the tenant's provider keys as JSON, `{"anthropic": "sk-ant-...", "openrouter": "sk-or-..."}`. Optional: keys can be stored later with `PUT /v1/providers/:provider/key` (encrypted with `AGENT_SECRETS_KEY`), or per key scope |
| `AGENT_SESSION_SECRET`, `AGENT_SECRETS_KEY` | 32 random bytes each, hex. Keep them: changing the first invalidates agents' tokens and signed links, and the second makes stored keys unreadable |
| `AGENT_PUBLIC_URL` | the URL your application and tool servers reach the runtime at (`http://runtime:8790` on the Compose network): signed links and identity tokens name it |
| `AGENT_BROWSER_URL` | where browsers reach it, as browser tokens say; `AGENT_PUBLIC_URL` unless set, and empty for none, when browsers read through your application |
| `AGENT_DATABASE_URL` | Postgres (the Compose file sets it for its own) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | optional, for console sign-in with Google (with `AGENT_OPEN_SIGNUP=true`; see [Configuration](configuration.md)). Off unless both are set |
| `AGENT_PROVIDER`, `AGENT_MODEL` | the default model for agents that name none (default Claude Sonnet 5.5 on Anthropic, then on OpenRouter and Bedrock, whichever the tenant has a key for) |

## Storage

By default the agents' data (transcripts, files, volumes) is on the `data`
volume (`AGENT_STORAGE=file`), and indexes are in Postgres. Back up both.

For S3, or a service that speaks it, set `AGENT_STORAGE=s3`, `AGENT_S3_BUCKET`,
`AWS_REGION` and credentials (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`), and
for anything but AWS `AGENT_S3_ENDPOINT` (and `AGENT_S3_FORCE_PATH_STYLE=true` where
the service wants path-style requests). The service must support conditional
writes (`If-None-Match: *`): AWS S3, Cloudflare R2, SeaweedFS and RustFS do.
`docker compose --profile s3 up -d` runs SeaweedFS alongside, with the bucket
made for you; `.env.example` has the lines to set.

## Networking

The runtime can stay private, reachable only by your application: leave out
the Compose file's `ports`, put your application on the same Docker network,
and have it call `http://runtime:8790`. Browsers then read agents through your
application ([read-proxy mode](../frontend.md), `createAgentHandler({ proxy:
true })`, or your own route passing `/v1/agents/:id/{events,history,state,inputs}`
on with a browser token), never from the runtime. Set:

- `AGENT_PUBLIC_URL=http://runtime:8790`: the runtime's own address as your
  application and tool servers reach it (identity tokens name it, and signed
  file links point at it).
- `AGENT_BROWSER_URL=` (empty): browser tokens then name no URL. A link's
  `urlPath` is its path on the runtime, for a proxy to serve at its own origin;
  `createAgentHandler` in proxy mode does, under its route.

To let browsers reach the runtime directly instead, route its hostname (or a
path prefix) through your proxy to port 8790, and set `AGENT_PUBLIC_URL` to that
URL. Browser tokens' reads (`/v1/agents/:id/{events,history,state,inputs}`)
allow any origin; keep single sign-on in front of the runtime off those routes,
since the browser token is their credential.

The runtime refuses to call private and loopback addresses (MCP servers,
`web_fetch`, tenants' model endpoints), so an agent cannot reach your network.
Your own services it must call (your application's tool server, a model server
or gateway) are allowed by their exact origins:
`AGENT_OUTBOUND_ALLOW_ORIGINS=http://app:3000,http://10.1.2.3:8000`. Each is
reachable at that scheme, host and port only, over `http` too, and nothing else
on the host is (another port, such as an admin API, stays refused). MCP servers,
HTTP tools, model providers, key scopes' `baseUrl`s and webhooks may use them;
`web_fetch`, `web_search` and page renders never do, since the model chooses
their URLs.

`AGENT_OUTBOUND_ALLOW_CIDRS` (with `AGENT_OUTBOUND_ALLOW_HTTP=true` for plain
`http`) opens whole ranges instead, `web_fetch` included, to every port: use it
for a test harness, not to reach your application.

## Local harnesses (evals, end-to-end tests)

For a harness on your machine, `compose.dev.yml` lets agents call servers on it
and on Docker's private networks over plain `http`: a fake LLM, an MCP server,
a page for `web_fetch`. Never use it in production.

```sh
docker compose -f docker-compose.yml -f compose.dev.yml up -d
```

It sets `AGENT_OUTBOUND_ALLOW_HTTP=true` and allows loopback and the private
ranges (`AGENT_DEV_ALLOW_CIDRS` narrows them), and makes `host.docker.internal`
this machine on Linux too. From inside the container, a server on your machine at
port 9999 is `http://host.docker.internal:9999`; one in another Compose service is
`http://<service>:<port>`.

A fake LLM is a [custom provider](../guides/custom-models.md): any server that
answers OpenAI Chat Completions, streaming. This one replies with the last user
message, reversed:

```js
// fake-llm.mjs: node fake-llm.mjs
import { createServer } from "node:http";
createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const { messages } = JSON.parse(body);
  const last = messages.findLast(m => m.role === "user")?.content ?? "";
  const said = typeof last === "string" ? last : last.map(part => part.text ?? "").join("");
  const text = [...said].reverse().join("");
  const chunk = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  chunk({ role: "assistant", content: text });
  chunk({}, "stop");
  res.end("data: [DONE]\n\n");
}).listen(9999);
```

```sh
curl -X PUT localhost:8790/v1/providers/fake -H "Authorization: Bearer $AGENT_OPERATOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"type": "openai-completions", "baseUrl": "http://host.docker.internal:9999/v1", "apiKey": null,
       "models": [{"id": "echo", "contextWindow": 32768}]}'
```

Agents that name `fake/echo` then call it, at no cost. To script tool calls,
answer with `tool_calls` deltas as OpenAI does; the runtime's own tests
(`tests/runtime-server.ts`, `fakeModel`) have a fuller fake.

## More than one node

One node is the default and needs nothing more. Several nodes share Postgres
and S3 storage (`AGENT_STORAGE=s3`), each with `AGENT_NODE_URL`, the address its
peers reach it at; a load balancer in front sends each request to any node, and
nodes forward to the one serving an agent. See
[Architecture](architecture.md).
