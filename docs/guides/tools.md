# Tools

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
- **`exposure`**: `"direct"` (the model calls it as a tool), `"codemode"` (only
  from code in `js_exec`, as `tools.<name>(args)`), or `"both"`. By default a
  source of up to 10 tools is `both` and a larger one `codemode`, so big catalogs
  do not crowd the model's context.

## Attached tools: in your process

Pass `tools` to `upsert` and this process serves them to the agent:

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
`testRuntime()` (`@camelai/run/testing`; `TestRuntime()` in Python)
signs tokens with a key of its own:

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
| `tenant`, `agent`, `definition` | whose agent it is, and which |
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
  "ctx": { "org": "acme" }, "act": "u_456", "origin": { … },
  "iat": 1790000000, "exp": 1790000120, "jti": "…" }
```

```ts
const jwks = createRemoteJWKSet(new URL("https://run.camelai.com/.well-known/jwks.json"));
const { payload } = await jwtVerify(token, jwks, { issuer: "https://agents.camelai.dev", audience: "https://tools.example.com/mcp", algorithms: ["EdDSA"] });
```

- `iss` is the hosted runtime's first address, `https://agents.camelai.dev`,
  at either of its URLs (a self-hosted runtime's is its `AGENT_ISSUER`, else its
  `AGENT_PUBLIC_URL`). The SDKs expect it for either hosted URL.
- `aud` is the server's URL (or the source's `audience`, for a server that knows
  itself by another URL), so a token cannot be replayed against another server.
  Tokens live two minutes, and each request gets its own `jti`.
- `act` and `origin` are absent outside a turn (listing a server's tools as an
  agent starts).
- The keys are at `/.well-known/jwks.json` (cache them for minutes);
  `/.well-known/oauth-authorization-server` names the issuer for MCP clients.

## Definitions' sources

A [definition](definitions.md) lists tool sources the runtime calls itself.

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
- `auth` is `{"type": "bearer", "token"}` or `{"type": "runtime"}` (signed
  identity tokens, above). `headers` and `auth` are stored sealed; the API
  returns only `headerNames` and `auth.type`. Updating a server without them
  keeps its stored credentials, unless its URL moved to another origin.
- Tools reach the model as `<server>__<tool>`, filtered by `allowTools` and
  `denyTools`. A server can set a tool's own exposure in `tools/list` with
  `_meta["agent-runtime/exposure"]`, and its deadline with
  `_meta["agent-runtime/timeoutMs"]`.
- Each call has a deadline (`timeoutMs`, default 60 s, at most 20 minutes). It
  limits silence: each progress notification restarts it, up to 20 minutes in
  all. A call from `js_exec` also ends with its execution (120 s at most), so
  expose long tools directly.
- Text reaches the model as it is; images, audio, blobs and text resources over
  64 KiB are saved to the agent's workspace and reach it as files. `isError`
  becomes a tool error; `structuredContent` is what code gets.
- The runtime lists each server when you save the definition: one that refuses
  its credentials is a 400 saying so, and the answer's `toolSources` shows what
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
`agent-runtime/innerCallId` for a call from code), `agent-runtime/actor` and
`agent-runtime/origin`.

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
  take `{"$file": path}` and stream the file.
- The spec is fetched and checked when the definition is saved, and its
  operations (after `allowTools`/`denyTools`, at most 1024) are stored with it:
  an agent's tools never change under it. Save the definition again to take a
  spec's changes. `spec` may also be the document itself.
- Requests go to `baseUrl` (default the spec's first server), with no redirects,
  `timeoutMs` (default 30 s, at most 20 minutes), and each call's stable key as
  an `Idempotency-Key` header. A 2xx answer is the result (JSON, text, or a file
  saved to the workspace); any other status is a tool error quoting the method,
  path, status and the start of the body.

## Built-ins

Tools the runtime answers itself, given to an agent as `builtins` when it is
made or upserted (`agents.upsert("researcher", { builtins: ["web_search",
"web_fetch"] })`, or `PATCH /v1/agents/:id/configuration`), or by the definition
it is made from (whose builtins it then has):
`"builtins": ["web_fetch", "web_search", "schedule", "ask_user"]`.

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
- `schedule`, `list_schedules`, `cancel_schedule` let the agent manage its own
  wake-ups (100 per agent, at most a year ahead, repeats at least a minute apart).
- `ask_user` lets the model ask the user 1 to 4 multiple-choice questions; the
  run waits for the answer. See [Human input](human-input.md).

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
(QuickJS in WebAssembly) that can reach nothing else: `await
tools.shop__getOrder({ id })`, `Promise.all` for parallel calls, `fs` over its
files, `tools.search(query)` to find tools in a large catalog, `tools.describe(name)`
for a schema. Code runs for at most 120 seconds and 256 tool calls; see
[Limits](../reference/limits.md). `agent.client.execute(code)` runs code
yourself, outside the model's history, which is handy for testing tools.

## Tool search

Code finds tools with `tools.search(query)` (or `tools.search(query, { namespace,
limit })`): the best matches as `{name, description, input}`, most relevant
first (20 by default, at most 128). `tools.namespaces()` lists the sources with
their tool counts. Only tool names enter the sandbox, so a catalog of thousands
of tools costs a script nothing until it asks. Ranking is by keywords, and, on
the hosted runtime, also by meaning (embeddings, then a model that drops tools
that cannot do what is asked); searches ranked by meaning are billed at cost.

## Files through tool calls

Tools of a definition's sources take and return files without their bytes
passing through the model:

- **In.** An argument `{"$file": "/workspace/report.pdf"}` names a file in the
  agent's mounts. The runtime fills it in by the tool's schema: a base64 field
  gets the content (up to 4 MiB), a URL field a signed link to the file (15
  minutes), an OpenAPI multipart or binary body the streamed file.
- **Out.** Images, audio, blobs and file responses are saved to
  `/workspace/tool-outputs/<tool>/<call>/<name>`, and the model gets a reference
  to each (shown natively when it is an image or PDF it can view).
- One call may save 64 MiB, and one run 256 MiB.

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
