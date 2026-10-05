import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Api } from "../packages/cli/src/api.ts";
import { main } from "../packages/cli/src/cli.ts";
import { resolve } from "../packages/cli/src/config.ts";
import { loadManifests } from "../packages/cli/src/manifest-files.ts";
import { parseManifest } from "../packages/cli/src/manifest.ts";
import { createServer } from "../packages/cli/src/mcp.ts";
import { OPERATOR, lastUser, runtime, toolResults, toolCall, until } from "./runtime-server.ts";
import { otlpReceiver } from "./otlp-receiver.ts";

/** The CLI run in-process against `base`, as a script would (JSON out); resolves with its exit code and output. */
function cli(base: string, cwd: string, env: Record<string, string> = {}) {
  return async (...argv: string[]) => {
    const out: string[] = [], err: string[] = [];
    const code = await main(argv, { out: text => out.push(text), err: text => err.push(text), tty: false, cwd, env: { CAMELAI_API_KEY: OPERATOR, CAMELAI_BASE_URL: base, CAMELRUN_CONFIG: join(cwd, "credentials.json"), ...env } });
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

  const forked = await run("agents", "fork", "scratch", "--key", "scratch-fork", "--at", "1");
  assert.equal(forked.code, 0, forked.err);
  assert.equal(forked.json.forkedFrom.atMessage, 1);
  assert.equal(forked.json.token, undefined, "the fork's token is not printed");
  assert.equal((await run("history", "scratch-fork")).json.messages.length, 2);
  assert.equal((await run("agents", "fork", "scratch", "--key", "scratch-fork")).json.id, forked.json.id, "the same key is the same fork");

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

test("telemetry: set, get, test and clear from the CLI, never printing a header's value; run --traceparent continues the caller's trace", async t => {
  const receiver = await otlpReceiver(t);
  const r = await runtime(t, () => ({ role: "assistant", content: "ok" }), { AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32", AGENT_TELEMETRY_INTERVAL_MS: "100" });
  const dir = mkdtempSync(join(tmpdir(), "camelrun-cli-"));
  const run = cli(r.base, dir);
  const SECRET = "otlp-cli-secret-value";
  /** The same command as a person runs it, in a terminal: human output. */
  const human = async (...argv: string[]) => {
    const out: string[] = [], err: string[] = [];
    const code = await main(argv, { out: text => out.push(text), err: text => err.push(text), tty: true, cwd: dir, env: { CAMELAI_API_KEY: OPERATOR, CAMELAI_BASE_URL: r.base, CAMELRUN_CONFIG: join(dir, "credentials.json") } });
    return { code, text: out.join("\n"), err: err.join("\n") };
  };
  const printed: string[] = [];
  const both = async (...argv: string[]) => {
    const [json, text] = [await run(...argv), await human(...argv)];
    printed.push(json.text, json.err, text.text, text.err);
    return { json, text };
  };

  const off = await both("telemetry", "get");
  assert.equal(off.json.code, 0, off.json.err);
  assert.equal(off.json.json, null);
  assert.match(off.text.text, /Telemetry is off/);

  for (const [argv, why] of [[["--header", "no-equals-sign"], /name=value/], [["--protocol", "grpc"], /http\/protobuf or http\/json/], [["--sample-rate", "2"], /0 to 1/], [["--content", "--no-content"], /not both/]] as const) {
    const refused = await human("telemetry", "set", receiver.url, ...argv);
    assert.equal(refused.code, 1);
    assert.match(refused.err, why);
    printed.push(refused.err);
  }

  // The secret from the environment, as the docs show first; a plain value works too.
  const withKey = cli(r.base, dir, { OTLP_KEY: SECRET });
  const missing = await withKey("telemetry", "set", receiver.url, "--header", "x-api-key=@env:NOT_SET");
  assert.equal(missing.code, 1);
  assert.match(missing.err, /NOT_SET is not set/);
  const viaEnv = await withKey("telemetry", "set", receiver.url, "--header", "x-api-key=@env:OTLP_KEY", "--header", "x-team=t1", "--protocol", "http/json", "--sample-rate", "1", "--no-content");
  printed.push(viaEnv.text, viaEnv.err);
  assert.equal(viaEnv.code, 0, viaEnv.err);
  const set = await both("telemetry", "set", receiver.url, "--header", `x-api-key=${SECRET}`, "--header", "x-team=t1", "--protocol", "http/json", "--sample-rate", "1", "--no-content");
  assert.equal(set.json.code, 0, set.json.err);
  assert.deepEqual({ ...set.json.json, createdAt: 0, updatedAt: 0 }, {
    endpoint: `${receiver.url}/v1/traces`, protocol: "http/json", sampleRate: 1, include: { content: false }, headers: ["x-api-key", "x-team"],
    createdAt: 0, updatedAt: 0, setBy: "operator", status: { lastExportAt: null, lastError: null, lastErrorAt: null },
  });
  assert.match(set.text.text, /Exporting to .*\/v1\/traces \(http\/json, sample rate 1, content not included\)\nHeaders: x-api-key, x-team/);
  assert.deepEqual((await run("telemetry", "get")).json.headers, ["x-api-key", "x-team"]);
  assert.match((await both("telemetry", "get")).text.text, /Headers: x-api-key, x-team/);

  const tested = await both("telemetry", "test");
  assert.equal(tested.json.code, 0, tested.json.err);
  assert.equal(tested.json.json.ok, true);
  assert.match(tested.text.text, /^Sent: the endpoint answered 200\. Find trace [0-9a-f]{32}/);
  await until(() => receiver.requests.length >= 2, "both test spans");
  assert.equal(receiver.requests[0].headers["x-api-key"], SECRET, "the stored header goes to the endpoint");

  // Content on: a later set without an endpoint or --header changes only that, keeping the rest.
  const partial = (await run("telemetry", "set", "--content")).json;
  assert.deepEqual([partial.include, partial.protocol, partial.headers], [{ content: true }, "http/json", ["x-api-key", "x-team"]]);

  // A header from standard input.
  const out: string[] = [], err: string[] = [];
  const piped = await main(["telemetry", "set", "--header", "x-api-key=@stdin"], { out: text => out.push(text), err: text => err.push(text), tty: false, cwd: dir,
    env: { CAMELAI_API_KEY: OPERATOR, CAMELAI_BASE_URL: r.base, CAMELRUN_CONFIG: join(dir, "credentials.json") }, stdin: async () => "stdin-secret-value\n" });
  assert.equal(piped, 0, err.join("\n"));
  printed.push(...out, ...err);
  assert.deepEqual(JSON.parse(out.join("\n")).headers, ["x-api-key"]);
  const before = receiver.requests.length;
  assert.equal((await run("telemetry", "test")).json.ok, true);
  await until(() => receiver.requests.length > before, "a test span with the piped header");
  assert.equal(receiver.requests.at(-1)!.headers["x-api-key"], "stdin-secret-value", "the trailing newline is not part of it");

  // A run sent with --traceparent continues that trace.
  assert.equal((await run("agents", "create", "traced")).code, 0);
  const traceId = "e".repeat(31) + "5";
  const traced = await run("run", "traced", "hi", "--traceparent", `00-${traceId}-00f067aa0ba902b7-01`);
  assert.equal(traced.json.status, "completed", traced.text);
  const agent = (await run("agents", "list")).json.find((item: any) => item.key === "traced").id;
  assert.equal((await r.call(`/v1/agents/${agent}/requests/${traced.json.requestId}`)).json.trace.traceId, traceId);

  const cleared = await run("telemetry", "clear");
  assert.deepEqual(cleared.json, { deleted: true });
  assert.match((await human("telemetry", "clear")).text, /was not set/);
  assert.equal((await run("telemetry", "get")).json, null);
  assert.ok(printed.every(text => !text.includes(SECRET) && !text.includes("stdin-secret-value")), "a header's value is never printed");
});

test("login saves a checked key readable only by its owner", async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "ok" }));
  const dir = mkdtempSync(join(tmpdir(), "camelrun-cli-"));
  const run = cli(r.base, dir, { CAMELAI_API_KEY: "" });
  assert.equal((await run("login", "--api-key", "wrong-key-that-is-at-least-24-chars", "--url", r.base)).code, 1);
  const login = await run("login", "--api-key", OPERATOR, "--url", r.base);
  assert.equal(login.code, 0, login.err);
  assert.equal(statSync(join(dir, "credentials.json")).mode & 0o777, 0o600);
  const saved = cli(r.base, dir, { CAMELAI_API_KEY: "", CAMELAI_BASE_URL: "" });
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
  const forked = await call("fork_agent", { agent: "helper-1", key: "helper-fork" });
  assert.equal(forked.isError, false, forked.text);
  assert.equal(forked.json.forkedFrom.atMessage, 3);
  assert.equal(forked.json.token, undefined, "a tool result never carries the fork's token");
  assert.equal((await call("agent_history", { agent: "helper-fork" })).json.messages.length, 4);
  assert.equal((await call("delete_agent", { agent: "helper-1" })).json.deleted, true);
});

test("the CLI reads the runtime's URL from CAMELAI_BASE_URL, as the SDKs do, or CAMELAI_URL", () => {
  const env = { CAMELAI_API_KEY: "k".repeat(32), CAMELRUN_CONFIG: join(mkdtempSync(join(tmpdir(), "camelrun-env-")), "none.json") };
  assert.equal(resolve({}, { ...env, CAMELAI_BASE_URL: "http://runtime:8790" }).url, "http://runtime:8790");
  assert.equal(resolve({}, { ...env, CAMELAI_URL: "http://old:8790" }).url, "http://old:8790");
  assert.equal(resolve({ url: "http://flag" }, { ...env, CAMELAI_BASE_URL: "http://runtime:8790" }).url, "http://flag");
});

test("a manifest's delegate settings bring their builtin", () => {
  const manifest = parseManifest({ key: "lead", builtins: ["web_search"], delegate: { agents: ["researcher"] } }, "lead.yaml");
  assert.deepEqual(manifest.definition.builtins, ["web_search", "delegate"]);
});
