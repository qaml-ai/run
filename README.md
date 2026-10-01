# camelRun

A hosted runtime for durable agents. Applications define tools in their own
code with the TypeScript or Python SDK (or serve them over HTTP); the runtime runs
the model loop, keeps each agent's history and files (with compaction), executes
model-written code in a QuickJS/WebAssembly sandbox, and wakes agents when there
is work. Most agents are asleep at any time, and any node can load one.

Live at <https://run.camelai.com> (REST API under `/v1`, described by
`/v1/openapi.json` and the committed [`openapi.json`](openapi.json); console at
`/console`).

Set it up with your coding agent (Claude Code, Codex, Cursor…) by pasting:

```text
Read https://run.camelai.com/SKILL.md and set up camelRun in this project.
```

Or by hand:

```ts
import { Agents } from "@camelai/run";

const agents = new Agents(); // CAMELAI_API_KEY
const agent = await agents.upsert("support-triage", { instructions: "Be concise." });
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
  [errors](docs/reference/errors.md), [SDKs](docs/reference/sdk.md), [CLI and MCP server](docs/reference/cli.md),
  [REST API](openapi.json)

The same pages are served as Markdown at <https://run.camelai.com/llms.txt>,
for agents and tools that read documentation.

## Repository

- `src/` server, supervisor, agent host, sessions, scheduler, REST API, sandbox
- `clients/` the TypeScript and Python SDKs; `sdk/` publishes `@camelai/run`
- `packages/cli/` the `camelrun` CLI and MCP server (`@camelai/camelrun`)
- `plugins/chatgpt/` the camelRun plugin for ChatGPT and Codex (`codex plugin marketplace add qaml-ai/run`)
- `console/` the tenant console; `studio/` a local chat and trace UI
- `examples/` runnable examples; `docs/` the documentation
- `migrations/`, `shared/`, `infra/`, `deploy/`, `tests/`

To run, develop or deploy the runtime itself, see [Operations](docs/operations/README.md):
[architecture](docs/operations/architecture.md), [configuration](docs/operations/configuration.md),
[persistence](docs/operations/persistence.md), [billing](docs/operations/billing.md),
[tenant isolation](docs/operations/isolation.md), [sandbox](docs/operations/sandbox.md).

## License

The runtime (this repository's server, `src/`, `shared/`, `infra/`, and everything else not listed below) is licensed under the [GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0-only).

The client SDKs and frontend packages are MIT, so you can use them in any application:

- `clients/` (the TypeScript and Python SDKs) and `sdk/`: [MIT](clients/LICENSE)
- `packages/` (React, Vue, Svelte, Solid, `create-run-app`, the CLI): MIT, each with its own `LICENSE`
- `shared/client-protocol.ts`, which ships inside the SDK: MIT
- `examples/`: [MIT](examples/LICENSE)
- `plugins/`: MIT, each plugin with its own `LICENSE`

### Commercial licensing

If the AGPL-3.0 doesn't work for your organization, we offer the runtime under a commercial license too. Contact us through [camelai.com](https://camelai.com).

Contributions are accepted under our [Contributor License Agreement](CLA.md); see [CONTRIBUTING.md](CONTRIBUTING.md).
