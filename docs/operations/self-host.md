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

The image is `ghcr.io/qaml-ai/agent-runtime:<version>`. It needs no extra
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
A model server or gateway on your network is allowed by naming its range,
`AGENT_OUTBOUND_ALLOW_CIDRS=10.1.2.0/24`, and, if it has no TLS,
`AGENT_OUTBOUND_ALLOW_HTTP=true`; both open that range to every agent's tools
too, so keep it narrow. Tool servers your application runs on the same Docker
network are such an address too.

## More than one node

One node is the default and needs nothing more. Several nodes share Postgres
and S3 storage (`AGENT_STORAGE=s3`), each with `AGENT_NODE_URL`, the address its
peers reach it at; a load balancer in front sends each request to any node, and
nodes forward to the one serving an agent. See
[Architecture](architecture.md).
