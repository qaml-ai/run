import { test } from "node:test";
import assert from "node:assert/strict";
import { runtime, toolCall, toolResults } from "./runtime-server.ts";

for (const fileTools of [true, false]) test(`js_exec's fs reads and writes the workspace through the file tools, from code (fileTools: ${fileTools})`, async t => {
  const code = `const lines = Array.from({ length: 2500 }, (_, i) => "line " + i).join("\\n");
await fs.writeFile("/workspace/notes/big.txt", lines);
const back = await fs.readFile("/workspace/notes/big.txt", "utf8");
return JSON.stringify({ same: back === lines, names: await fs.readdir("/workspace/notes"), exists: await fs.exists("/workspace/notes/big.txt") });`;
  const r = await runtime(t, (_body, index) => [toolCall("codemode", { code })][index] ?? { role: "assistant", content: "ok" });
  const agent = (await r.call("/v1/agents", { body: { fileTools } })).json.id;
  await r.prompt(agent, "go");
  assert.match(toolResults(r.model.bodies[1]).at(-1), /\{"same":true,"names":\["big\.txt"\],"exists":true\}/);
});
