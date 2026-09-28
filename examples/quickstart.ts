/**
 * The quickstart: an agent with one tool of yours, which answers and exits.
 *
 *   CAMELAI_API_KEY=art_… node --experimental-strip-types examples/quickstart.ts
 *
 * In your app: import { Agents, schema, tool } from "@camelai/agent-runtime";
 */
import { Agents, schema, tool } from "../clients/typescript.ts";

const agents = new Agents(); // reads CAMELAI_API_KEY (and CAMELAI_BASE_URL, for a runtime of your own)

// A tool is an ordinary function: it runs here, in your process.
const weather = tool({
  description: "Today's weather in a city",
  input: schema.Object({ city: schema.String() }),
  execute: ({ city }) => ({ city, forecast: "sunny", highC: 24 }),
});

// The same key is the same agent, with its history, every time you run this.
const agent = await agents.upsert("quickstart", {
  model: process.env.AGENT_MODEL ?? "anthropic/claude-sonnet-5-5",
  instructions: "You are a concise assistant.",
  tools: { weather },
});

const run = await agent.run("Should I bring an umbrella in Lisbon today?");
console.log(run.text);

await agents.close();
