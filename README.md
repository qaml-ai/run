# Agent runtime

A hosted runtime for durable agents. Applications define tools in their own
code with the TypeScript or Python SDK (or serve them over HTTP); the runtime runs
the model loop, keeps each agent's history and files (with compaction), executes
model-written code in a QuickJS/WebAssembly sandbox, and wakes agents when there
is work. Most agents are asleep at any time, and any node can load one.

Live at <https://agents.camelai.dev> (REST API under `/v1`, described by
`/v1/openapi.json` and the committed [`openapi.json`](openapi.json); console at
`/console`).

```ts
import { Agents } from "@camelai/agent-runtime";

const agents = new Agents(); // CAMELAI_API_KEY
const agent = await agents.upsert("support-triage", { model: "anthropic/claude-sonnet-5-5", instructions: "Be concise." });
console.log((await agent.run("Which tickets look urgent?")).text);
await agents.close();
```

## Documentation

- [Quickstart](docs/quickstart.md): a working agent in five minutes
- [Concepts](docs/concepts.md): keyed agents, runs, events, where tools run
- Guides: [tools](docs/guides/tools.md), [human input](docs/guides/human-input.md),
  [browser](docs/guides/browser.md), [files](docs/guides/files.md),
  [many users](docs/guides/multi-user.md), [webhooks](docs/guides/webhooks.md),
  [models and keys](docs/guides/models-and-keys.md), [definitions](docs/guides/definitions.md),
  [channels](docs/guides/channels.md)
- [Production checklist](docs/production.md)
- Reference: [events](docs/reference/events.md), [limits](docs/reference/limits.md),
  [errors](docs/reference/errors.md), [SDKs](docs/reference/sdk.md), [REST API](openapi.json)

The same pages are served as Markdown at <https://agents.camelai.dev/llms.txt>,
for agents and tools that read documentation.

## Repository

- `src/` server, supervisor, agent host, sessions, scheduler, REST API, sandbox
- `clients/` the TypeScript and Python SDKs; `sdk/` publishes `@camelai/agent-runtime`
- `console/` the tenant console; `studio/` a local chat and trace UI
- `examples/` runnable examples; `docs/` the documentation
- `migrations/`, `shared/`, `infra/`, `deploy/`, `tests/`

To run, develop or deploy the runtime itself, see [Operations](docs/operations/README.md):
[architecture](docs/operations/architecture.md), [configuration](docs/operations/configuration.md),
[persistence](docs/operations/persistence.md), [billing](docs/operations/billing.md),
[tenant isolation](docs/operations/isolation.md), [sandbox](docs/operations/sandbox.md).
