/**
 * One MCP server for every user: the runtime signs a token for each tool call naming whom the agent
 * acts for (`subject`), who is acting (`actor`, or a prompt's `from.id`) and the claims its creator
 * set (`context`). serveTools verifies it; each tool reads `identity` and scopes what it touches.
 * Nothing per user is stored in the runtime.
 *
 *   AGENT_URL=https://agents.camelai.dev AGENT_RUNTIME_TOKEN=... \
 *   PUBLIC_URL=https://todos.example.com node --experimental-strip-types examples/team-todos.ts
 *
 * The runtime must reach this server at PUBLIC_URL (a tunnel works for trying it out).
 */
import { createServer } from "node:http";
import { AgentRuntime, nodeListener, schema, tool } from "../clients/node.ts";
import { serveTools } from "../clients/server.ts";

// The application's data: every to-do belongs to one person on one team.
const todos = [
  { id: "t1", owner: "alice", team: "acme", text: "Draft the Q4 roadmap", done: false },
  { id: "t2", owner: "bob", team: "acme", text: "Fix the flaky billing test", done: false },
  { id: "t3", owner: "alice", team: "globex", text: "Another team's to-do", done: false },
];

const tools = {
  list_todos: tool({
    description: "The current user's to-dos on their team",
    input: schema.Object({}, { additionalProperties: false }),
    // Who is asking comes from the runtime's signed token, never from the model's arguments.
    execute: (_args, { identity }) => todos.filter(todo => todo.owner === identity!.user && todo.team === identity!.context.team),
  }),
  complete_todo: tool({
    description: "Mark one of the current user's to-dos done",
    input: schema.Object({ id: schema.String() }, { additionalProperties: false }),
    execute: ({ id }, { identity }) => {
      const todo = todos.find(entry => entry.id === id && entry.owner === identity!.user && entry.team === identity!.context.team);
      if (!todo) throw new Error(`You have no to-do ${id}`);
      todo.done = true;
      return todo;
    },
  }),
};

// Serve them, trusting only the runtime's tokens for this server's URL.
const runtimeUrl = process.env.AGENT_URL ?? "https://agents.camelai.dev";
const publicUrl = process.env.PUBLIC_URL ?? "http://127.0.0.1:8788";
const server = createServer(nodeListener(serveTools(tools, { runtime: runtimeUrl }), { origin: publicUrl }));
server.listen(Number(new URL(publicUrl).port || 8788));

// One definition names the server; each team gets an agent whose context says which team it is.
const runtime = new AgentRuntime({ url: runtimeUrl });
const definition = await runtime.createDefinition({
  name: "Team to-dos", systemPrompt: "You help people with their to-dos. Keep replies short.",
  mcpServers: [{ name: "todos", url: `${publicUrl}/mcp`, auth: { type: "runtime" } }],
});
const agent = await runtime.createAgent({ definition: definition.id, subject: "team-acme", context: { team: "acme" }, tools: {} });
try {
  // Whoever sends a message acts: Alice sees her to-dos, Bob his, on the same agent.
  for (const [who, text] of [["alice", "What's on my plate?"], ["bob", "What's on my plate? Complete t1 for me."]]) {
    const result = await agent.prompt(text, { from: { id: who, name: who[0].toUpperCase() + who.slice(1) } });
    console.log(`${who}: ${text}\n  → ${result?.reply ?? JSON.stringify(result)}`);
  }
  console.log(todos.map(todo => `${todo.id} ${todo.owner} ${todo.done ? "[x]" : "[ ]"} ${todo.text}`).join("\n"));
} finally {
  await agent.destroy();
  await runtime.deleteDefinition(definition.id);
  server.close();
}
