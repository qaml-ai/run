import { Agents } from "@camelai/agent-runtime";

const agents = new Agents(); // reads CAMELAI_API_KEY
const agent = await agents.upsert("hello-ts", { model: "openrouter/openai/gpt-6-luna" });
console.log((await agent.run("Say hello in three languages.")).text);
await agents.close();
