import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Agents } from "../../../clients/agents.ts";

import { LocalWorker, unusedPort } from "./local-worker.ts";
const token = "local-integration-only-token-with-at-least-32-characters";
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test("existing TypeScript SDK on local Workers/Durable Objects", { timeout: 180_000 }, async t => {
  const storage = await mkdtemp(join(tmpdir(), "camelrun-cloudflare-test-"));
  const server = new LocalWorker(await unusedPort(), storage);
  const agents = new Agents({ url: server.url, apiKey: token, connection: "lazy", pollMs: 100 });
  let finished = false;
  t.after(async () => {
    if (!finished || process.env.DEBUG_WORKER_TESTS) t.diagnostic(server.logs());
    await agents.close(); await server.stop(); await rm(storage, { recursive: true, force: true });
  });
  await server.start();
  const raw = (path: string, key = token, init: RequestInit = {}) => fetch(`${server.url}${path}`, {
    ...init, headers: { authorization: `Bearer ${key}`, ...init.headers }, signal: AbortSignal.timeout(30_000),
  });
  const alpha = await agents.upsert("alpha", { model: "test/echo", instructions: "Reply to the user." });
  const beta = await agents.upsert("beta", { model: "test/echo" });

  await t.test("creation is idempotent and agent tokens are isolated", async () => {
    const again = await agents.upsert("alpha", { model: "test/echo", instructions: "Reply to the user." });
    assert.equal(again.id, alpha.id);
    await again.close();
    const response = await raw(`/clients/${beta.id}/state`, alpha.session.token);
    assert.ok([401, 403, 404].includes(response.status), `cross-agent token accepted: ${response.status}`);
    assert.ok([401, 403].includes((await raw("/v1/agents", alpha.session.token)).status));
    assert.ok([401, 403].includes((await raw("/v1/agents", alpha.session.token, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mcp: { tools: [] } }),
    })).status));
    const unauthenticated = await fetch(`${server.url}/v1/agents`);
    assert.equal(unauthenticated.status, 401);
  });

  await t.test("prompt settles through the SDK and history persists", async () => {
    const result = await alpha.run("hello world", { idempotencyKey: "first-turn", timeoutMs: 15_000 });
    assert.equal(result.status, "completed");
    assert.equal(result.text, "Echo: hello world");
    const before = await alpha.history();
    assert.ok(before.some(message => JSON.stringify(message).includes("hello world")));
    const duplicate = await alpha.run("hello world", { idempotencyKey: "first-turn", timeoutMs: 15_000 });
    assert.equal(duplicate.text, result.text);
    assert.deepEqual(await alpha.history(), before, "replaying an accepted request appended history");
    await assert.rejects(alpha.run("different input", { idempotencyKey: "first-turn", timeoutMs: 5_000 }), /conflict|different|reuse|idempotency/i);
  });

  await t.test("SSE streams text through the existing SDK", async () => {
    const stream = alpha.stream("stream this", { idempotencyKey: "stream-turn", timeoutMs: 15_000 });
    const chunks: string[] = [];
    const types: string[] = [];
    for await (const part of stream) { types.push(part.type); if (part.type === "text") chunks.push(part.text); }
    assert.equal((await stream.result()).text, "Echo: stream this");
    if (!chunks.length) t.diagnostic(`SDK stream part types: ${types.join(",")}`);
    assert.equal(chunks.join(""), "Echo: stream this");
  });

  await t.test("queued turns keep results and streamed text attached to their request IDs", async () => {
    const text = new Map<string, string>();
    const observed: string[] = [];
    const watched = await agents.get("alpha", { onEvent(event, requestId) {
      observed.push(`${requestId ?? "none"}:${event.type}`);
      if (requestId && event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        text.set(requestId, (text.get(requestId) ?? "") + event.assistantMessageEvent.delta);
      }
    } });
    try {
      const first = await watched.send("slow:500:queued first", { idempotencyKey: "queued-first" });
      const second = await watched.send("queued second", { idempotencyKey: "queued-second" });
      let observedStart: number | undefined;
      for (let attempt = 0; attempt < 40 && !observedStart; attempt++) {
        const pending = await (await raw(`/clients/${alpha.id}/requests/${first.id}`, alpha.session.token)).json() as { began?: number };
        observedStart = pending.began;
        if (!observedStart) await delay(10);
      }
      assert.ok(observedStart, "the running request must expose its observed start");
      const [a, b] = await Promise.all([
        watched.wait(first.id, { timeoutMs: 15_000 }), watched.wait(second.id, { timeoutMs: 15_000 }),
      ]);
      assert.equal(a.text, "Echo: queued first");
      assert.equal(b.text, "Echo: queued second");
      const completed = await (await raw(`/clients/${alpha.id}/requests/${first.id}`, alpha.session.token)).json() as { began?: number };
      assert.equal(completed.began, observedStart, "settlement must preserve the start recorded while it waited");
      if (!text.size) t.diagnostic(`Observed events: ${observed.join(",")}`);
      assert.equal(text.get(first.id), a.text);
      assert.equal(text.get(second.id), b.text);
    } finally { await watched.close(); }
  });

  await t.test("a model tool call writes through the real Computer tool bridge", async () => {
    const result = await alpha.run("tool:write:from model", { idempotencyKey: "model-tool", timeoutMs: 15_000 });
    assert.equal(result.status, "completed");
    assert.equal(result.text, "Echo: from model");
    assert.equal(new TextDecoder().decode((await alpha.files.download("/workspace/model.txt")).data), "from model");
  });

  await t.test("workspace files and isolated JS use real Computer execution", async () => {
    await alpha.files.upload("/workspace/persist.txt", "keep across process restart", { contentType: "text/plain" });
    assert.equal(new TextDecoder().decode((await alpha.files.download("/workspace/persist.txt")).data), "keep across process restart");
    const response = await raw(`/experimental/agents/${alpha.id}/exec`, alpha.session.token, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: 'import { readFile, writeFile } from "node:fs/promises"; export default async function () { const text = await readFile("/workspace/persist.txt", "utf8"); await writeFile("/workspace/upper.txt", text.toUpperCase()); try { await fetch("https://example.com"); return {network: "allowed"}; } catch { return {network:"denied"}; } }' }),
    });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json() as { value: { network: string } }).value.network, "denied");
    assert.equal(new TextDecoder().decode((await alpha.files.download("/workspace/upper.txt")).data), "KEEP ACROSS PROCESS RESTART");
    const isolated = await raw(`/clients/${beta.id}/files/workspace/persist.txt`, beta.session.token);
    assert.equal(isolated.status, 404);
  });

  await t.test("stock codemode calls agent tools and contains hostile scripts", async () => {
    const cases = [
      ["loop", "while (true) {}", /timeout|interrupt|budget/i],
      ["memory", 'const a = []; while (true) a.push("x".repeat(1024 * 1024));', /memory|alloc|sandbox/i],
      ["pending", "await new Promise(() => {});", /pending|settle|promise|progress/i],
      ["throw", 'throw new Error("intentional script error");', /intentional script error/],
      ["tool", 'await tools.read({ path: "/workspace/missing-file" });', /ENOENT|not found|no such/i],
    ] as const;
    const success = await alpha.run('code:await tools.write({path:"/workspace/codemode.txt", content:"nested tool"}); text(await tools.read({path:"/workspace/codemode.txt"}));', { timeoutMs: 30_000 });
    assert.match(success.text!, /nested tool/);
    assert.equal(new TextDecoder().decode((await alpha.files.download("/workspace/codemode.txt")).data), "nested tool");
    const initialInstance = (await (await raw(`/clients/${alpha.id}/state`, alpha.session.token)).json() as any).localInstanceId;
    assert.ok(initialInstance);
    for (const [name, code, expected] of cases) {
      const start = performance.now();
      const sent = await alpha.send(`code:${code}`);
      await delay(30);
      const ping = performance.now();
      const state = await raw(`/clients/${alpha.id}/state`, alpha.session.token);
      const pingMs = performance.now() - ping;
      assert.equal(state.status, 200);
      const result = await alpha.wait(sent.id, { timeoutMs: 30_000 });
      const toolResults = JSON.parse(result.text!);
      assert.equal(toolResults.at(-1).isError, true, `${name}: ${result.text}`);
      assert.match(JSON.stringify(toolResults), expected);
      const recovered = await alpha.run(`after ${name}`, { timeoutMs: 15_000 });
      assert.equal(recovered.text, `Echo: after ${name}`);
      assert.equal((await state.json() as any).localInstanceId, initialInstance, `${name} reconstructed the calling DO`);
      const after = await (await raw(`/clients/${alpha.id}/state`, alpha.session.token)).json() as any;
      assert.equal(after.localInstanceId, initialInstance, `${name} reset the calling DO`);
      t.diagnostic(`${name}: total_ms=${Math.round(performance.now() - start)} agent_state_ms=${Math.round(pingMs)} clean_error=true`);
    }
  });

  await t.test("codemode respects disabled files and tools can be re-enabled", async () => {
    const restricted = await agents.upsert("restricted", { model: "test/echo", fileTools: false });
    const code = 'code:await tools.write({path:"/workspace/restored.txt",content:"enabled"});';
    try {
      await restricted.files.upload("/workspace/keep.txt", "must remain");
      const denied = await restricted.run(code, { timeoutMs: 15_000 });
      assert.equal(JSON.parse(denied.text!).at(-1).isError, true);
      const deletion = await restricted.run('code:await tools.delete({path:"/workspace/keep.txt"});', { timeoutMs: 15_000 });
      assert.equal(JSON.parse(deletion.text!).at(-1).isError, true);
      assert.equal(new TextDecoder().decode((await restricted.files.download("/workspace/keep.txt")).data), "must remain");
      const enabled = await agents.upsert("restricted", { model: "test/echo", fileTools: true });
      try {
        const allowed = await enabled.run(code, { timeoutMs: 15_000 });
        assert.notEqual(JSON.parse(allowed.text!).at(-1).isError, true);
        assert.equal(new TextDecoder().decode((await enabled.files.download("/workspace/restored.txt")).data), "enabled");
      } finally { await enabled.close(); }
    } finally { await restricted.close(); }
  });

  await t.test("codemode journal and human input survive a hard process restart", async () => {
    const code = `const marker = JSON.stringify({time: Date.now(), random: Math.random()});
      await tools.write({path:"/workspace/journal-marker.txt", content:marker});
      const seen = await tools.read({path:"/workspace/journal-marker.txt"});
      const answer = await tools.ask_human({question:marker});
      await tools.write({path:"/workspace/journal-result.txt", content:JSON.stringify({marker, seen, answer})});
      text(answer);`;
    const sent = await alpha.send(`code:${code}`);
    let inputs: {id: string; question: string}[] = [];
    for (let i = 0; i < 100; i++) {
      inputs = await (await raw(`/experimental/agents/${alpha.id}/inputs`, alpha.session.token)).json() as typeof inputs;
      if (inputs.length) break;
      await delay(50);
    }
    assert.equal(inputs.length, 1);
    const marker = inputs[0].question;
    await alpha.files.upload("/workspace/journal-marker.txt", "host changed after completed write");
    await server.stop(true);
    await server.start();
    const after = await (await raw(`/experimental/agents/${alpha.id}/inputs`, alpha.session.token)).json() as typeof inputs;
    assert.deepEqual(after, inputs);
    const reply = await raw(`/experimental/agents/${alpha.id}/inputs/${inputs[0].id}`, alpha.session.token, {
      method: "POST", headers: {"content-type":"application/json"}, body: JSON.stringify({answer:"approved locally"}),
    });
    assert.equal(reply.status, 200, await reply.text());
    const result = await alpha.wait(sent.id, { timeoutMs: 60_000 });
    assert.match(result.text!, /approved locally/);
    assert.equal(new TextDecoder().decode((await alpha.files.download("/workspace/journal-marker.txt")).data), "host changed after completed write", "completed nested write replayed");
    const output = JSON.parse(new TextDecoder().decode((await alpha.files.download("/workspace/journal-result.txt")).data));
    assert.equal(output.marker, marker, "clock/random diverged across replay");
    assert.match(JSON.stringify(output.seen), new RegExp(JSON.parse(marker).random.toString().replaceAll('.', '\\.')));
    assert.equal(output.answer, "approved locally");
    assert.deepEqual(await (await raw(`/experimental/agents/${alpha.id}/inputs`, alpha.session.token)).json(), []);
  });

  await t.test("abort ends an in-flight deterministic generation", async () => {
    const sent = await alpha.send("slow:5000:cancel me", { idempotencyKey: "abort-turn" });
    await delay(250);
    const queued = await alpha.send("this queued turn must not run", { idempotencyKey: "cancel-queued-turn" });
    const abort = await alpha.abort();
    assert.equal(abort.aborted, true);
    const result = await alpha.wait(sent.id, { throwOnError: false, timeoutMs: 15_000 });
    assert.equal(result.status, "failed");
    const cancelled = await alpha.wait(queued.id, { throwOnError: false, timeoutMs: 15_000 });
    assert.equal(cancelled.status, "failed", "aborting an agent must withdraw queued prompts");
    const resumed = await alpha.run("after abort", { idempotencyKey: "after-abort", timeoutMs: 15_000 });
    assert.equal(resumed.text, "Echo: after abort");
  });

  await t.test("accepted work and files survive a whole workerd process restart", async () => {
    const sent = await alpha.send("slow:5000:survive restart", { idempotencyKey: "restart-turn" });
    await delay(250);
    await server.stop(true);
    await server.start();
    const restored = await agents.get("alpha");
    const result = await restored.wait(sent.id, { timeoutMs: 60_000 });
    assert.equal(result.text, "Echo: survive restart");
    assert.equal(new TextDecoder().decode((await restored.files.download("/workspace/persist.txt")).data), "keep across process restart");
    const history = await restored.history();
    assert.ok(history.some(message => JSON.stringify(message).includes("hello world")));
    await restored.close();
  });

  await t.test("measure live agent heap with remote codemode loaded", async () => {
    const before = await server.heap();
    const counts = [1, 8, 16];
    let created = 0;
    for (const count of counts) {
      while (created < count) {
        const agent = await agents.upsert(`heap-${++created}`, {model:"test/echo"});
        assert.match((await agent.run("code:text(1)", {timeoutMs:15000})).text!, /1/);
        await agent.close();
      }
      const heap = await server.heap();
      t.diagnostic(`agent_heap: agents_added=${count} baseline=${JSON.stringify(before)} current=${JSON.stringify(heap)} used_delta_per_agent=${Math.round((heap.usedSize - before.usedSize) / count)}`);
    }
  });

  await t.test("deletion revokes a scoped token and removes directory visibility", async () => {
    const id = beta.id, scoped = beta.session.token;
    await beta.delete();
    assert.ok([404, 410].includes((await raw(`/clients/${id}/state`, scoped)).status));
    await assert.rejects(agents.get("beta"), /404|not found|unknown|deleted/i);
    await assert.rejects(agents.upsert("beta", { model: "test/echo" }), /410|deleted|revoked|tombstone/i);
  });
  assert.ok(!/Unauthorized.*workers\.ai|AI_ERROR|api\.cloudflare\.com.*\/ai\/run/.test(server.logs()), "test attempted a remote AI request");
  finished = true;
});
