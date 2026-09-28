# @camelai/agent-runtime

The TypeScript SDK for the camelAI agent runtime: durable agents you upsert by
key and run, with tools that are ordinary functions in your code. The runtime
runs the model loop, keeps each agent's history and files, and runs
model-written code in a sandbox that can only call your tools.

```sh
npm install @camelai/agent-runtime
```

Node 22 or later, Bun, Deno or Cloudflare Workers. Get an API key from the
console at <https://agents.camelai.dev/console> and export it as
`CAMELAI_API_KEY`.

```ts
import { Agents, schema, tool } from "@camelai/agent-runtime";

const agents = new Agents();

const weather = tool({
  description: "Today's weather in a city",
  input: schema.Object({ city: schema.String() }),
  execute: ({ city }) => ({ city, forecast: "sunny", highC: 24 }), // runs here, in your process
});

const agent = await agents.upsert("quickstart", {
  model: "anthropic/claude-sonnet-5",
  instructions: "You are a concise assistant.",
  tools: { weather },
});

const run = await agent.run("Should I bring an umbrella in Lisbon today?");
console.log(run.text);

await agents.close();
```

- **Keyed agents.** `upsert(key, config)` makes the agent for your key, or brings
  the existing one to `config`; its history and files last until you delete it.
- **Runs.** `run()` resolves with `{ status, text, inputs, error, toolErrors, … }`
  and throws `RunError` on failure (unless `throwOnError: false`). No timeout: pass
  an `AbortSignal` to stop waiting. `stream()` yields text, tool calls and results
  as they happen, then the run.
- **People in the loop.** A tool with `needsApproval: true` waits for approval;
  `run.inputs[0].answer(true, { from })` resumes the run.
- **Tools.** Each call's `context.idempotencyKey` is stable across retries;
  `timeoutMs` and `context.progress()` handle long calls. One process at a time
  serves an agent's tools; serverless and multi-user backends serve them over
  HTTP with `serveTools` (`@camelai/agent-runtime/server`).
- **Browsers.** `watchAgent` (`@camelai/agent-runtime/watch`) shows an agent
  live with a browser token your server mints.

Documentation: [Quickstart](https://agents.camelai.dev/docs/quickstart.md),
[Concepts](https://agents.camelai.dev/docs/concepts.md),
[SDK reference](https://agents.camelai.dev/docs/reference/sdk.md),
and all of it as Markdown at <https://agents.camelai.dev/llms.txt>.

`AgentRuntime` and `AgentClient`, the lower-level interface the SDK is built on,
remain available. See the SDK reference's "Changes in 0.9" when upgrading.
