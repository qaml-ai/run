# Observability: traces in your own backend

The runtime exports your agents' runs as OpenTelemetry traces to any OTLP/HTTP
endpoint: LangSmith, Langfuse, Honeycomb, Datadog, Grafana Tempo, Jaeger, or your
own collector. Each run is a trace (or part of yours), with a span for every model
call, tool call, compaction and wait for a person. Spans follow the OpenTelemetry
[GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/),
so GenAI-aware backends show them as LLM calls and tool calls.

```http
PUT /v1/telemetry
Authorization: Bearer $CAMELAI_API_KEY

{"endpoint": "https://api.honeycomb.io/v1/traces", "headers": {"x-honeycomb-team": "<key>"}}
```

What your users and the model wrote (prompts, replies, tool arguments and results)
is **not** exported unless you ask for it with `include: {content: true}`. See
[What is exported](#what-is-exported).

## Setting it up

| Field | |
| --- | --- |
| `endpoint` | The OTLP/HTTP traces URL spans are POSTed to. HTTPS, and on the public internet (see [Endpoints the runtime refuses](#endpoints-the-runtime-refuses)). A collector's base URL (`https://collector.example.com:4318`) gets `/v1/traces` |
| `headers` | Sent with every export: your backend's API key, a project name. Stored encrypted and never shown again: `GET` lists their names only. Left out of a later `PUT`, they stay as long as the endpoint keeps its origin, and are dropped when it moves elsewhere; `{}` removes them |
| `protocol` | `http/protobuf` (default) or `http/json`. gRPC is not supported |
| `sampleRate` | The share of runs traced, 0 to 1 (default 1). A run that continues your trace follows your `traceparent`'s sampled flag instead |
| `include.content` | `true` to export prompts, replies, tool arguments and results, and error messages. Default `false` |

- `GET /v1/telemetry` shows the settings, header names, and `status`: when a node
  last exported, and why the last export failed (`HTTP 401`, `Could not connect
  (ECONNREFUSED)`), since the last success.
- `POST /v1/telemetry/test` sends one span (`camelrun test span`) now and answers
  with what your endpoint said and the span's `traceId`, to find it in your
  backend.
- `DELETE /v1/telemetry` stops export.

The SDKs, CLI and console do the same:

```ts
await runtime.telemetry.set({ endpoint: "https://api.honeycomb.io/v1/traces", headers: { "x-honeycomb-team": key } });
await runtime.telemetry.test();
```

```python
runtime.telemetry.set(endpoint="https://api.honeycomb.io/v1/traces", headers={"x-honeycomb-team": key})
```

```sh
camelrun telemetry set https://api.honeycomb.io/v1/traces --header x-honeycomb-team=$HONEYCOMB_KEY
camelrun telemetry test
```

In the console: **Settings → Telemetry**, with a **Send test span** button.

## Presets

| Backend | `endpoint` | `headers` | Notes |
| --- | --- | --- | --- |
| LangSmith | `https://api.smith.langchain.com/otel/v1/traces` (EU: `https://eu.api.smith.langchain.com/otel/v1/traces`) | `x-api-key: <LangSmith API key>`, `Langsmith-Project: <project>` | Reads the GenAI attributes as LLM and tool runs; set `include.content` to see messages |
| Langfuse | `https://cloud.langfuse.com/api/public/otel/v1/traces` (US: `https://us.cloud.langfuse.com/...`) | `Authorization: Basic <base64 of public-key:secret-key>` | Self-hosted Langfuse: your host, same path |
| Honeycomb | `https://api.honeycomb.io/v1/traces` (EU: `https://api.eu1.honeycomb.io/v1/traces`) | `x-honeycomb-team: <API key>` | Traces land in the `camelrun` dataset (the service name) |
| Datadog | `https://otlp.datadoghq.com/v1/traces` (or your site's, e.g. `otlp.datadoghq.eu`) | `dd-api-key: <API key>`; add `dd-otlp-source: llmobs` for LLM Observability instead of APM | `http/protobuf` |
| Grafana Cloud (Tempo) | `https://otlp-gateway-<zone>.grafana.net/otlp/v1/traces` | `Authorization: Basic <base64 of instance-id:token>` | Self-managed Tempo: its OTLP/HTTP receiver, port 4318 |
| Your own collector | `https://otel.example.com:4318/v1/traces` | whatever it checks | An OpenTelemetry Collector fans out to several backends, and can redact or sample further |

### A local collector or Jaeger

A hosted runtime cannot reach `localhost`. To look at traces on your machine,
expose a local collector through a tunnel (`cloudflared`, `ngrok`) and give its
HTTPS URL, or run a [self-hosted runtime](../operations/README.md) and allow the
collector's origin: `AGENT_OUTBOUND_ALLOW_ORIGINS=http://localhost:4318`.

```sh
docker run --rm -p 16686:16686 -p 4318:4318 jaegertracing/all-in-one:latest
camelrun telemetry set http://localhost:4318      # a self-hosted runtime that allows that origin
```

Jaeger's UI is at <http://localhost:16686>, under the service `camelrun`.

## Continuing your trace

Send a W3C `traceparent` header with a run, and its spans join your trace under the
span you name:

```http
POST /v1/agents/client_…/prompt
traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
```

The SDKs pass it for you:

```ts
const run = await agent.run("Summarize ticket 123", { traceparent });
```

```python
run = agent.run("Summarize ticket 123", traceparent=traceparent)
```

With the OpenTelemetry API in your process, take the header from the active span
(`propagation.inject(context.active(), carrier)` in TypeScript,
`opentelemetry.propagate.inject(carrier)` in Python) and pass
`carrier["traceparent"]`. The header is also taken on `POST /v1/agents` (a first
prompt) and on the SDKs' `POST /clients/:id/requests`. It is not part of the
request's idempotency: a retry under another span is the same run.

A run's record (`GET /v1/agents/:id/requests/:requestId`) carries `trace:
{traceId, spanId, parentSpanId?, sampled}` when its tenant exports telemetry, so
you can link from your own logs to the trace.

## Spans

```text
invoke_agent Support bot                      server   the run: accepted to ended
├─ chat claude-sonnet-4-5                     client   one model call (its retries are their own spans)
├─ execute_tool lookup_order                  internal a tool call
├─ chat claude-sonnet-4-5
├─ execute_tool js_exec                       internal model-written code
│  └─ execute_tool lookup_order               internal a tool call from that code
├─ compaction                                 client   summarizing the history to fit the context
└─ await_human_input                          internal a wait for a person (recorded when the run resumes)
invoke_agent Support bot                      server   the run that resumed after the input, under the run that asked
```

Each span has `camelrun.tenant`, `camelrun.agent.id` and `camelrun.request.id`.

| Span | Attributes |
| --- | --- |
| `invoke_agent <agent name or id>` (`execute_code` for an `execute` request) | `gen_ai.operation.name`, `gen_ai.agent.id`, `gen_ai.agent.name`, `gen_ai.conversation.id` (the agent id), `gen_ai.system` / `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.usage.cache_read.input_tokens`, `gen_ai.usage.cache_creation.input_tokens`, `camelrun.cost.usd`, `camelrun.run.method`, `camelrun.run.status` (`completed`, `input_required`, `failed`), `camelrun.run.stopped`, `camelrun.error.code`, `error.type`, `camelrun.run.uncertain`, `camelrun.run.model_responses`, `camelrun.run.tool_calls`, `camelrun.run.inputs`, `camelrun.run.queued_ms`, `camelrun.run.resumes`, `camelrun.actor` |
| `chat <model>` | `gen_ai.operation.name: chat`, `gen_ai.system`, `gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.response.id`, `gen_ai.response.finish_reasons`, the token counts, `camelrun.cost.usd`, `error.type` |
| `execute_tool <tool>` | `gen_ai.operation.name: execute_tool`, `gen_ai.tool.name`, `gen_ai.tool.call.id`, `gen_ai.tool.type`, `camelrun.tool.source` (`attached`, `served`, `mcp`, `openapi`, `builtin`, `files`, `channel`, `runtime`), `camelrun.tool.inner_call.id` (a call from code), `camelrun.tool.input_required`, `error.type` |
| `compaction` | `camelrun.operation: compaction`, the model and token counts, `camelrun.cost.usd`, `camelrun.compaction.reason`, `.tokens_before`, `.summarized_messages`, `.kept_messages`, `.skipped`, `.background` |
| `await_human_input` | `camelrun.input.id`, `camelrun.input.kind`, `camelrun.input.state`, `camelrun.input.via`, `gen_ai.tool.call.id` |

The resource is `service.name: camelrun`. A failed span has status `ERROR`; its
message is the error's class (`rate_limit`, `context_overflow`, `tool_error`)
unless content is included, when it is the error's own message.

- **A run that waits on a person** ends with `camelrun.run.status:
  input_required`. When the input is answered, the run that resumes it is a new
  `invoke_agent` span in the same trace, under the run that asked, beside an
  `await_human_input` span for the wait (which can be days long).
- **A compaction between runs** belongs to no run: it is a trace of its own.
- **A run that moves to another node** (a deploy, a lost node) keeps its trace:
  each node exports the spans it made, the first node's cut-off calls marked
  `error.type: interrupted`, and the run's span, with the same id, comes from the
  node that finished it.
- **Subagents.** A tool call's span is the parent of whatever the call starts: a
  delegate's run continues the trace under the tool call that made it.

## What is exported

By default, spans carry ids, names, models, token counts, costs, durations and
outcomes: what you need to see what an agent did, how long it took and what it
cost. The agent's name, your tools' names and the run's `actor` (your id for the
user) are included; a message's `metadata` is not.

With `include: {content: true}` they also carry, each cut at 16,384 characters:

| Attribute | On | Holds |
| --- | --- | --- |
| `gen_ai.input.messages` | the run | the prompt |
| `gen_ai.output.messages` | the run; each `chat` | the reply; each response's text, reasoning and tool calls |
| `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result` | each `execute_tool` | the call's arguments and its result's text |
| `camelrun.code`, `camelrun.code.output` | an `execute` run | its code and what it printed |
| `camelrun.output` | the run | a structured answer |
| `camelrun.input.message` | `await_human_input` | the question asked |
| `camelrun.metadata.<key>` | the run | the message's `metadata` |
| status messages | failed spans | the error's own message (a provider's error can quote a prompt) |

Content goes only to your endpoint; the runtime's own logs never hold it. Turn it
on for development, or where your backend is allowed to keep your users' data.

## Delivery

Export never slows a run. Each node queues the spans it makes in memory and sends
them in batches (up to 512 spans, about every 2 seconds), retrying `429`, `502`,
`503`, `504` and connection failures with backoff (honoring `Retry-After`) up to 5
attempts. Other answers drop the batch. A node keeps at most 5,000 waiting spans
per tenant and 20,000 in all; spans beyond those, and batches that run out of
attempts, are dropped and counted. Export is best effort: spans are kept in memory,
not durably, and a node that stops sends what it can within a few seconds. A batch
your endpoint accepted after its 10-second timeout is sent again, so a span can
arrive twice; backends keep one per span id.

## Endpoints the runtime refuses

The endpoint goes through the same guard as webhooks and MCP servers: HTTPS only,
no credentials in the URL, and no private, loopback, link-local (including cloud
metadata addresses) or reserved addresses, checked again at each connection
(`400` when it is set; `Could not connect` in `status.lastError` if a name later
resolves to one). Redirects are not followed. Self-hosted runtimes can allow an
internal collector with `AGENT_OUTBOUND_ALLOW_ORIGINS`.
