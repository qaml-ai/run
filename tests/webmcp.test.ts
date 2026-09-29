import { test } from "node:test";
import assert from "node:assert/strict";
import { Api } from "../packages/cli/src/api.ts";
import { tools } from "../packages/cli/src/tools.ts";
import { registerTools, webMcpTool, type ModelContext, type WebMcpTool } from "../console/web/lib/webmcp.ts";
import { OPERATOR, lastUser, runtime } from "./runtime-server.ts";

/** A browser's model context, as the WebMCP spec has it, recording what the page registers and unregisters. */
function fakeContext() {
  const registered = new Map<string, WebMcpTool>();
  const unregistered: string[] = [];
  const context: ModelContext = {
    registerTool(tool, options) {
      if (registered.has(tool.name)) throw new Error(`${tool.name} is registered already`);
      registered.set(tool.name, tool);
      options?.signal?.addEventListener("abort", () => registered.delete(tool.name));
      return Promise.resolve();
    },
    unregisterTool(name) { unregistered.push(name); },
  };
  return { context, registered, unregistered };
}

test("every tool has a JSON Schema WebMCP can take, and consequential ones are marked", () => {
  const list = tools(() => { throw new Error("not called"); });
  for (const tool of list) {
    const described = webMcpTool(tool);
    assert.equal((described.inputSchema as any).type, "object", tool.name);
    assert.equal(described.annotations.consequentialHint, !described.annotations.readOnlyHint, tool.name);
  }
  const deploy = webMcpTool(list.find(tool => tool.name === "deploy")!);
  assert.deepEqual((deploy.inputSchema as any).required, ["manifest"], "in the browser, deploy takes the manifest itself");
  assert.equal("file" in (deploy.inputSchema as any).properties, false);
  assert.equal(webMcpTool(list.find(tool => tool.name === "list_agents")!).annotations.readOnlyHint, true);
  assert.equal(webMcpTool(list.find(tool => tool.name === "delete_agent")!).annotations.consequentialHint, true);
});

test("the console registers the tools with the browser, runs them as the signed-in tenant, and unregisters on sign-out", async t => {
  const r = await runtime(t, body => ({ role: "assistant", content: `echo: ${lastUser(body)}` }));
  const { context, registered, unregistered } = fakeContext();
  const controller = new AbortController();
  const names = await registerTools(controller.signal, context, () => new Api({ url: r.base, apiKey: OPERATOR }));
  assert.equal(names.length, tools(() => new Api({ url: r.base })).length);
  assert.deepEqual([...registered.keys()], names);

  const call = async (name: string, input: Record<string, unknown> = {}) => {
    const result = await registered.get(name)!.execute(input, { signal: new AbortController().signal });
    return { isError: !!result.isError, text: result.content[0].text };
  };
  assert.equal(JSON.parse((await call("whoami")).text).tenant, "alice");
  const deployed = await call("deploy", { manifest: "key: web\nsystemPrompt: Hi.\nagents: [{ key: web-1 }]\n" });
  assert.equal(deployed.isError, false, deployed.text);
  assert.equal(JSON.parse((await call("run_agent", { agent: "web-1", message: "from the browser" })).text).text, "echo: from the browser");
  // Arguments are checked in the page too, and the browser reads no files through deploy.
  assert.match((await call("run_agent", { agent: "web-1" })).text, /message/);
  assert.match((await call("deploy", { manifest: "key: x\nsystemPromptFile: secrets.txt\n" })).text, /reads no files/);

  controller.abort();
  assert.equal(registered.size, 0, "the signal unregisters them");
  assert.deepEqual(unregistered, names, "and so does unregisterTool, where the browser has it");
});

test("in the console, the tools authenticate with the session cookie and the console header, not a key", async t => {
  const r = await runtime(t, body => ({ role: "assistant", content: `echo: ${lastUser(body)}` }));
  const signIn = await fetch(`${r.base}/console/auth/token`, { method: "POST", headers: { "Content-Type": "application/json", "X-Agent-Runtime-Console": "1" }, body: JSON.stringify({ token: OPERATOR }) });
  const cookie = signIn.headers.get("set-cookie")!.split(";")[0];
  const { context, registered } = fakeContext();
  // What consoleApi() makes in the browser, where the cookie goes by itself.
  await registerTools(new AbortController().signal, context, () => new Api({ url: r.base, headers: { "X-Agent-Runtime-Console": "1", Cookie: cookie } }));
  const created = await registered.get("create_agent")!.execute({ key: "by-cookie", systemPrompt: "Hi." });
  assert.equal(created.isError, undefined, created.content[0].text);
  assert.equal(JSON.parse((await registered.get("whoami")!.execute({})).content[0].text).via, "console");
  // Without the console header a cookie cannot change anything.
  const { context: bare, registered: bareTools } = fakeContext();
  await registerTools(new AbortController().signal, bare, () => new Api({ url: r.base, headers: { Cookie: cookie } }));
  assert.match((await bareTools.get("create_agent")!.execute({ key: "no-header", systemPrompt: "Hi." })).content[0].text, /^403/);
});

test("without a model context, nothing is registered", async () => {
  assert.deepEqual(await registerTools(new AbortController().signal, undefined), []);
});
