import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Api } from "../packages/cli/src/api.ts";
import { main } from "../packages/cli/src/cli.ts";
import { loadManifests } from "../packages/cli/src/manifest.ts";
import { createServer } from "../packages/cli/src/mcp.ts";
import { OPERATOR, lastUser, runtime, toolResults, toolCall, until } from "./runtime-server.ts";

/** The CLI run in-process against `base`, as a script would (JSON out); resolves with its exit code and output. */
function cli(base: string, cwd: string, env: Record<string, string> = {}) {
  return async (...argv: string[]) => {
    const out: string[] = [], err: string[] = [];
    const code = await main(argv, { out: text => out.push(text), err: text => err.push(text), tty: false, cwd, env: { CAMELAI_API_KEY: OPERATOR, CAMELAI_URL: base, CAMELRUN_CONFIG: join(cwd, "credentials.json"), ...env } });
    const text = out.join("\n");
    let json: any;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { code, json, text, err: err.join("\n") };
  };
}

test("the CLI deploys a manifest, runs its agent, and manages agents and definitions", async t => {
  const r = await runtime(t, body => ({ role: "assistant", content: `echo: ${lastUser(body)}` }));
  const dir = mkdtempSync(join(tmpdir(), "camelrun-cli-"));
  const run = cli(r.base, dir, { GREETING: "Hello from the manifest." });

  const me = await run("whoami");
  assert.equal(me.code, 0, me.err);
  assert.equal(me.json.tenant, "alice");

  assert.equal((await run("init", "support")).code, 0);
  assert.match(readFileSync(join(dir, "agent.yaml"), "utf8"), /^key: support$/m);
  assert.equal((await run("init")).code, 1, "init keeps a manifest that is there");

  writeFileSync(join(dir, "prompt.md"), "You are support. ${GREETING}\n");
  writeFileSync(join(dir, "agent.yaml"), [
    "key: support", "name: Support", "systemPromptFile: prompt.md", "builtins: [web_fetch]",
    "agents:", "  - key: support-main", "    systemPromptAppend: Workspace ${WORKSPACE:-default}",
  ].join("\n"));
  // The prompt file is read as is; only the manifest's own strings name environment variables.
  assert.equal(loadManifests(join(dir, "agent.yaml"), { })[0].definition.systemPrompt, "You are support. ${GREETING}");

  const planned = await run("deploy", "--dry-run");
  assert.equal(planned.code, 0, planned.err);
  assert.equal(planned.json[0].status, "planned");
  assert.equal((await r.call("/v1/definitions")).json.length, 0, "a dry run changes nothing");

  const deployed = await run("deploy");
  assert.equal(deployed.code, 0, deployed.err);
  assert.equal(deployed.json[0].status, "created");
  assert.match(deployed.json[0].id, /^def_/);
  assert.deepEqual(deployed.json[0].agents.map((agent: any) => [agent.key, agent.status]), [["support-main", "ready"]]);
  assert.equal((await run("deploy")).json[0].status, "unchanged", "the same manifest is the same revision");

  const reply = await run("run", "support-main", "where", "is", "my", "order?");
  assert.equal(reply.code, 0, reply.err);
  assert.equal(reply.json.status, "completed");
  assert.equal(reply.json.text, "echo: where is my order?");
  assert.match(r.model.bodies.at(-1).messages[0].content, /You are support\. \$\{GREETING\}[\s\S]*Workspace default/);

  const history = await run("history", "support-main");
  assert.deepEqual(history.json.messages.map((message: any) => [message.role, message.text]), [["user", "where is my order?"], ["assistant", "echo: where is my order?"]]);

  // A changed prompt is a new revision; --apply moves the live agent to it.
  writeFileSync(join(dir, "prompt.md"), "You are support, v2.\n");
  const applied = await run("deploy", "--apply");
  assert.equal(applied.code, 0, applied.err);
  assert.equal(applied.json[0].status, "updated");
  assert.equal(applied.json[0].revision, 2);
  assert.equal(applied.json[0].applied.length, 1);
  assert.equal((await run("run", "support-main", "again")).json.text, "echo: again");
  assert.match(r.model.bodies.at(-1).messages[0].content, /You are support, v2\./);

  // An agent that exists is brought to what the manifest now says of it.
  const redeployed = await cli(r.base, dir, { GREETING: "", WORKSPACE: "eu" })("deploy");
  assert.deepEqual(redeployed.json[0].agents[0], { key: "support-main", id: deployed.json[0].agents[0].id, status: "ready", reconfigured: true }, redeployed.text);
  // It lands between the agent's turns, so shortly.
  await until(async () => (await run("agents", "get", "support-main")).json.systemPromptAppend === "Workspace eu", "the agent to be reconfigured");

  const definition = await run("definitions", "get", "support");
  assert.equal(definition.json.id, deployed.json[0].id, "a definition is found by its key");
  assert.equal((await run("definitions", "agents", "support")).json.length, 1);

  // Agents outside a manifest, found by key.
  const created = await run("agents", "create", "scratch", "--prompt", "Be brief.");
  assert.equal(created.code, 0, created.err);
  assert.deepEqual((await run("agents", "list")).json.map((agent: any) => agent.key).sort(), ["scratch", "support-main"]);
  const configured = await run("agents", "configure", "scratch", "--prompt", "Be very brief.");
  assert.equal(configured.json.status, "completed", configured.text);
  const queued = await run("run", "scratch", "hi", "--no-wait");
  assert.equal(queued.json.status, "running");
  assert.equal((await run("runs", "get", "scratch", queued.json.requestId, "--wait", "30")).json.text, "echo: hi");

  const refused = await run("agents", "delete", "scratch");
  assert.equal(refused.code, 1);
  assert.match(refused.err, /--yes/);
  assert.equal((await run("agents", "delete", "scratch", "--yes")).code, 0);
  const missing = await run("run", "scratch", "hi");
  assert.equal(missing.code, 1);
  assert.match(JSON.parse(missing.err).error, /No agent with key "scratch"/);

  // Unset variables and unknown flags are errors before anything is sent.
  writeFileSync(join(dir, "broken.yaml"), "key: broken\nmcpServers:\n  - name: app\n    url: https://example.test/mcp\n    auth: { type: bearer, token: \"${MISSING_TOKEN}\" }\n");
  assert.match((await run("deploy", "broken.yaml")).err, /\$\{MISSING_TOKEN\} is not set/);
  assert.equal((await run("deploy", "--bogus")).code, 1);
});

test("a run waiting on a person exits 2 and resumes once answered", async t => {
  const ask = { questions: [{ question: "Which region?", header: "Region", options: [{ label: "EU" }, { label: "US" }] }] };
  const r = await runtime(t, (body, index) => index === 0 ? toolCall("ask_user", ask) : { role: "assistant", content: `Deploying to ${toolResults(body).at(-1)}` });
  const dir = mkdtempSync(join(tmpdir(), "camelrun-cli-"));
  writeFileSync(join(dir, "agent.yaml"), "key: asker\nbuiltins: [ask_user]\nagents: [{ key: asker-1 }]\n");
  const run = cli(r.base, dir);
  assert.equal((await run("deploy")).code, 0);

  const waiting = await run("run", "asker-1", "deploy it");
  assert.equal(waiting.code, 2, waiting.err);
  assert.equal(waiting.json.status, "input_required");
  const [input] = waiting.json.inputs;
  assert.equal(input.kind, "question");
  assert.equal((await run("inputs")).json[0].id, input.id);

  const resumed = await run("answer", "asker-1", input.id, "EU");
  assert.equal(resumed.code, 0, resumed.err);
  assert.equal(resumed.json.status, "completed");
  assert.match(resumed.json.text, /^Deploying to .*EU/);
});

test("login saves a checked key readable only by its owner", async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "ok" }));
  const dir = mkdtempSync(join(tmpdir(), "camelrun-cli-"));
  const run = cli(r.base, dir, { CAMELAI_API_KEY: "" });
  assert.equal((await run("login", "--api-key", "wrong-key-that-is-at-least-24-chars", "--url", r.base)).code, 1);
  const login = await run("login", "--api-key", OPERATOR, "--url", r.base);
  assert.equal(login.code, 0, login.err);
  assert.equal(statSync(join(dir, "credentials.json")).mode & 0o777, 0o600);
  const saved = cli(r.base, dir, { CAMELAI_API_KEY: "", CAMELAI_URL: "" });
  // Empty variables are unset ones: the saved login answers.
  assert.equal((await main(["whoami"], { out: () => {}, err: () => {}, tty: false, cwd: dir, env: { CAMELRUN_CONFIG: join(dir, "credentials.json") } })), 0);
  assert.equal((await saved("logout")).json.loggedOut, true);
});

test("the MCP server deploys and runs agents for a coding agent", async t => {
  const r = await runtime(t, body => ({ role: "assistant", content: `echo: ${lastUser(body)}` }));
  const dir = mkdtempSync(join(tmpdir(), "camelrun-mcp-"));
  const server = createServer(() => new Api({ url: r.base, apiKey: OPERATOR }), { cwd: dir });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(clientSide);
  t.after(() => client.close());
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result: any = await client.callTool({ name, arguments: args });
    const text = result.content[0].text;
    let json: any;
    try { json = JSON.parse(text); } catch { /* text */ }
    return { isError: !!result.isError, json, text };
  };

  const names = (await client.listTools()).tools.map(tool => tool.name);
  for (const name of ["deploy", "run_agent", "get_run", "list_agents", "answer_input", "read_docs"]) assert.ok(names.includes(name), name);
  assert.match(client.getInstructions() ?? "", /agent\.yaml/);

  const deployed = await call("deploy", { manifest: "key: helper\nname: Helper\nsystemPrompt: You help.\nagents:\n  - key: helper-1\n" });
  assert.equal(deployed.isError, false, deployed.text);
  assert.equal(deployed.json[0].agents[0].status, "ready");

  const ran = await call("run_agent", { agent: "helper-1", message: "ping" });
  assert.equal(ran.json.status, "completed", ran.text);
  assert.equal(ran.json.text, "echo: ping");
  const later = await call("run_agent", { agent: "helper-1", message: "pong", wait: 0 });
  assert.equal(later.json.status, "running");
  assert.equal((await call("get_run", { agent: "helper-1", requestId: later.json.requestId, wait: 30 })).json.text, "echo: pong");

  const missing = await call("get_agent", { agent: "nobody" });
  assert.equal(missing.isError, true);
  assert.match(missing.text, /^404: No agent with key "nobody"/);
  assert.equal((await call("delete_agent", { agent: "helper-1" })).json.deleted, true);
});
