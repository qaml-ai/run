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
runs each [`js_exec` and file-parsing process](sandbox.md) as a uid of its own
under a seccomp filter with `no_new_privs`, and runs the runtime itself as `node`; that
takes only Docker's default capabilities (`SETUID`, `SETGID`). A seccomp or
AppArmor profile stricter than Docker's default can stop it: the runtime then
refuses to start (`AGENT_SANDBOX_REQUIRED=1`) rather than run code unsandboxed.

## Start it

`deploy/selfhost/` in the repository has a Compose file and an example
environment:

```sh
cd deploy/selfhost
cp .env.example .env    # fill it in; secrets: openssl rand -hex 32
for v in AGENT_OPERATOR_TOKEN AGENT_SESSION_SECRET AGENT_SECRETS_KEY POSTGRES_PASSWORD; do
  sed -i.bak "s/^$v=$/$v=$(openssl rand -hex 32)/" .env; done; rm .env.bak   # or fill the secrets this way
docker compose up -d
curl -s localhost:8790/healthz
```

The runtime listens on `127.0.0.1:8790` on the host. `AGENT_RUNTIME_PORT` and
`AGENT_RUNTIME_BIND` in `.env` change the port and the address (`0.0.0.0` for
every interface). The Compose project is `COMPOSE_PROJECT_NAME` in `.env`
(`agent-runtime`), and its volumes are named after it. To run a second copy
beside another stack of that name, give it its own name there, the same one
every time: a different name starts with empty volumes.

Then, with the operator token from `.env`:

```sh
curl -s localhost:8790/v1/me -H "Authorization: Bearer $AGENT_OPERATOR_TOKEN"
```

### Sign in to the console

The console is at `/console/` (`http://localhost:8790/console/` from the host). Without GitHub or Google
configured, sign in with an email and password, which you set with the operator token. Unless you configure
account mail (below), nobody can sign up and there is no reset by email: the operator sets, changes and clears
passwords.

```sh
read -rs PASSWORD && printf '{"email":"you@example.com","password":"%s"}' "$PASSWORD" |
  curl -s -X PUT localhost:8790/v1/tenants/selfhost/password -H "Authorization: Bearer $AGENT_OPERATOR_TOKEN" \
    -H "Content-Type: application/json" --data-binary @- ; unset PASSWORD
```

Type the password (12 to 256 characters; no `"` or `\` in this one-liner) and press Enter; `selfhost` is
`AGENT_TENANT`. Then sign in at the console with that address and password. Setting a password again
replaces it and signs out every session that signed in with the old one; `curl -X DELETE
localhost:8790/v1/tenants/selfhost/password -H "Authorization: Bearer $AGENT_OPERATOR_TOKEN"` removes it.
Signed in, you change your own password on the Account page. With several tenants, each tenant's operator
token sets its own tenant's password. To let people sign up, and reset forgotten passwords, by email, configure
account mail ([Account email](account-email.md#runbook-self-hosted)): Amazon SES, or the `log` provider, which
writes each link to `docker compose logs` for you to pass on. API and operator tokens never sign in to the console; they are for
the API. (Images up to 0.4.0, which predate passwords, sign in to the console with the operator token.)

Agents can be made before any model key is set (image `0.2.0` and later;
earlier images refuse to make one with `400 INVALID_REQUEST` until a key is
set). Their runs fail with `model_key_missing`, saying which key to set, until
one is: set `AGENT_TENANT_API_KEYS`, or `PUT /v1/providers/:provider/key` (add
`"verify": false` to store a key without checking it with the provider), or
point agents at a [fake LLM](#local-harnesses-evals-end-to-end-tests) to try
it without one.

### Point your application at it

The SDKs, the CLI and `npm create @camelai/run-app` read the runtime's URL from
`CAMELAI_BASE_URL` and the key from `CAMELAI_API_KEY`. On a self-hosted runtime
the key is the operator token (`AGENT_OPERATOR_TOKEN` in `.env`):

```sh
export CAMELAI_BASE_URL=http://localhost:8790   # http://runtime:8790 from the Compose network
export CAMELAI_API_KEY="$AGENT_OPERATOR_TOKEN"
npx -y @camelai/camelrun whoami                 # the tenant, and the default model
```

Everything in the [Quickstart](../quickstart.md) then works against it
unchanged. In code, `new Agents({ url, apiKey })` (Python `Agents(url=…,
api_key=…)`) does the same.

`AGENT_URL=http://localhost:8790 AGENT_RUNTIME_TOKEN=<token> SMOKE_PROMPT=1 node
--experimental-strip-types deploy/smoke.ts` checks the sandbox, a client tool
and a real model turn end to end.

## Upgrade

The Compose file runs a pinned release, `ghcr.io/qaml-ai/run:0.8.0`. Each
release is a version in the [release notes](release-notes.md); read the notes
of every version between yours and the new one, then set it in `.env` and
restart:

```sh
echo 'AGENT_RUNTIME_IMAGE=ghcr.io/qaml-ai/run:<version>' >> .env
docker compose up -d
```

The new container applies database migrations as it starts, and an older image
does not undo them, so back up first (below). On `docker compose
stop` the runtime lets running turns finish (up to `AGENT_DRAIN_TIMEOUT_MS`,
100 s) before it exits.

The SDKs (`@camelai/run`, `camelai-run`) are versioned apart from the runtime.
A new SDK can call API your runtime does not have yet: upgrade the runtime when
you upgrade the SDKs, or keep the SDK release from your runtime's date.

## Backup

Back up Postgres and the agents' data together (with `AGENT_STORAGE=s3`, the
bucket instead of the volume):

```sh
docker compose exec -T postgres pg_dump -U agent_runtime agent_runtime | gzip > runtime-$(date +%F).sql.gz
docker run --rm -v "${COMPOSE_PROJECT_NAME:-agent-runtime}_data:/data:ro" -v "$PWD:/out" alpine \
  tar czf "/out/data-$(date +%F).tar.gz" -C /data .
```

Restore into a stopped stack: `gunzip -c runtime-….sql.gz | docker compose exec -T
postgres psql -U agent_runtime agent_runtime` into an empty database, and the
tarball back into the `data` volume. Keep `AGENT_SECRETS_KEY` and
`AGENT_SESSION_SECRET` with the backup: stored keys cannot be read without the
first.

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
