import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { cluster, fakeModel, token, until } from "./cluster-helpers.ts";

/** The model request's system text, and its last message's role. */
const systemText = (body: any) => body.messages.filter((message: any) => message.role === "system" || message.role === "developer")
  .map((message: any) => typeof message.content === "string" ? message.content : message.content.map((part: any) => part.text ?? "").join("")).join("\n");
/** Who a request's agent is: its system text and its first message, where a sub-agent of the model's own design has its role. */
const roleText = (body: any) => [systemText(body), ...body.messages.filter((message: any) => message.role === "user").slice(0, 1)
  .map((message: any) => typeof message.content === "string" ? message.content : message.content.map((part: any) => part.text ?? "").join(""))].join("\n");
const toolCalls = (...calls: [string, unknown, string][]) => ({ role: "assistant", tool_calls: calls.map(([name, args, id], index) => ({ index, id, type: "function", function: { name, arguments: JSON.stringify(args) } })) });
const toolText = (body: any) => body.messages.filter((message: any) => message.role === "tool").map((message: any) => typeof message.content === "string" ? message.content : JSON.stringify(message.content)).join("\n");

/** The tenant's REST API on a node. */
const api = (url: string) => async (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") => {
  const response = await fetch(url + path, { method, headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  try { return { status: response.status, json: JSON.parse(text) }; } catch { return { status: response.status, json: text as any }; }
};
/** A request's record once it settles, read through any node. */
const settled = async (call: ReturnType<typeof api>, agent: string, request: string, ms = 60_000) => {
  let record: any;
  await until(async () => { record = (await call(`/v1/agents/${agent}/requests/${request}?wait=5`)).json; return record?.state === "completed"; }, `request ${request} settled`, ms);
  return record;
};

test("a codemode script resumes after node loss without remaking its finished delegate", { timeout: 120_000 }, async t => {
  const c = await cluster(t);
  const blocked = Promise.withResolvers<void>();
  let first = 0, second = 0;
  const model = await fakeModel(t, async body => {
    if (roleText(body).includes("FIRST")) { first++; return { role: "assistant", content: "first answer" }; }
    if (roleText(body).includes("SECOND")) {
      if (second++ === 0) { blocked.resolve(); return undefined; }
      return { role: "assistant", content: "second answer" };
    }
    return body.messages.at(-1).role === "tool" ? { role: "assistant", content: toolText(body) }
      : toolCalls(["codemode", { code: `const first = await tools.delegate({ instructions: "You are FIRST.", task: "work" });
const second = await tools.delegate({ instructions: "You are SECOND.", task: "work" });
return [first.text, second.text];` }, "code"]);
  });
  const env = { ...model.env, AGENT_ORPHAN_SWEEP_MS: "500" };
  const a = await c.start("a", env), b = await c.start("b", env);
  const onA = api(a.url), onB = api(b.url);
  const parent = (await onA("/v1/agents", { builtins: ["delegate"], delegate: { instructions: true } })).json.id;
  assert.equal((await onA(`/v1/agents/${parent}/prompt`, { text: "go", requestId: "turn" })).status, 202);
  await blocked.promise;
  a.child.kill("SIGKILL");
  await once(a.child, "close");
  const record = await settled(onB, parent, "turn", 90_000);
  assert.equal(record.error, undefined, JSON.stringify(record));
  assert.match(record.outcome.result.reply, /first answer.*second answer/s);
  assert.equal(first, 1);
  const children = (await c.db.query("select child, request_id, tool_call_id from agent_children where parent = $1", [parent])).rows;
  assert.equal(children.length, 2);
  assert.ok(children.every(row => row.tool_call_id === "code"));
  for (const row of children) {
    const child = (await onB(`/v1/agents/${row.child}`)).json;
    assert.equal(child.requests.filter((request: any) => request.method === "prompt").length, 1);
  }
});

/** The pid of agent `id`'s own process on this machine (process hosting: its working directory is the agent's). */
async function agentProcess(id: string): Promise<number | undefined> {
  const { readdir, readlink, readFile } = await import("node:fs/promises");
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      if ((await readlink(`/proc/${entry}/cwd`)).endsWith(`/${id}`) && (await readFile(`/proc/${entry}/cmdline`, "utf8")).includes("agent-child")) return Number(entry);
    } catch { /* gone, or not ours */ }
  }
  return undefined;
}

test("a script waiting on a child when its agent's process dies: the turn ends there, and the child is stopped, not left running unread", { timeout: 120_000, skip: process.platform !== "linux" && "needs /proc" }, async t => {
  const c = await cluster(t);
  const blocked = Promise.withResolvers<void>();
  let child = 0;
  const model = await fakeModel(t, async body => {
    if (roleText(body).includes("CHILD")) { child++; blocked.resolve(); return undefined; }
    return body.messages.at(-1).role === "tool" ? { role: "assistant", content: toolText(body) }
      : toolCalls(["codemode", { code: `return (await tools.delegate({ instructions: "You are CHILD.", task: "work" })).text;` }, "code"]);
  });
  const a = await c.start("a", { ...model.env, AGENT_HOSTING: "process" });
  const onA = api(a.url);
  const parent = (await onA("/v1/agents", { builtins: ["delegate"], delegate: { instructions: true } })).json.id;
  assert.equal((await onA(`/v1/agents/${parent}/prompt`, { text: "go", requestId: "turn" })).status, 202);
  await blocked.promise;
  let pid: number | undefined;
  await until(async () => (pid = await agentProcess(parent)) !== undefined, "the parent's process");
  process.kill(pid!, "SIGKILL");
  // A process that dies ends its turn: no replay goes on with the script, so its child is stopped as at a script's end.
  assert.match((await settled(onA, parent, "turn", 90_000)).error, /Process exited/);
  const kept = (await c.db.query("select child from agent_children where parent = $1", [parent])).rows[0].child;
  await until(async () => {
    const turn = ((await onA(`/v1/agents/${kept}`)).json.requests ?? []).find((request: any) => request.id.startsWith("delegate_"));
    return turn?.state === "completed" && turn.outcome?.result?.code === "aborted";
  }, "the child's turn aborted");
  assert.equal(child, 1, "the child was asked once");
});
