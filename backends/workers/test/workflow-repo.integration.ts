import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer as createHttpServer } from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startFixture } from "./fixture.ts";

test("workflows: children edit branches of a repo with their file tools, commit() lands them (one conflicts)", {
  timeout: 600_000,
}, async (t) => {
  // The children's model: "EDIT <path> <text>" makes one write tool call, then says it is done. The owner agent's: start
  // the workflow (SCRIPT) with its workflows builtin, then say which it started.
  let script = "";
  const textOf = (message: any) => typeof message?.content === "string" ? message.content : (message?.content ?? []).map((part: any) => part.text ?? "").join("\n");
  const model = createHttpServer(async (request, response) => {
    let raw = ""; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    const last = body.messages.at(-1), user = textOf(body.messages.filter((message: any) => message.role === "user").at(-1));
    const edit = /EDIT (\S+) (\S+)/.exec(user);
    const system = body.messages.filter((message: any) => message.role === "system").map(textOf).join("\n");
    const owner = !system.includes("You are a worker in a workflow") && user.startsWith("START");
    const delta = owner
      ? last.role === "tool" ? { role: "assistant", content: `STARTED ${textOf(last)}` }
        : { role: "assistant", tool_calls: [{ index: 0, id: "start-1", type: "function", function: { name: "workflow_start", arguments: JSON.stringify({ script, args: JSON.parse(user.slice(6)), budgetUsd: 5, name: "edit the repo" }) } }] }
      : last.role !== "tool" && edit
      ? { role: "assistant", tool_calls: [{ index: 0, id: "write-1", type: "function", function: { name: "write", arguments: JSON.stringify({ path: edit[1], content: edit[2] }) } }] }
      : { role: "assistant", content: `edited ${edit?.[1] ?? "nothing"}` };
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const base = { id: "repo-model", object: "chat.completion.chunk", created: 1, model: "repo-model" };
    response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" in delta ? "tool_calls" : "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  model.listen(0, "127.0.0.1"); await once(model, "listening");
  t.after(() => { model.closeAllConnections(); return new Promise<void>(resolve => model.close(() => resolve())); });
  const fixture = await startFixture({ entrypoint: fileURLToPath(new URL('./camelfs-worker.ts',import.meta.url)), vars: { TEST_MODEL: "0", MODEL: "openai/gpt-4o-mini", AGENT_WORKFLOW_TENANTS: "*",
    AGENT_WORKFLOW_CLASS_MODELS: JSON.stringify({ fast: "repo-fixture/repo-model", strong: "repo-fixture/repo-model", max: "repo-fixture/repo-model" }) } });
  t.after(() => fixture.stop());
  const call = async (path: string, body?: unknown, raw?: string, method?: string) => {
    const response = await fetch(fixture.url + path, {
      method: method ?? (raw !== undefined ? "PUT" : body === undefined ? "GET" : "POST"),
      headers: { authorization: `Bearer ${fixture.token}`, "content-type": raw !== undefined ? "text/plain" : "application/json" },
      ...(raw !== undefined ? { body: raw } : body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(300_000),
    });
    const text = await response.text();
    assert.ok(response.ok, `${path}: ${response.status} ${text}\n${fixture.worker.logs().slice(-4000)}`);
    try { return JSON.parse(text); } catch { return text; }
  };
  await call("/v1/providers/repo-fixture", { type: "openai-completions", baseUrl: `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`, models: [{ id: "repo-model", contextWindow: 32768, pricing: { input: 1, output: 1 } }] }, undefined, "PUT");


  // A small repository: two source files.
  const repo = await call("/v1/repos", { name: "workflow-repo" });
  await call(`/v1/repos/${repo.id}/files/src/a.txt`, undefined, "1");
  await call(`/v1/repos/${repo.id}/files/src/b.txt`, undefined, "2");
  script = `
    // Three workers fork the repo as it is now and edit it with their write tool; the third edits the file the first does.
    const [a, b, c] = await parallel([
      () => agent("EDIT /repo/src/a.txt one", { key: "edit:a", repo: args.repo, type: "worker" }),
      () => agent("EDIT /repo/src/b.txt two", { key: "edit:b", repo: args.repo, type: "worker" }),
      () => agent("EDIT /repo/src/a.txt uno", { key: "edit:c", repo: args.repo, type: "worker" }),
    ]);
    const landedA = await commit(a.fork, { key: "commit:a" });
    const landedB = await commit(b.fork, { key: "commit:b" });
    const landedC = await commit(c.fork, { key: "commit:c" });
    return { said: [a.text, b.text, c.text], landedA, landedB, landedC };`;
  // An agent starts the workflow and owns it.
  const owner = await call("/v1/agents", { model: "repo-fixture/repo-model", codeMode: false, fileTools: false, builtins: ["delegate"], delegate: { instructions: true } });
  const run = await call(`/v1/agents/${owner.id}/prompt`, { text: `START ${JSON.stringify({ repo: repo.id })}` });
  let started: Record<string, any> = {};
  for (let i = 0; i < 300 && started.state !== "completed"; i++) { await new Promise(resolve => setTimeout(resolve, 200)); started = await call(`/v1/agents/${owner.id}/requests/${run.id}`); }
  const reply = String(started.outcome?.result?.reply ?? "");
  assert.match(reply, /^STARTED /, JSON.stringify(started.outcome));
  const created = { id: JSON.parse(reply.slice("STARTED ".length)).workflowId as string };
  let done: Record<string, any> = await call(`/v1/workflows/${created.id}`);
  assert.deepEqual(done.owner, { kind: "agent", id: owner.id });
  for (let i = 0; i < 600 && !["completed", "failed", "paused", "aborted", "budget_exhausted"].includes(done.status); i++) {
    await new Promise(resolve => setTimeout(resolve, 500));
    done = await call(`/v1/workflows/${created.id}`);
  }
  assert.equal(done.status, "completed", JSON.stringify(done) + "\n" + JSON.stringify(await call(`/v1/workflows/${created.id}/items`)) + "\n" + fixture.worker.logs().slice(-4000));
  const { said, landedA, landedB, landedC } = done.result;
  assert.deepEqual(said, ["edited /repo/src/a.txt", "edited /repo/src/b.txt", "edited /repo/src/a.txt"]);
  assert.equal(landedA.committed, true, JSON.stringify(landedA));
  assert.equal(landedA.changed, true);
  assert.equal(landedB.committed, true, JSON.stringify(landedB));
  assert.deepEqual(landedB.files, ["src/b.txt"]);
  // The third fork started from the a.txt the first commit changed: nothing of it is written.
  assert.equal(landedC.committed, false, JSON.stringify(landedC));
  assert.deepEqual(landedC.conflicts.map((conflict: { path: string }) => conflict.path), ["src/a.txt"]);
  // The base holds both commits and not the conflicting edit.
  assert.equal(await call(`/v1/repos/${repo.id}/files/src/a.txt`), "one");
  assert.equal(await call(`/v1/repos/${repo.id}/files/src/b.txt`), "two");
  const items = (await call(`/v1/workflows/${created.id}/items`)).items as { key: string; kind: string; status: string }[];
  assert.deepEqual(items.map(item => [item.key, item.kind, item.status]).sort(),
    [["commit:a", "commit", "done"], ["commit:b", "commit", "done"], ["commit:c", "commit", "done"], ["edit:a", "agent", "done"], ["edit:b", "agent", "done"], ["edit:c", "agent", "done"]]);
  // Workflow refs go at the end; independent cache refs retain cached versions.
  for (let i = 0; i < 50; i++) {
    const refs = await call(`/v1/repos/${repo.id}/refs`) as { name: string; owner: string }[];
    if (!refs.some(ref => ref.owner === `workflow:${created.id}`)) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  const refs = await call(`/v1/repos/${repo.id}/refs`) as { name: string; owner: string }[];
  assert.ok(!refs.some(ref => ref.owner === `workflow:${created.id}`));

});
