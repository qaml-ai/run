# Tools

For native Linux computers and remote browsers, see [Computers](computers.md).

An agent's tools are how it acts. This guide covers where they run, how to write
them so a retry never does harm, and how the runtime tells a tool who a call is
for. For the short version of where tools should run, see the table in
[Concepts](../concepts.md#tools-where-they-run).

## Writing a tool

```ts
import { schema, tool } from "@camelai/run";

const refund = tool({
  description: "Refund an order in full",
  input: schema.Object({ orderId: schema.String() }),
  timeoutMs: 60_000,
  execute: async ({ orderId }, context) => {
    context.progress("Contacting the payment provider");
    return payments.refund(orderId, { idempotencyKey: context.idempotencyKey, signal: context.signal });
  },
});
```

```python
from camelai_run import ToolContext, tool

@tool(timeout=60)
async def refund(order_id: str, context: ToolContext) -> dict:
    """Refund an order in full"""
    context.progress("Contacting the payment provider")
    return await payments.refund(order_id, idempotency_key=context.idempotency_key)
```

- **Input.** TypeScript takes a [TypeBox](https://github.com/sinclairzx81/typebox)
  schema (`schema` is TypeBox's `Type`), and infers the arguments' type from it.
  Python derives the schema from the annotations (`str`, `int`, `float`, `bool`,
  `list`, `dict`) and the description from the docstring. Arguments are checked
  against the schema before your function runs.
- **Result.** Return any JSON value; `undefined`/`None` is sent as `null`. The
  model reads it as JSON text, and code in `js_exec` gets the value. Throw (raise)
  to tell the model the call failed: it sees your message. A result is at most
  1 MiB of JSON. The model reads at most 32,000 characters of a tool's result;
  a longer one is saved whole (up to 700 KB) to
  `/workspace/tool-results/<toolCallId>.txt`, where it can read the rest.
- **Python functions** may be `async` or plain; a plain one runs in a thread, so
  it never blocks the connection.
- **`context.idempotencyKey`** is the same for every attempt of one call: a
  retry after a lost connection, or the call run again once a person answered.
  Pass it to anything with side effects. `context.callId` is new on each attempt.
- **Deadline.** A call may go 15 seconds without answering (`timeoutMs`,
  `@tool(timeout=)`: 1 s to 20 minutes). Each `context.progress(...)` restarts the
  wait, up to 20 minutes in all, and people watching the agent see the progress.
  A call cut off is reported to the model as "outcome unknown" (it may still
  finish in your process): make the side effect idempotent and the model can
  check and retry safely.
- **`context.signal`** aborts when the runtime cancels the call (the run was
  aborted, or the deadline passed). Cancellation is not rollback.
- **`context.identity`** says who the call is for; see [Identity](#identity-who-a-call-is-for).
- **`needsApproval: true`** (`needs_approval=True`) makes a person approve each
  call first, and `context.confirm/ask/requireUrl` ask from inside the tool; see
  [Human input](human-input.md).
- **`exposure`** (`@tool(exposure=...)` in Python): `"direct"` (the model calls
  it as a tool), `"codemode"` (only from code in `js_exec`, as
  `tools.<name>(args)`), or `"both"`. By default a source of up to 10 tools is
  `both` and a larger one `codemode`, so big catalogs do not crowd the model's
  context. **So by default the model can call your tools from `js_exec`**, your
  attached and served tools included, and it may well batch them in code. See
  [Keeping tools out of js_exec](#keeping-tools-out-of-js_exec).

### Keeping tools out of js_exec

Code the model writes in `js_exec` can call every tool whose exposure is
`codemode` or `both`. That is what makes large catalogs cheap (the model loops,
filters and calls several tools in one step), but it also means a tool your app
expected to see called on its own may be called from code instead: its call is
then inside `js_exec`'s, its arguments do not stream as `toolcall_delta` events,
and a page that renders a tool's arguments as they are written sees nothing
until the code has run.

To keep a tool out of `js_exec`, make it `direct`:

| Where the tool comes from | Set |
|---|---|
| Your process (`tools` in `upsert`) | `exposure: "direct"` on the tool; Python `@tool(exposure="direct")` |
| A served or MCP server named in a definition | `"exposure": "direct"` on the server entry (every tool), or `_meta["agent-runtime/exposure"]` on a tool in its `tools/list` (that tool; it beats the server's) |
| An OpenAPI source | `"exposure": "direct"` on the source |

A tool with `needsApproval` is always direct. The console's agent page shows each
tool's exposure (**Tools the model gets**), and `GET /v1/agents/:id` its
`toolSources`. `js_exec` itself stays: it still runs code, with `fs` and
`fetch`, and the tools left in it.

## Attached tools: in your process

Pass `tools` to `upsert` and this process serves them to the agent:

For native Linux computers and remote browsers, use [Computers](computers.md).
The [computer example](../../examples/computer/README.md) remains available if
you want to run an attached adapter in your own process instead.

```ts
const agent = await agents.upsert("ops", { model, instructions, tools: { refund } });
```

The SDK holds the agent's event stream; the runtime sends each tool call over it
and the SDK posts the result back. Your tools run with your process's state and
credentials, and nothing is exposed on the network. The trade-offs:

- One process at a time serves an agent's tools. Another process that upserts
  with the same tools gets `APPLICATION_CONNECTED` (pass `takeover: true` to
  replace the first, or `attach: false` to run the agent without serving them).
- A run while no process serves the tools is refused with
  `APPLICATION_NOT_CONNECTED`, unless you pass `allowDisconnected: true`
  (`allow_disconnected=True`): then calls to them fail, listed in the run's
  `toolErrors` with code `not_connected`. Runs a schedule or a channel starts are
  never refused and may find nobody connected: use served tools for those agents.
- If the connection drops while a call runs, its outcome is unknown to the
  runtime, and the model is told so; the call is never sent again.

An existing MCP server (from `@modelcontextprotocol/sdk`) can be attached as is:
`upsert(key, { mcp: await fromMcpServer(server) })` from
`@camelai/run/mcp`.

### Several processes, workers and deploys

Every process that upserts an agent with `tools` tries to serve them, and only
one can. Under uvicorn or gunicorn with several workers, Celery, or any fleet of
instances, the first to connect serves the tools and the others fail with
`APPLICATION_CONNECTED` (or take them from each other, with `takeover`).

Pick one of these:

- **Served tools (recommended for fleets).** Serve the tools over HTTP from your
  web app (`serveTools` / `serve_tools`, below) and name the server in a
  definition. Every process, web worker and task then upserts the agent from
  the definition with no `tools`, and any of them can run it. Each call is an
  HTTP request of its own to whichever instance is up, so a rolling deploy that
  drains its connections loses no call.
- **One tool process.** Run one long-lived process that upserts the agent with
  its `tools`. Everywhere else, upsert it with the same `tools` and
  `attach: false` (`attach=False`), which runs the agent without serving them.

#### Deploying a tool process

Close the agents when the process is told to stop, and a deploy loses no call:

```ts
process.once("SIGTERM", () => void agents.close().then(() => process.exit(0)));
```

```python
from contextlib import asynccontextmanager
from fastapi import FastAPI

@asynccontextmanager
async def lifespan(app):
    yield
    await agents.close()  # uvicorn runs this on SIGTERM

app = FastAPI(lifespan=lifespan)
```

`close()` tells the runtime this process takes no new calls, finishes the
calls it is running (for up to 25 seconds: `close({ drainMs })`,
`close(drain=)` in seconds), then disconnects. Meanwhile new calls go to the
next process: in a rolling deploy, start it with `takeover: true`
(`takeover=True`), which takes the tools at once while the old process
finishes its calls; in a stop-then-start deploy, it connects without a
takeover, since a closing process holds the tools no longer, and calls wait a
few seconds for it. A takeover alone (without `close()`) also lets the
replaced process answer the calls it has, for up to 30 seconds.

What a deploy can still lose: a call that outlives the drain, and every call
running when a process crashes or is killed without `close()`. The model is then
told, in words it can pass on, that the tool's server disconnected during the
call and it may or may not have taken effect; the run lists it in `toolErrors`
(Python `tool_errors`) with code `connection_lost`. Key side effects by
`context.idempotencyKey` so that checking and retrying is safe.

#### When the tool process dies mid-run

The run lives in the runtime, not in your process, so it goes on without it:

- **The call that was running** fails as `connection_lost`, as above. The model
  is told, and usually checks or tries again.
- **A call while no process serves the tools** waits 3 seconds for one to
  connect, then fails as `not_connected` (it did not run).
- **The restarted process serves the run's next calls.** Once it upserts the
  agent with its `tools`, it serves every call that comes, including calls of
  runs a process before it started. A run is not tied to the process that sent it.
- **The `run()` the dead process awaited is gone, but its run is not.** Give each
  run an id of yours (`idempotencyKey`), saved before you send it, e.g. the job
  or the order it is for. After the restart, `run()` with the same text and the
  same key answers with that run instead of starting another: its result if it
  has ended, or once it ends if not. Without an SDK, `GET
  /v1/agents/:id/requests/<key>?wait=25` answers the same, and `GET
  /v1/agents/:id/state` lists the agent's runs.

Check `toolErrors` even when the run's `status` is `completed`: a run whose
call was cut off often ends normally, after the model worked around it.

```ts
// On startup (and after a crash): serve the tools, then collect the job's run.
const agent = await agents.upsert("ops", { model, instructions, tools: { refund } });
const run = await agent.run(`Refund order ${job.orderId}`, { idempotencyKey: job.id });
const lost = run.toolErrors.filter(error => error.code === "connection_lost");
if (lost.length) console.warn(`check whether ${lost.map(error => error.tool).join(", ")} took effect`);
console.log(run.status, run.text, run.toolCalls.map(call => call.tool));
```

```python
# On startup (and after a crash): serve the tools, then collect the job's run.
agent = await agents.upsert("ops", model=model, instructions=instructions, tools=[refund])
run = await agent.run(f"Refund order {job.order_id}", idempotency_key=job.id)
lost = [error for error in run.tool_errors if error["code"] == "connection_lost"]
if lost:
    print("check whether", ", ".join(error["tool"] for error in lost), "took effect")
print(run.status, run.text, [call["tool"] for call in run.tool_calls])
```
## Served tools: over HTTP, for serverless and many users

A server of yours answers tool calls over HTTP (MCP's Streamable HTTP), and a
definition tells the runtime to call it. Any number of instances can serve,
nothing needs to stay connected, and the runtime signs a token for each call
saying which agent it is for, whom that agent acts for, and who is acting.

```ts
import { serveTools } from "@camelai/run/server";

// A fetch handler: Cloudflare Workers, Bun and Deno serve it as is.
// tenant: your tenant's id (GET /v1/me, or `await agents.runtime.me()`): tokens for other tenants' agents are refused.
export default { fetch: serveTools({ refund }, { runtime: "https://run.camelai.com", tenant: "acme" }) };
```

On Node, wrap it: `createServer(nodeListener(handler, { origin: "https://tools.example.com" }))`
with `nodeListener` from `@camelai/run/node`. Tokens are checked
against the URL the runtime called, so set `origin` to your public URL. Without
it, the URL is the server's own (its socket's scheme and the Host header), which
is wrong behind a load balancer or proxy that ends TLS. `trustProxy: true` reads
`X-Forwarded-Proto` and `X-Forwarded-Host` instead, but only set it where the
proxy overwrites those headers: otherwise any client could choose the URL tokens
are checked against.

```python
from camelai_run import serve_tools

app = serve_tools([refund], runtime="https://run.camelai.com", tenant="acme")  # ASGI: uvicorn, or mount in FastAPI
```

Behind a proxy, run uvicorn with `--proxy-headers` (and `--forwarded-allow-ips`
naming the proxy), or pass `audience="https://tools.example.com/mcp"`.

To offer each agent its own tools (an admin's, a plan's), pass a function of the
caller's identity instead of the tools; a tool it is not given is refused if
called. A `ToolServer` of your own gets the same as `listTools(context)`:
`{identity, origin, signal}`.

```ts
serveTools(identity => identity.context.role === "admin" ? { refund, ban } : { refund }, options);
```

```python
serve_tools(lambda identity: [refund, ban] if identity.context.get("role") == "admin" else [refund], runtime=..., tenant=...)
```

### A server that moves

By default a token's audience is the server's URL, so a server that moves (a new
domain or path) refuses the tokens of agents still calling the old URL. Two ways
to move without that:

- Give the server a name that does not change: `audience:
  "urn:camelrun:<tenant>:<name>"` in the definition's server entry (your tenant's
  id, as `GET /v1/me` shows it, then a name of letters, digits and `._~:-`), and
  the same `audience` to `serveTools`. Tokens name it wherever the server is. Only
  your tenant's sources can name an audience in your tenant's namespace.
- Accept both addresses while agents move: `audience` takes a list, e.g.
  `["https://old.example.com/mcp", "https://new.example.com/mcp"]`.

Agents keep the definition revision they were made from, so after changing the
server's `url`, apply the new revision to them (`apply: "all"`, or
`applyOnUpdate: true` on the definition; see [Definitions](definitions.md)).

```ts
// Definition: { name: "shop", url: "https://tools.example.com/mcp", auth: { type: "runtime" }, audience: "urn:camelrun:acme:shop" }
export default { fetch: serveTools({ refund }, { runtime: "https://run.camelai.com", tenant: "acme", audience: "urn:camelrun:acme:shop" }) };
```

For Django, Flask or any WSGI server, `camelai_run.sync.serve_tools` takes the
same arguments and is a WSGI app. Plain functions run in the request's thread,
with its database connection; async ones run in an event loop of the request's
own. Mount it at the path the definition names:

```python
# Flask
from werkzeug.middleware.dispatcher import DispatcherMiddleware
from camelai_run.sync import serve_tools

app.wsgi_app = DispatcherMiddleware(app.wsgi_app, {"/mcp": serve_tools([refund], runtime="https://run.camelai.com", tenant="acme")})
```

```python
# Django: wsgi.py
from django.core.wsgi import get_wsgi_application
from camelai_run.sync import serve_tools

django_app = get_wsgi_application()
tools_app = serve_tools([refund], runtime="https://run.camelai.com", tenant="acme")

def application(environ, start_response):
    path = environ.get("PATH_INFO", "")
    if path == "/mcp" or path.startswith("/.well-known/oauth-protected-resource"):
        return tools_app(environ, start_response)
    return django_app(environ, start_response)
```

Behind a proxy, pass `audience="https://tools.example.com/mcp"`: the URL a WSGI
app sees is the server's own. `camelai_run.sync.verify_runtime_token` checks a token in a view
of your own.

(`pip install "camelai-run[server]"` for the token checks.)

Then name the server in a definition, and make agents from it:

```ts
const definition = await agents.runtime.upsertDefinition("support", {
  name: "Support",
  mcpServers: [{ name: "shop", url: "https://tools.example.com/mcp", auth: { type: "runtime" } }],
});
const agent = await agents.upsert(`user-${user.id}`, { definition: definition.id, subject: user.id, context: { org: user.orgId } });
```

Every request without a valid token for your server gets a 401: the signature
(the runtime's published Ed25519 keys), the issuer, the **tenant** (yours), the
audience (your server's URL as the runtime calls it) and the expiry are checked,
and nothing per user is stored anywhere.

`tenant` is required, and it matters: an identity means something only within
your own tenant. Any tenant can make agents, give them any `subject` and
`context`, and point them at your server's URL; the runtime signs their tokens
too. Only the tenant check tells your agents from theirs. Pass your tenant's id
(or a list, if several of your tenants share the server). To test your authorization without a runtime,
`testRuntime()` (`@camelai/run/testing`; `TestRuntime()` in Python, and
`camelai_run.sync.TestRuntime()` for a WSGI app) signs tokens with a key of its own:

```ts
const rt = await testRuntime();
const result = await rt.callTool(serveTools(tools, rt.options), "https://app.test/mcp", "refund", { orderId: "o1" }, { subject: "alice" });
```

Built with the MCP SDK or Cloudflare's `createMcpHandler` instead? Verify with
`runtimeAuth(request, { runtime, tenant })`, pass the result as the request's `auth`, and
read `runtimeIdentity(extra)` in a handler. `verifyRuntimeToken(token, { runtime,
tenant, audience })` checks a token on its own. `testRuntime()`'s tokens name
tenant `test`, which `rt.options` passes.

## Identity: who a call is for

Every tool call carries `context.identity`, from the signed token for served
tools and from the call itself for attached ones, so a tool reads it the same way
either way:

| field | |
| --- | --- |
| `user` | whom to authorize as: the turn's actor, else the agent's subject |
| `subject` | whom the agent acts for: `subject` given when it was made (its id if none) |
| `actor` | who is acting in this turn: the run's `user` (`from.id`), or an `actor` given with the message |
| `context` | claims given when the agent was made (`context: { org, workspace }`) |
| `tenant`, `agent`, `definition` | whose agent it is, and which (`definition` only for an agent made from one) |
| `origin` | where the turn came from: a channel, its conversation and sender |
| `approval` | the person's approval, for a call that needed one |

`subject` and `context` are set with your API key when the agent is made, and the
agent's own token cannot change them; the model cannot touch any of it. So,
once the token is checked to be from your own tenant (served tools), a tool can
trust `identity`, and should never take a user id from the model's arguments.
Another tenant's agents can claim any `subject`: `identity` is only meaningful
within your tenant. See [Many users](multi-user.md).

The token itself (for servers that verify it by hand, e.g. with `jose`):

```json
{ "iss": "https://agents.camelai.dev", "aud": "https://tools.example.com/mcp",
  "sub": "u_123", "tenant": "acme", "agent": "client_…", "definition": "def_…",
  "ctx": { "org": "acme" }, "act": "u_456", "origin": { … }, "req": "run_…", "tcid": "toolu_…",
  "par": "client_…", "root": "client_…", "iat": 1790000000, "exp": 1790000120, "jti": "…" }
```

```ts
const jwks = createRemoteJWKSet(new URL("https://run.camelai.com/.well-known/jwks.json"));
const { payload } = await jwtVerify(token, jwks, { issuer: "https://agents.camelai.dev", audience: "https://tools.example.com/mcp", algorithms: ["EdDSA"] });
// Any tenant's agent can get a token for your server's URL: accept only your own tenant's.
if (payload.tenant !== "acme") throw new Error("Not our tenant's agent");
```

- `tenant` must be your own (your tenant id, as `GET /v1/me` shows it): the
  signature, issuer and audience prove only that the runtime issued the token
  to some agent for your server's URL, and anyone can make an agent.
- `iss` is the hosted runtime's first address, `https://agents.camelai.dev`,
  at either of its URLs (a self-hosted runtime's is its `AGENT_ISSUER`, else its
  `AGENT_PUBLIC_URL`). The SDKs expect it for either hosted URL.
- `aud` is the server's URL, or the source's `audience`: another URL on the
  server's origin, or a name in your tenant's namespace,
  `urn:camelrun:<tenant>:<name>` (see [A server that moves](#a-server-that-moves)).
  The runtime mints no token for another origin's URL or another tenant's name,
  so a token cannot be replayed against a server that is not yours.
  Tokens live two minutes, and each request gets its own `jti`.
- `act` and `origin` are absent outside a turn (listing a server's tools as an
  agent starts), and so are `req`, the run's request id, and `tcid`, the model's
  tool call (`identity.requestId` and `toolCallId` in the SDKs).
- `par` and `root` are set only in a [sub-agent](multi-agent.md)'s run: the agent
  that started it and the first agent of its chain, from the run's chain as
  the runtime signed it (`identity.parentAgentId` and `rootAgentId` in the SDKs).
  Authorize a sub-agent's call by `root` when only the first agent's user is yours.
- The keys are at `/.well-known/jwks.json` (cache them for minutes);
  `/.well-known/oauth-authorization-server` names the issuer for MCP clients.

## Definitions' sources

A [definition](definitions.md) lists tool sources the runtime calls itself. An
agent without a definition can also have [MCP servers of its
own](#an-agents-own-mcp-servers), without credentials.

### MCP servers

```json
{"name": "Support", "mcpServers": [{
  "name": "kb", "url": "https://mcp.example.com/mcp",
  "auth": {"type": "bearer", "token": "…"}, "headers": {"X-Team": "support"},
  "allowTools": ["search", "fetch_article"], "exposure": "both", "timeoutMs": 30000
}]}
```

- Streamable HTTP, falling back to the older SSE transport when a server answers
  its POST with 400, 404 or 405.
- `auth` is `{"type": "bearer", "token"}`, `{"type": "runtime"}` (signed
  identity tokens, above) or `{"type": "exchange", "url"}` (a short-lived
  credential the runtime fetches from an endpoint of yours; see [Fetched
  credentials](#fetched-credentials-auth-exchange)). `headers` and a bearer
  token are stored sealed; the API returns only `headerNames` and `auth`
  without a token. Updating a server without them keeps its stored
  credentials, unless its URL moved to another origin.
- `fileArguments` (`"on"` or `"off"`) says whether its tools are sent the
  agent's files: on by default with `auth: {"type": "runtime"}` only. See
  [Files in tool calls](#files-in-tool-calls).
- Tools reach the model as `<server>__<tool>`, filtered by `allowTools` and
  `denyTools`. A server can set a tool's own exposure in `tools/list` with
  `_meta["agent-runtime/exposure"]`, and its deadline with
  `_meta["agent-runtime/timeoutMs"]`.
- Each call has a deadline (`timeoutMs`, default 60 s, at most 20 minutes). It
  limits silence: each progress notification restarts it, up to 20 minutes in
  all. A call from `js_exec` also ends with its execution (60 s at most), so
  expose long tools directly.
- Text reaches the model as it is; images, audio, blobs and text resources over
  64 KiB are saved to the agent's workspace and reach it as files. `isError`
  becomes a tool error; `structuredContent` is what code gets.
- The runtime lists each server when you save the definition: one that refuses
  its credentials (or whose credential exchange does) is a 400 saying so, and the answer's `toolSources` shows what
  each server offers (`status: listed`, or `error` with why). A server that
  cannot be reached when an agent starts contributes no tools that run; the
  run's `sourceErrors` lists it.
- Tool lists are cached for five minutes and dropped on
  `notifications/tools/list_changed`; a running agent takes a changed list at its
  next start.
- Progress a server reports for a call (`notifications/progress`) reaches the
  agent's events as a `tool_execution_update`, at most one per call every 250 ms.

Each call carries `_meta` for the server: `agent-runtime/idempotencyKey` (stable
across attempts), `agent-runtime/callId`, `agent-runtime/toolCallId` (and
`agent-runtime/innerCallId` for a call from code), `agent-runtime/actor`,
`agent-runtime/origin`, and `camelrun/files` when files are sent.

### Fetched credentials: `auth: exchange`

A bearer token in a definition is a fixed string, so it has to live as long as
the definition does. The credentials worth using do not: a GitHub App
installation token lasts an hour, and so do cloud STS tokens and most OAuth
access tokens. With `auth: {"type": "exchange"}` the runtime fetches the
server's credential from an endpoint of yours when it needs one, and fetches
another before that one expires. Nothing long-lived is stored anywhere but in
your own service.

```json
{"name": "Triage", "mcpServers": [{
  "name": "github", "url": "https://mcp.example.com/github",
  "auth": {"type": "exchange", "url": "https://app.example.com/camelrun/github-token"}
}]}
```

When the runtime is about to call the server and has no fresh credential for
the agent, it asks your endpoint:

```http
POST /camelrun/github-token
Authorization: Bearer <an identity token the runtime signs>
Content-Type: application/json

{"server": {"name": "github", "url": "https://mcp.example.com/github"},
 "tenant": "acme", "definition": "def_…", "agent": "client_…"}
```

and your endpoint answers with the credential and when it expires:

```json
{"token": "ghs_…", "expiresAt": "2026-10-13T19:00:00Z"}
```

`expiresAt` is an RFC 3339 time; `{"token": "…", "expiresIn": 3600}` (seconds)
works too. One of the two is required. The runtime then calls the server with
`Authorization: Bearer <token>`, plus the entry's static `headers`.

The identity token is the one a [served tool](#identity-who-a-call-is-for)
gets, with three differences:

```json
{ "iss": "https://agents.camelai.dev", "aud": "https://app.example.com/camelrun/github-token",
  "sub": "u_123", "tenant": "acme", "agent": "client_…", "definition": "def_…", "ctx": { "org": "acme" },
  "exchange": { "server": "github", "url": "https://mcp.example.com/github" },
  "iat": 1790000000, "exp": 1790000120, "jti": "…" }
```

- `aud` is your endpoint's URL, as the definition stores it (`GET
  /v1/definitions/:id` shows it), or `auth.audience` if you give one: a URL on
  the endpoint's origin, or `urn:camelrun:<tenant>:<name>`. It is never the
  tool server's audience: the tool server gets the credential and no identity
  token, so a token for one cannot be used at the other.
- `exchange` names the tool server the credential is for. Only requests for a
  credential carry it; no tool call's token does. Decide by it, not by the
  body, which repeats it for convenience.
- There is no `act`, `origin`, `req` or `tcid`: a credential is kept across
  turns and serves everyone who talks to the agent, so its request names the
  agent and whom it acts for (`sub`, `ctx`), not one turn.

Your endpoint must check, in this order: the signature against
`/.well-known/jwks.json` (EdDSA), the issuer and expiry; that `aud` is its
own; that **`tenant` is yours** (anyone can make a tenant and point an
exchange at your URL: this is the check that keeps them out); and that
`exchange` is present and names a server you issue for. Then authorize the
`agent`, `definition`, `sub` and `ctx` as you see fit and answer the narrowest
credential that does the job. To refuse, answer a 4xx with `{"error": "why"}`:
the first 200 characters of `error` reach the tool error.

#### A GitHub App

A GitHub App's private key never leaves your service; the agent gets an
installation token that lasts an hour and reaches only the repositories and
permissions you choose for it.

```ts
import { verifyRuntimeToken } from "@camelai/run/server";
import { SignJWT, importPKCS8 } from "jose";

const AUDIENCE = "https://app.example.com/camelrun/github-token";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const refuse = (status: number, error: string) => Response.json({ error }, { status });
    if (request.method !== "POST") return refuse(405, "POST only");
    // Signature (the runtime's published keys), issuer, expiry, audience and tenant.
    let claims: Record<string, any>;
    try {
      const token = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");
      ({ claims } = await verifyRuntimeToken(token, { runtime: "https://run.camelai.com", tenant: "acme", audience: AUDIENCE }));
    } catch (error) { return refuse(401, String(error)); }
    // A request for a credential, for the server we issue for: a tool call's token has no `exchange`.
    if (claims.exchange?.server !== "github" || claims.exchange?.url !== "https://mcp.example.com/github") return refuse(403, "not a request for the GitHub server's credential");
    if (claims.definition !== env.TRIAGE_DEFINITION) return refuse(403, "only the triage definition's agents");

    // The App authenticates as itself (a JWT signed with its private key, ten minutes at most)…
    const now = Math.floor(Date.now() / 1000);
    const app = await new SignJWT({}).setProtectedHeader({ alg: "RS256" }).setIssuer(env.GITHUB_APP_ID).setIssuedAt(now - 60).setExpirationTime(now + 540)
      .sign(await importPKCS8(env.GITHUB_APP_PRIVATE_KEY, "RS256"));
    // …and asks for an installation token, down-scoped to what triage needs.
    const github = await fetch(`https://api.github.com/app/installations/${env.GITHUB_INSTALLATION_ID}/access_tokens`, {
      method: "POST",
      headers: { Authorization: `Bearer ${app}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "acme-triage" },
      body: JSON.stringify({ repositories: ["api", "web"], permissions: { issues: "write", contents: "read", metadata: "read" } }),
    });
    if (!github.ok) return refuse(502, `GitHub answered ${github.status}`);
    const { token, expires_at } = await github.json() as { token: string; expires_at: string };
    return Response.json({ token, expiresAt: expires_at });
  },
};
```

(`importPKCS8` takes a PKCS#8 key; GitHub's download is PKCS#1, so convert it
once: `openssl pkcs8 -topk8 -nocrypt -in app.pem`.) The same shape fits any
credential your service can mint: an STS `AssumeRole` session, an OAuth access
token from a refresh token you hold, a database's short-lived password.

#### What the runtime does with a credential

- **Per agent.** A credential is kept for the agent it was fetched for (its
  tenant, id, `subject` and `context`, definition, server and endpoint), and
  never used for another: your endpoint decides per caller, so two agents of a
  definition each ask for their own.
- **In memory only.** It is never stored, logged, returned by an API, put in
  an event or a transcript, or shown to the model. Each node of a cluster
  keeps its own, so an agent that moves to another node asks again there.
  Issue credentials that can coexist.
- **Refreshed early.** It is fetched again five minutes before it expires (or
  a fifth of its lifetime before, for one shorter than 25 minutes). It is kept
  a day at most whatever expiry it gives, and used for at least five seconds,
  so one that expires at once cannot cause a fetch per request. Calls made at
  once share one fetch.
- **Refused by the server.** When the server answers 401 or 403, the
  credential is dropped, another is fetched, and the request is sent once
  more. If the server refuses that one too, the tool call fails.
- **Your endpoint is down.** It has 5 seconds to answer; a network error, a
  timeout, a 5xx, a 408 or a 429 is tried again, up to three times within 8
  seconds. Then, and at once for any other status, an answer that is not the
  JSON above, or a token already expired, the tool call fails with code
  `source_unavailable` and a message that says what the endpoint did; the
  model reads it and the turn goes on, as when an MCP server cannot be
  reached. An answer that is wrong is never quoted, since it may hold a
  token.
- **Saving the definition** lists the server's tools, so it asks for a
  credential then, before any agent exists. That request is made as the
  definition: its token's `agent` and `sub` are the definition's id, and its
  body has no `agent`. An endpoint that refuses it, or answers wrongly, fails
  the save with a 400 saying what it answered; one that is down does not (the
  server shows in `toolSources` with `status: "error"`), and the save never
  waits more than a few seconds for it.
- `auth.url` is checked like every URL you give (see [Outbound
  calls](#outbound-calls)): `https://`, a public address, no redirects. The
  API returns it with the definition, so put no secret in it: the identity
  token is what authenticates the runtime.

Each fetch writes a log line and a metric, `tool_credential_exchange`, with
its outcome (`fetched`, `unreachable`, `blocked`, `timeout`, `unavailable`,
`refused`, `invalid_response`, `expired`, and `rejected` when the server
refused a credential), the server's name and the endpoint's host.

It is for a definition's MCP servers. OpenAPI sources and an agent's own MCP
servers do not take it yet, and the endpoint's answer carries a token only,
not extra headers. A built-in `github-app` auth type, where camelRun holds the
App's key and mints the token itself, may follow.

### OpenAPI specs

```json
{"name": "Support", "openApi": [{
  "name": "shop", "spec": "https://api.example.com/openapi.json",
  "auth": {"type": "bearer", "token": "…"}, "allowTools": ["listOrders", "getOrder", "refundOrder"]
}]}
```

Every operation of an OpenAPI 3 spec (JSON or YAML) is a tool:

- Named `<name>__<operationId>` (or `<name>__<method>_<path>`). Its input is the
  operation's path, query and header parameters by name, plus `body` for the
  request body (JSON, or form-encoded with nested values in brackets, as Stripe
  reads them). A `multipart/form-data` body's file fields, and a binary body,
  take `{"$file": path}` and stream the file, when the source's
  `fileArguments` is on (as for MCP servers).
- The spec is fetched and checked when the definition is saved, and its
  operations (after `allowTools`/`denyTools`, at most 1024) are stored with it:
  an agent's tools never change under it. Save the definition again to take a
  spec's changes. `spec` may also be the document itself.
- Requests go to `baseUrl` (default the spec's first server), with no redirects,
  `timeoutMs` (default 30 s, at most 20 minutes), and each call's stable key as
  an `Idempotency-Key` header. A 2xx answer is the result (JSON, text, or a file
  saved to the workspace); any other status is a tool error quoting the method,
  path, status and the start of the body.

## An agent's own MCP servers

An agent made without a definition, and a [stateless run](stateless-runs.md),
can list MCP servers itself, with no definition:

```ts
const agent = await agents.upsert("support", {
  instructions: "…",
  mcpServers: [{ name: "kb", url: "https://mcp.example.com/mcp", auth: { type: "runtime" } }],
});
```

```bash
curl -X POST "$BASE/v1/agents" -H "Authorization: Bearer $KEY" -H "Idempotency-Key: support" \
  -d '{"mcpServers": [{"name": "kb", "url": "https://mcp.example.com/mcp", "auth": {"type": "runtime"}}]}'
```

- They take no credentials: `auth` is `{"type": "runtime"}` or left out, and
  there are no `headers`. A server with a token, headers or a credential
  exchange is a 400 saying to use a definition.
- Why: a definition seals its credentials once, for every agent made from it.
  Credentials on each agent or run would be secrets stored, copied and rotated
  per agent. Identity tokens need none: the runtime signs one for each request,
  naming the agent, its `subject` and `context` (and no `definition`).
- Everything else is as in a definition: `allowTools`, `denyTools`, `exposure`,
  `timeoutMs`, `audience`, `approval`, and the same outbound checks.
- They are not listed when saved. A server that cannot be listed when the agent
  starts shows in the run's `sourceErrors`.
- `PATCH /v1/agents/:id/configuration` with `mcpServers` replaces the list;
  `null` or `[]` removes it. An upsert sets the whole list, so an upsert without
  `mcpServers` leaves none. They count toward the upsert's `configHash`.
- Only your API key changes them, never the agent's own token. An agent made
  from a definition has its definition's servers and refuses its own (400).
- Only MCP servers: OpenAPI specs are fetched and stored when saved, so they stay
  in definitions.

## Built-ins

Tools the runtime answers itself, given to an agent as `builtins` when it is
made or upserted (`agents.upsert("researcher", { builtins: ["web_search",
"web_fetch"] })`, or `PATCH /v1/agents/:id/configuration`), or by the definition
it is made from (whose builtins it then has):
`"builtins": ["file_link", "file_import", "web_fetch", "web_search", "x_search", "schedule", "ask_user", "delegate", "generate_image", "agents", "decide", "workflow"]`.

- `file_link` (`{path, method, expiresIn?, maxBytes?, contentType?}`) signs a
  GET or PUT URL for another tool to transfer one workspace file. Default
  lifetime: 5 minutes; maximum: 15. PUT requires a writable path and `maxBytes`
  up to 256 MiB. Hand the URL to the tool; never paste file contents.
- `file_import` (`{url, to}`) streams a public HTTP(S) URL to a writable workspace
  path, up to 256 MiB and within the storage quota. It uses `web_fetch`'s outbound
  guard and returns path, size, SHA-256 and content type.
- `web_fetch` (`{url, maxCharacters?}`) reads a public page as text (HTML
  reduced to readable text, 20,000 characters by default, at most 100,000), or
  saves any other content (a PDF, an image) to the workspace. Pages that are
  only a JavaScript shell are rendered when a Firecrawl key is available.
- `web_search` (`{query, count?, freshness?}`) returns `{query, provider,
  results: [{title, url, date?, content | snippet}]}`, trying search providers
  in order (Exa, Brave, Parallel; a definition can pin its own with
  `"webSearch": {"providers": ["brave"]}`). Your own key for a provider
  (`PUT /v1/providers/<provider>/key`) is used first; otherwise the platform's,
  charged per search on prepaid credit. Saving a definition or an agent with
  `web_search` when none of its providers has a key answers with `warnings`
  saying which keys would set it up, and the console shows them; a search then
  fails with the same text ("Web search isn't available for this account: add
  an Exa, Brave or Parallel key under Models & keys").
- `x_search` (`{query, allowedHandles?, excludedHandles?, fromDate?, toDate?}`)
  searches X through Grok and returns a summary, source citations, and usage.
  It works with any main model. Set an xAI key under Models & keys
  (`PUT /v1/providers/xai/key`), or use the platform's key when available.
  `allowedHandles` and `excludedHandles` each accept up to 20 handles, with or
  without `@`; use one filter or the other. Dates are `YYYY-MM-DD` in UTC:
  `fromDate` is inclusive and `toDate` exclusive. Treat posts as claims to
  corroborate, not verified facts.
  Each call uses `grok-4.7`, with at most two model turns and 1,800 output tokens.
  When calling from `js_exec`, set its `timeoutMs` to `150000` to allow for
  the search deadline. The result includes `text`, `citations: [{url, title?}]`, `incomplete`, and
  `usage: {inputTokens, cachedInputTokens, outputTokens, searchCalls,
  postsFetched, profilesFetched, costUsd}`. An incomplete answer is marked;
  a failed or empty answer raises an error. Provider-reported usage is counted
  even when the answer is incomplete or empty. Cost includes Grok tokens and
  fetched posts or profiles, not a flat price per search. Usage appears under
  `xai/x_search`; calls using the platform's key charge prepaid credit at that
  reported cost, with no added search fee. The runtime does not retry a failed
  request automatically.
- `schedule`, `list_schedules`, `cancel_schedule` let the agent manage its own
  wake-ups (100 per agent, at most a year ahead, repeats at least a minute apart).
- `ask_user` lets the model ask the user 1 to 4 multiple-choice questions; the
  run waits for the answer. See [Human input](human-input.md).
- `delegate` (with `delegate: { agents }`) hands a task to a sub-agent and
  returns its answer. See [Multi-agent](multi-agent.md).
- `generate_image` (`{prompt, images?, size?, quality?, format?, background?}`)
  makes an image, or edits images from the agent's files (`images`: their
  paths), saves it to the workspace under `tool-outputs/generate_image/` and
  shows it to the model; the model presents it to the user with `present_file`.
  It uses OpenAI's `gpt-image-2.5-flare` on your OpenAI key (or a key scope's),
  else the platform's, charged per token on prepaid credit, and counts against
  the agent's and the run's spend limits. Saving a definition or an agent with
  it and no OpenAI key answers with a warning. See [Images](images.md#in-an-agent).
- `decide` (`{state, questions}` or `{items}`) answers typed questions about a
  state (yes/no, a choice, a score) with probabilities, through a decision model
  (TypeSafe's Jev on OpenRouter). It is on by default and needs no listing here:
  every agent has it but one with no `js_exec` and no tools of its own; opt out
  with `decide: false` on the agent, run or definition. From `js_exec`,
  `tools.decide({items})` takes up to 100 states a call, for classifying or
  scoring a dataset. Each call is billed (on the platform's key, to prepaid
  credit) and counts against the agent's and the run's spend limits. See
  [Decisions](decisions.md#in-an-agent).
- `agents` (with the same settings) starts sub-agents in the background
  (`spawn_agent`, `wait_agent`, `list_agents`); each one's answer arrives as a
  notification. See [Background sub-agents](multi-agent.md#background-sub-agents).

## Seeing an agent's tools

`GET /v1/agents/:id` returns `toolSources` (SDK: `agents.runtime.toolSources(agentId)`,
Python `tool_sources`): every source in order of precedence (the channel's, the
attached application's, file tools, then the definition's), each with its
`status` and `tools`, and for each tool why the model does not get it, if it
does not (an earlier source has its name, or the catalog is full).
`?schemas=true` adds input schemas; `?refresh=true` lists every MCP server now,
which is how to check one before the agent runs. The console shows the same on
an agent's Configuration tab.

## Tools from code: `js_exec`

The model can write JavaScript that calls any of its tools, in a sandbox
(a bare V8 isolate in a process of its own) that can reach nothing else: `await
tools.shop__getOrder({ id })`, `Promise.all` for parallel calls, `fs` over its
files, `tools.search(query)` to find tools in a large catalog, `tools.describe(name)`
for a schema. Code runs for at most 60 seconds, 2 s of CPU and 256 tool calls; see
[Limits](../reference/limits.md). `agent.client.execute(code)` runs code
yourself, outside the model's history, which is handy for testing tools.

### Without code: `codeMode: false`

An agent made with `codeMode: false` (Python `code_mode=False`, in a definition
too) has no `js_exec`. The model calls every tool directly, whatever its
`exposure`, and the runtime's part of the system prompt covers only the tools
it has, with nothing about code. With `fileTools: false` as well and no tools of
any source, it has no tools at all (not even `present_file`), and the system
prompt is your instructions plus a short note on who sent each message: for an
agent that answers in a line, a classifier or a judge, a request goes from about
2,000 input tokens to a few hundred.

```ts
const voice = await agents.upsert("voice-12", { instructions, codeMode: false, fileTools: false });
```

Set it when the agent is made. Changed later by an upsert, the agent's tools
change at once, while a conversation already under way keeps the runtime text
it began with (its prompt's cached prefix).

## Tool search

Code finds tools with `tools.search(query)` (or `tools.search(query, { namespace,
limit })`): the best matches as `{name, description, input}`, most relevant
first (20 by default, at most 128). `tools.namespaces()` lists the sources with
their tool counts. Only tool names enter the sandbox, so a catalog of thousands
of tools costs a script nothing until it asks. Ranking is by keywords, and, on
the hosted runtime, also by meaning (embeddings, then a model that drops tools
that cannot do what is asked); searches ranked by meaning are billed at cost.

## Files in tool calls

Tools of a definition's sources take and return files without their bytes
passing through the model. The model names a file by its path, as
`{"$file": "/workspace/report.pdf"}`, and the runtime sends it the way the
tool's schema asks.

### Marking a parameter

A string parameter takes a file when it is marked as MCP's file inputs proposal
(SEP-2631, a draft) marks one:

```json
{"type": "object", "properties": {
  "attachment": {"type": "string", "format": "uri",
    "x-mcp-file": {"accept": ["application/pdf", "image/*"], "maxSize": 10485760, "transferModes": ["url", "inline"]}},
  "site": {"type": "string", "format": "uri", "x-mcp-file": {}, "x-camelrun-directory": true}
}}
```

- `accept`: the MIME types it takes (`image/*` and `*/*` work). Others are a
  tool error.
- `maxSize`: the most bytes it takes. A larger file is a tool error.
- `transferModes`: `url` (the default), `inline`, or both.
- `x-camelrun-directory: true`: the parameter takes a directory.

Unmarked parameters take files too, as before: a base64 field
(`contentEncoding: base64`, OpenAPI's `format: byte` or `binary`) gets the
content (up to 4 MiB), and a `format: uri` field, or one named like a URL
(`source_url`), gets a URL. An OpenAPI multipart or binary body streams the
file. The model sees `{"$file": path}` offered beside the field, with what the
tool takes.

### What the tool receives

- **A URL**, `https://<runtime>/v1/files/<token>/<name>`. It answers `GET`
  (with `Range`) with the file, and nothing else.
- **Inline**, when `transferModes` has `inline` and the file is at most 4 MiB:
  a `data:<type>;base64,…` URI. With `inline` alone, a larger file is a tool
  error.
- **A directory**: the URL of a manifest:

```json
{"snapshot": "snap_…", "root": "/workspace/site",
 "files": [{"path": "index.html", "uri": "https://…/v1/files/…/index.html", "name": "index.html",
            "mimeType": "text/html", "size": 1840, "digest": {"algorithm": "sha-256", "value": "9f86d0…"}}],
 "archive": {"uri": "https://…/v1/files/…/site.tar.gz", "mimeType": "application/gzip"}}
```

  Each file has its own URL, and `archive` is a tar.gz of them all, with paths
  relative to the directory. A directory has at most 1,000 files and 256 MiB.

An MCP call also carries `_meta["camelrun/files"]`: each file sent as a URI,
by its argument's JSON pointer, as SEP-2631 describes a file:

```json
{"/attachment": {"uri": "https://…", "name": "report.pdf", "mimeType": "application/pdf",
                 "size": 48213, "digest": {"algorithm": "sha-256", "value": "e3b0c4…"}}}
```

`digest` is the sha-256 of the bytes, in hex; files over 64 MiB have none.
OpenAPI calls have no `_meta`.

### URL lifetime, binding and versions

- A URL lasts 5 minutes: fetch the file while the call runs.
- It is bound to one call. Its token names the tenant, the agent, the call (its
  idempotency key), the tool and the file.
- A file's URL serves the version the call named. Once the file changes, it
  answers 410 ("changed since the call"), so a tool never gets a mix of
  versions.
- A directory is sent as a snapshot made for the call. Its files read as they
  were then, whatever the agent writes meanwhile. The snapshot is deleted after
  the call, once its URLs have expired; it is not listed with the volume's
  snapshots and does not count toward them.
- An expired or altered URL answers 403.

### Verifying a URL

A tool can check that a URL came from camelRun, for the agent it expects:

```ts
import { verifyFileUrl } from "@camelai/run/server";

const file = await verifyFileUrl(args.attachment, { runtime: "https://run.camelai.com", tenant: "acme", agent: expectedAgent });
// { tenant, agent, call, tool, volume, path, agentPath, kind: "file" | "manifest" | "archive", version | snapshot, exp }
```

```python
from camelai_run import verify_file_url

file = await verify_file_url(arguments["attachment"], runtime="https://run.camelai.com", tenant="acme")
```

It checks that the URL is at the runtime and that its token is signed by the
runtime's keys (`/.well-known/jwks.json`, the identity tokens' keys) for files,
and has not expired. `camelai_run.sync.verify_file_url` is the synchronous one;
`testRuntime().fileUrl()` (Python `TestRuntime().file_url()`) makes one to test
with.

### Which sources get files

A source's `fileArguments` says whether it is sent files: `"on"` or `"off"`.

- By default it is on for sources with `auth: {"type": "runtime"}`: your own
  servers, which check who is calling.
- It is off for every other source. Its tools are not offered `{"$file": …}`,
  a `$file` argument is a tool error, and nothing about files reaches it. A
  model talked into it could otherwise send any file the agent can read to
  another party's server.
- Set `"fileArguments": "on"` on a third-party server you trust with the
  agent's files.

```json
{"mcpServers": [{"name": "docs", "url": "https://mcp.example.com/mcp", "fileArguments": "on"}]}
```

### Files a tool returns

- MCP images, audio, embedded blobs and long text resources are saved under
  `/workspace/tool-outputs/<tool>/<call>/`, and the model gets a reference to each. Tools an application attaches
  are treated the same way. Without a workspace mount, results keep their existing behavior.
- `resource_link` items stay links, with a hint that `file_import` can fetch them.
- Binary OpenAPI responses and `web_fetch` downloads still go to
  `/workspace/tool-outputs/<tool>/<call>/<name>` and return file references.
- MCP and automatic tool outputs may save 64 MiB per call and 256 MiB per run.
  Explicit `file_import` calls use the volume's 256 MiB file limit and quota.

## Outbound calls

Every request to a URL you or the model chose (MCP servers, OpenAPI specs and
APIs, `web_fetch`) goes through one guard: `https://` only, no credentials in
URLs, and no private, loopback, link-local or otherwise internal address, checked
on every connection (so DNS rebinding cannot slip past). MCP servers and API
calls get no redirects; where redirects are followed (`web_fetch`, spec
downloads) each hop is checked, and credentials never go to another origin.

A self-hosted runtime's operator can allow exact origins of their own
(`AGENT_OUTBOUND_ALLOW_ORIGINS`) for MCP servers, APIs and model providers on
their network; `web_fetch` never reaches them.
