import {portedTest} from '../ported.ts';
const test = portedTest("volumes", "tests/projects.test.ts");
import assert from 'node:assert/strict';
import {AgentRuntime,publishTool,type ProjectFile} from '../../../clients/typescript.ts';
import {serveTools} from '../../../clients/server.ts';
import {testRuntime} from '../../../clients/testing.ts';
import {OPERATOR,runtime} from '../support.ts';

const validate = (files: ProjectFile[]) => files.flatMap(file =>
  file.path.includes("secret") ? [{ path: file.path, message: "no secrets in a project" }]
  : file.path.endsWith(".ts") && !file.text?.includes("export") ? [{ path: file.path, line: 1, message: "exports nothing" }] : []);

test("publishTool finds the project from the call's identity, never its arguments, and tells the model what to fix", async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "ok" }));
  const sdk = new AgentRuntime({ url: r.base, apiKey: OPERATOR });
  const projects = new Map<string, string>();
  for (const bot of ["a", "b"]) projects.set(bot, (await sdk.projects.create({ key: `bot-${bot}`, template: { "bot.ts": `export const name = "${bot}";\n` } })).id);
  const rt = await testRuntime();
  const stored: string[] = [];
  const handler = serveTools({
    publish: publishTool({
      project: identity => sdk.projects.get(projects.get(String(identity.context.bot))!),
      validate, store: files => { stored.push(files.map(file => file.text).join("")); },
    }),
  }, rt.options);
  const published = await rt.callTool(handler, "https://app.test/mcp", "publish", {}, { subject: "owner", context: { bot: "b" } });
  assert.equal(published.isError, undefined, JSON.stringify(published));
  assert.deepEqual(stored, ['export const name = "b";\n'], "bot b's files, as its identity says");
  // Arguments are not taken: the tool's input has none, so naming a project is refused.
  await assert.rejects(rt.callTool(handler, "https://app.test/mcp", "publish", { project: projects.get("a") }, { subject: "owner", context: { bot: "b" } }), /arguments failed validation/);
  assert.equal(stored.length, 1);

  await sdk.projects.get(projects.get("a")!).volume.write("secret.ts", "export const key = 1;\n");
  const refused = await rt.callTool(handler, "https://app.test/mcp", "publish", {}, { subject: "owner", context: { bot: "a" } });
  assert.equal(refused.isError, true);
  assert.match(String(refused.content[0].text), /Not published\. Fix these and publish again:\n\/secret\.ts: no secrets in a project/);

  // A client that sends no idempotency key and reuses JSON-RPC id 1 for every call: each publish is its own, never the
  // first one's version stored again with its old files.
  const bare = async () => {
    const response = await handler(await rt.request("https://app.test/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "publish", arguments: {} } }, { subject: "owner", context: { bot: "b" } }));
    return ((await response.json()) as any).result;
  };
  const b = sdk.projects.get(projects.get("b")!);
  await b.volume.write("bot.ts", "export const name = \"b2\";\n");
  assert.equal((await bare()).isError, undefined);
  await b.volume.write("bot.ts", "export const name = \"b3\";\n");
  assert.equal((await bare()).isError, undefined);
  assert.deepEqual(stored.slice(-2), ['export const name = "b2";\n', 'export const name = "b3";\n']);
  // A retry with the runtime's key publishes once.
  const versions = (await b.versions()).length;
  for (let i = 0; i < 2; i++) await rt.callTool(handler, "https://app.test/mcp", "publish", {}, { subject: "owner", context: { bot: "b" } }, { idempotencyKey: "turn-1:call-1" });
  assert.equal((await b.versions()).length, versions + 1);
});
