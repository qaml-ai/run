# camelRun documentation

The hosted runtime for durable agents: you define tools in your code, and the
runtime runs the model loop, keeps each agent's history and files, runs
model-written code in a sandbox, and wakes agents when there is work.
<https://run.camelai.com>

1. **[Quickstart](quickstart.md)**: an agent answering you in five minutes, in
   TypeScript, Python or curl.
2. **[Concepts](concepts.md)**: durable keyed agents, runs, events, where tools
   run, processes, people in the loop, idempotency. **[Pricing](pricing.md)**:
   what usage costs, and credit.
3. **Guides**
   - [Tools](guides/tools.md): writing tools, attached and served tools, identity, MCP and OpenAPI sources, built-ins
   - [Human input](guides/human-input.md): approvals, questions and forms; answering
   - [Structured output](guides/structured-output.md): a run's answer as an object in your schema (zod, pydantic, JSON Schema)
   - [Showing an agent in a browser](guides/browser.md): browser tokens and the watcher
   - [Files](guides/files.md): attachments, what the model sees, files out, volumes, signed links
   - [Agents for many users](guides/multi-user.md): per-user agents, identity, spend
   - [Webhooks](guides/webhooks.md): run and input events, signatures, delivery
   - [Observability](guides/observability.md): OpenTelemetry traces in LangSmith, Langfuse, Honeycomb, Datadog or any OTLP backend
   - [Models and keys](guides/models-and-keys.md): the catalog, your own keys and endpoints, key scopes, spend limits
   - [Definitions](guides/definitions.md): reusable configurations and rolling out changes
   - [Channels](guides/channels.md): Slack, Telegram, Discord, GitHub, email and any service that sends webhooks
   - [Agents as MCP servers](guides/mcp-server.md): connect Claude or Cursor to an agent
   - [Coming from the OpenAI Agents SDK or LangGraph](guides/migrating.md): each concept mapped, and what camelRun does not have
   - [Exporting your data](guides/export.md): the account export, and moving to a self-hosted runtime
4. **[Production checklist](production.md)**
5. **Reference**
   - [Events](reference/events.md): every event on an agent's stream, and a run's outcome
   - [Limits](reference/limits.md)
   - [Errors](reference/errors.md)
   - [SDKs](reference/sdk.md): TypeScript and Python, the simple and the lower-level API
   - [CLI and MCP server](reference/cli.md): deploy and manage agents from a terminal, or from a coding agent over the hosted MCP server
   - REST API: [`openapi.json`](../openapi.json), also served at <https://run.camelai.com/v1/openapi.json>

Running or developing the runtime itself? See [Operations](operations/README.md).
