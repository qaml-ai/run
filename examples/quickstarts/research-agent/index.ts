import { Agents, type DefinitionInput } from "@camelai/agent-runtime";

const agents = new Agents();

// Built-in tools come from a definition. Definitions have no key of their own, so find ours by name.
const config: DefinitionInput = {
  name: "research-agent",
  model: "openrouter/openai/gpt-6-luna",
  systemPrompt: "You are a careful researcher. Search the web, read the best sources with web_fetch, " +
    "then answer in a few short paragraphs. Cite every claim with a numbered [n] and list the URLs under Sources.",
  builtins: ["web_search", "web_fetch"],
};
const existing = (await agents.runtime.definitions()).find((d) => d.name === config.name);
const definition = existing
  ? await agents.runtime.updateDefinition(existing.id, config)
  : await agents.runtime.createDefinition(config);

const agent = await agents.upsert("research-agent", { definition: definition.id });

const question = process.argv.slice(2).join(" ") || "What changed in the most recent Node.js LTS release?";
for await (const part of agent.stream(question)) {
  if (part.type === "text") process.stdout.write(part.text);
  if (part.type === "tool_call") console.log(`→ ${part.name}(${JSON.stringify(part.arguments)})`);
}
console.log();
await agents.close();
