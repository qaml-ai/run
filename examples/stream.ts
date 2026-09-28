/**
 * Stream a run to the terminal: its text as the model writes it, each tool call and result, then how it ended.
 *
 *   CAMELAI_API_KEY=art_… node --experimental-strip-types examples/stream.ts
 */
import { Agents, schema, tool } from "../clients/typescript.ts";

const stock: Record<string, number> = { "BEAN-01": 8, "OAT-02": 6, "CUP-03": 200 };
const agents = new Agents();
const agent = await agents.upsert("stream-example", {
  model: process.env.AGENT_MODEL ?? "anthropic/claude-sonnet-5",
  instructions: "You manage a cafe's stock. Use the tools; keep replies to two sentences.",
  tools: {
    stock_level: tool({
      description: "How many of a SKU are in stock",
      input: schema.Object({ sku: schema.String() }),
      execute: ({ sku }) => {
        if (!(sku in stock)) throw new Error(`Unknown SKU ${sku}; known: ${Object.keys(stock).join(", ")}`);
        return { sku, stock: stock[sku] };
      },
    }),
  },
});

try {
  for await (const part of agent.stream("Which of BEAN-01, OAT-02 and CUP-03 are below 10?")) {
    if (part.type === "text") process.stdout.write(part.text);
    else if (part.type === "tool_call") console.log(`\n→ ${part.name}(${JSON.stringify(part.arguments)})`);
    else if (part.type === "tool_result") console.log(`← ${part.isError ? "error: " : ""}${part.output}`);
    else if (part.type === "done") console.log(`\n\n(${part.run.status})`);
  }
} finally {
  await agents.close();
}
