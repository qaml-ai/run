import { test } from "node:test";
import assert from "node:assert/strict";
import { runtime, toolCall, toolResults } from "./runtime-server.ts";

for (const fileTools of [true, false]) test(`js_exec's fs reads and writes the workspace through the file tools, from code (fileTools: ${fileTools})`, async t => {
  const code = `const lines = Array.from({ length: 2500 }, (_, i) => "line " + i).join("\\n") + "\\n" + "é".repeat(100000);
await fs.writeFile("/workspace/notes/big.txt", lines);
const json = { list: Array.from({ length: 20000 }, (_, i) => "item " + i) };
await fs.writeFile("/workspace/notes/one.json", JSON.stringify(json));
await fs.writeFile("/workspace/notes/b.bin", new Uint8Array([0, 255, 1, 254]));
await fs.writeFile("log.txt", "a\\n");
await fs.appendFile("log.txt", "b\\n");
return JSON.stringify({ same: await fs.readFile("/workspace/notes/big.txt", "utf8") === lines, json: JSON.parse(await fs.readFile("/workspace/notes/one.json")).list.length,
  bin: await fs.readFile("/workspace/notes/b.bin", "base64"), log: await fs.readFile("/workspace/log.txt"),
  names: await fs.readdir("/workspace/notes"), exists: [await fs.exists("/workspace/notes/big.txt"), await fs.exists("/workspace/none")] });`;
  const r = await runtime(t, (_body, index) => [toolCall("codemode", { code })][index] ?? { role: "assistant", content: "ok" });
  const agent = (await r.call("/v1/agents", { body: { fileTools } })).json.id;
  await r.prompt(agent, "go");
  assert.match(toolResults(r.model.bodies[1]).at(-1), /\{"same":true,"json":20000,"bin":"AP8B\/g==","log":"a\\nb\\n","names":\["b\.bin","big\.txt","one\.json"\],"exists":\[true,false\]\}/);
});
