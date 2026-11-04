import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Agents } from "../../../clients/agents.ts";

const directory = fileURLToPath(new URL("../", import.meta.url));
const token = "local-integration-only-token-with-at-least-32-characters";
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function unusedPort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

class LocalWorker {
  readonly url: string;
  private child?: ChildProcess;
  private output = "";
  private port: number;
  private storage: string;
  constructor(port: number, storage: string) {
    this.port = port;
    this.storage = storage;
    this.url = `http://127.0.0.1:${port}`;
  }
  async start() {
    const env = { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false", WRANGLER_LOG_PATH: join(this.storage, "logs") };
    // Model tests must not accidentally fall back to a configured cloud account.
    for (const key of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_API_KEY", "CLOUDFLARE_ACCOUNT_ID"]) delete env[key];
    this.child = spawn(process.execPath, [
      "node_modules/wrangler/bin/wrangler.js", "dev", "--local", "--config", "wrangler.test.jsonc",
      "--ip", "127.0.0.1", "--port", String(this.port), "--persist-to", this.storage,
    ], { cwd: directory, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    this.output = "";
    const save = (data: Buffer) => { this.output = (this.output + data.toString()).slice(-16_000); };
    this.child.stdout!.on("data", save);
    this.child.stderr!.on("data", save);
    for (let attempt = 0; attempt < 120; attempt++) {
      if (this.child.exitCode !== null || this.child.signalCode !== null) throw new Error(`workerd exited: ${this.output}`);
      try {
        const response = await fetch(`${this.url}/healthz`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1000) });
        if (response.ok) return;
      } catch {}
      await delay(250);
    }
    throw new Error(`workerd never became ready: ${this.output}`);
  }
  async stop(hard = false) {
    const child = this.child;
    this.child = undefined;
    if (!child || child.exitCode !== null) return;
    const done = once(child, "exit");
    try { process.kill(-child.pid!, hard ? "SIGKILL" : "SIGTERM"); } catch {}
    await Promise.race([done, delay(3000)]);
    if (child.exitCode === null) {
      try { process.kill(-child.pid!, "SIGKILL"); } catch {}
      await Promise.race([done, delay(1000)]);
    }
  }
  logs() { return this.output; }
}

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
      const [a, b] = await Promise.all([
        watched.wait(first.id, { timeoutMs: 15_000 }), watched.wait(second.id, { timeoutMs: 15_000 }),
      ]);
      assert.equal(a.text, "Echo: queued first");
      assert.equal(b.text, "Echo: queued second");
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
