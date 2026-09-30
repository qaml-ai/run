import { Agents } from "@camelai/run";

const agents = new Agents();

// Built-in tools the runtime answers itself: web search and page reading.
const agent = await agents.upsert("research-agent", {
  model: "openrouter/openai/gpt-6-luna",
  instructions: "You are a careful researcher. Search the web, read the best sources with web_fetch, " +
    "then answer in a few short paragraphs. Cite every claim with a numbered [n] and list the URLs under Sources.",
  builtins: ["web_search", "web_fetch"],
});

const question = process.argv.slice(2).join(" ") || "What changed in the most recent Node.js LTS release?";
for await (const part of agent.stream(question)) {
  if (part.type === "text") process.stdout.write(part.text);
  if (part.type === "tool_call") console.log(`→ ${part.name}(${JSON.stringify(part.arguments)})`);
}
console.log();
await agents.close();
