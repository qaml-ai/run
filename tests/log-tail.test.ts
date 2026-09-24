import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { getRequestListener } from "@hono/node-server";
import type { Api, Model } from "@earendil-works/pi-ai";
import { fileStorage, memoryStorage, PreconditionFailed, type LogTail } from "../shared/storage.ts";
import { postgresTail, sweepTails } from "../src/log-tail.ts";
import { Ownership, type Claim } from "../src/ownership.ts";
import { AgentSupervisor, type Hosting } from "../src/supervisor.ts";
import { ClientSessions } from "../src/client-sessions.ts";
import { VolumeService } from "../src/volumes.ts";
import { AgentRuntime, schema, tool } from "../clients/node.ts";
import { testDatabase } from "./database.ts";

type Context = { after(fn: () => Promise<void> | void): void };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const rows = async (db: pg.Pool, key: string) => (await db.query("select seq from log_records where log_key = $1 order by seq", [key])).rows.map(row => row.seq);

async function claimed(t: Context, db: pg.Pool, node: string, actor: string, ttlMs = 30_000): Promise<{ ownership: Ownership; claim: Claim }> {
  const ownership = new Ownership(db, { node, ttlMs });
  await ownership.start();
  t.after(() => ownership.close().catch(() => {}));
  const acquired = await ownership.acquire(actor);
  assert.ok("claim" in acquired);
  return { ownership, claim: acquired.claim };
}
/** Expire a node's heartbeat, as if it stopped renewing it. */
const expire = (db: pg.Pool, node: string) => db.query("update runtime_nodes set expires_at = now() - interval '1 second' where node = $1", [node]);

test("appends go to the tail, not Storage; compaction folds them into one segment in the old format", async () => {
  const { db } = await testDatabase();
  const storage = memoryStorage(postgresTail(db));
  // A log written before the tail existed: segments (one per flush) and a snapshot.
  storage.logs.set("agents/old/log", new Map([
    ["000000000000", '{"n":0}\n'], ["snapshot-000000000001", '[{"n":1}]'], ["000000000002", '{"n":2}\n{"n":3}\n'],
  ]));
  const log = storage.log<{ n: number }>("agents/old/log");
  assert.deepEqual(await log.read(), [{ n: 1 }, { n: 2 }, { n: 3 }]);
  for (let n = 4; n <= 8; n++) { log.append({ n }); await log.flush(true); }
  assert.equal(storage.puts, 0);
  assert.deepEqual(await rows(db, "agents/old/log"), [3, 4, 5, 6, 7]);
  await log.close();
  assert.equal(storage.puts, 1);
  assert.deepEqual(await rows(db, "agents/old/log"), []);
  assert.equal(storage.logs.get("agents/old/log")!.get("000000000007"), '{"n":4}\n{"n":5}\n{"n":6}\n{"n":7}\n{"n":8}\n');
  assert.deepEqual(await storage.log("agents/old/log").read(), [1, 2, 3, 4, 5, 6, 7, 8].map(n => ({ n })));
});

test("a long-lived writer compacts once the tail passes its bound", async () => {
  const { db } = await testDatabase();
  const storage = memoryStorage(postgresTail(db));
  const log = storage.log<{ n: number }>("agents/busy/log");
  await log.read();
  for (let n = 0; n < 1100; n++) { log.append({ n }); await log.flush(true); }
  await log.read();
  assert.equal(storage.puts, 2, "two segments of 512");
  assert.ok((await rows(db, "agents/busy/log")).length < 512);
  assert.deepEqual((await storage.log<{ n: number }>("agents/busy/log").read()).map(record => record.n), Array.from({ length: 1100 }, (_, n) => n));
});

test("a crash between the Storage write and the row delete repeats no record", async () => {
  const { db } = await testDatabase();
  const real = postgresTail(db);
  // The compaction's transaction fails after the segment is written, so the rows stay.
  const crashing: LogTail = { ...real, compact: (key, claim, fold) => real.compact(key, claim, async rows => { await fold(rows); throw new Error("crashed"); }) };
  const storage = memoryStorage(crashing);
  const log = storage.log<{ n: number }>("agents/c/log");
  await log.read();
  log.append({ n: 1 }); log.append({ n: 2 }); await log.flush(true);
  await log.close();
  assert.equal(storage.puts, 1, "the segment was written");
  assert.deepEqual(await rows(db, "agents/c/log"), [0, 1], "but the rows were not deleted");

  const after = memoryStorage(real);
  after.logs.set("agents/c/log", storage.logs.get("agents/c/log")!);
  const next = after.log<{ n: number }>("agents/c/log");
  assert.deepEqual(await next.read(), [{ n: 1 }, { n: 2 }]);
  next.append({ n: 3 }); await next.flush(true);
  assert.deepEqual(await after.log("agents/c/log").read(), [{ n: 1 }, { n: 2 }, { n: 3 }]);
  // The next compaction writes only what Storage lacks, and clears the leftovers.
  await next.close();
  assert.deepEqual(await rows(db, "agents/c/log"), []);
  assert.deepEqual([...after.logs.get("agents/c/log")!.keys()], ["000000000001", "000000000002"]);
  assert.deepEqual(await after.log("agents/c/log").read(), [{ n: 1 }, { n: 2 }, { n: 3 }]);

  // The same for a snapshot: a crash leaves the snapshot and the rows it covers.
  const folding = memoryStorage(crashing);
  folding.logs.set("agents/c/log", after.logs.get("agents/c/log")!);
  const folded = folding.log<{ n: number }>("agents/c/log");
  await folded.read();
  await folded.rewrite(() => [{ n: 10 }]);
  folded.append({ n: 11 }); await folded.flush(true);
  await folded.close();
  assert.deepEqual(await after.log("agents/c/log").read(), [{ n: 10 }, { n: 11 }]);
  assert.deepEqual(await rows(db, "agents/c/log"), [3, 4]);
});

test("a stale owner's appends and compactions are rejected, and it stays fenced", async t => {
  const { db } = await testDatabase();
  const storage = memoryStorage(postgresTail(db));
  const a = await claimed(t, db, "http://a", "vol_x");
  const stale = storage.log<{ n: number }>("volumes/vol_x/tree", a.claim);
  await stale.read();
  stale.append({ n: 1 }); await stale.flush(true);
  await expire(db, "http://a");
  const b = await claimed(t, db, "http://b", "vol_x");
  const owner = storage.log<{ n: number }>("volumes/vol_x/tree", b.claim);
  assert.deepEqual(await owner.read(), [{ n: 1 }]);
  stale.append({ n: 99 });
  await assert.rejects(stale.flush(true), PreconditionFailed);
  await assert.rejects(stale.rewrite(() => [{ n: 98 }]), /another owner/);
  await stale.close();
  assert.equal(storage.puts, 0, "the stale owner compacted nothing");
  owner.append({ n: 2 }); await owner.flush(true);
  await owner.close();
  assert.deepEqual(await storage.log("volumes/vol_x/tree").read(), [{ n: 1 }, { n: 2 }]);
});

test("rows of revoked agents and deleted volumes that no live node holds are swept", async t => {
  const { db } = await testDatabase();
  const storage = memoryStorage(postgresTail(db));
  const { ownership, claim } = await claimed(t, db, "http://a", "client_gone");
  const log = storage.log<{ n: number }>("client-sessions/client_gone.journal", claim);
  await log.read();
  log.append({ n: 1 }); await log.flush(true);
  await db.query("insert into agents (id, tenant, header, revision, name, type, model, revoked) values ('client_gone', 't', '{}', 1, 'n', 'g', 'm', true)");
  assert.equal(await sweepTails(db), 0, "held by a live node");
  await ownership.release(claim);
  assert.equal(await sweepTails(db), 1);
  assert.deepEqual(await rows(db, "client-sessions/client_gone.journal"), []);
});

test("deleting a volume drops its tail instead of compacting it", async t => {
  const { db } = await testDatabase();
  const storage = memoryStorage(postgresTail(db));
  const { ownership } = await claimed(t, db, "http://a", "unused");
  const volumes = new VolumeService({ db, storage, ownership });
  t.after(() => volumes.close());
  const { id } = await volumes.create("acme", { name: "gone" });
  await volumes.call(id, "acme", "commit", { path: "/a.txt", ...await volumes.store("acme", Buffer.from("a")) });
  assert.equal((await rows(db, `volumes/${id}/tree`)).length, 1);
  const puts = storage.puts;
  await volumes.call(id, "acme", "delete");
  assert.deepEqual(await rows(db, `volumes/${id}/tree`), []);
  assert.equal(storage.puts, puts);
});

/** A node in its own process that writes a log under its claim, then appends again when told. */
function writer(url: string, root: string, records: number) {
  const script = `
    import pg from "pg";
    import { createInterface } from "node:readline";
    import { Ownership } from ${JSON.stringify(new URL("../src/ownership.ts", import.meta.url).href)};
    import { postgresTail } from ${JSON.stringify(new URL("../src/log-tail.ts", import.meta.url).href)};
    import { fileStorage } from ${JSON.stringify(new URL("../shared/storage.ts", import.meta.url).href)};
    const db = new pg.Pool({ connectionString: ${JSON.stringify(url)} });
    const ownership = new Ownership(db, { node: "http://a", ttlMs: 1000 });
    await ownership.start();
    const { claim } = await ownership.acquire("vol_n");
    const log = fileStorage(${JSON.stringify(root)}, { tail: postgresTail(db) }).log("volumes/vol_n/tree", claim);
    await log.read();
    for (let n = 1; n <= ${records}; n++) { log.append({ n }); await log.flush(true); }
    console.log("written");
    for await (const line of createInterface({ input: process.stdin })) {
      log.append({ n: Number(line) });
      console.log(await log.flush(true).then(() => "accepted", error => "rejected: " + error.message));
    }`;
  const child = spawn(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "--input-type=module", "-e", script], { stdio: ["pipe", "pipe", "inherit"] });
  const lines: string[] = [];
  child.stdout.setEncoding("utf8").on("data", chunk => lines.push(...String(chunk).split("\n").filter(Boolean)));
  const line = async (text: RegExp) => { for (let tries = 0; !lines.some(entry => text.test(entry)); tries++) { assert.ok(tries < 300, `writer printed ${text}`); await sleep(50); } return lines.find(entry => text.test(entry))!; };
  return { child, line };
}

test("two nodes: B takes over the tail a killed node left, and a paused node that resumes is rejected", { timeout: 60_000 }, async t => {
  const { db, url } = await testDatabase();
  const root = await mkdtemp(join(tmpdir(), "tail-nodes-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = fileStorage(root, { tail: postgresTail(db) });

  // A writes three records and is killed before it compacts anything.
  const killed = writer(url, root, 3);
  await killed.line(/written/);
  killed.child.kill("SIGKILL");
  await once(killed.child, "close");
  assert.deepEqual(await rows(db, "volumes/vol_n/tree"), [0, 1, 2], "A's records are only in the tail");
  await sleep(1200);
  const b = await claimed(t, db, "http://b", "vol_n");
  const log = storage.log<{ n: number }>("volumes/vol_n/tree", b.claim);
  assert.deepEqual(await log.read(), [{ n: 1 }, { n: 2 }, { n: 3 }]);
  log.append({ n: 4 }); await log.flush(true);
  await log.close();
  await b.ownership.release(b.claim);

  // A takes the volume back, writes, and is paused. B takes over; A resumes and tries to append.
  const paused = writer(url, root, 2);
  await paused.line(/written/);
  paused.child.kill("SIGSTOP");
  t.after(() => { paused.child.kill("SIGKILL"); });
  await sleep(1200);
  const again = await b.ownership.acquire("vol_n");
  assert.ok("claim" in again);
  const next = storage.log<{ n: number }>("volumes/vol_n/tree", again.claim);
  assert.deepEqual((await next.read()).map(record => record.n), [1, 2, 3, 4, 1, 2]);
  paused.child.kill("SIGCONT");
  paused.child.stdin.write("99\n");
  assert.match(await paused.line(/accepted|rejected/), /^rejected: .*another owner/);
  next.append({ n: 5 }); await next.flush(true);
  assert.deepEqual((await storage.log<{ n: number }>("volumes/vol_n/tree").read()).map(record => record.n), [1, 2, 3, 4, 1, 2, 5]);
});

test("a multi-step turn writes nothing to Storage; unloading writes one segment per log", { timeout: 60_000 }, async t => {
  const { db } = await testDatabase();
  const root = await mkdtemp(join(tmpdir(), "tail-turn-"));
  const storage = memoryStorage(postgresTail(db));
  const ownership = new Ownership(db, { node: "http://n" });
  await ownership.start();
  const supervisor = new AgentSupervisor(join(root, "agents"), { runtime: process.env.AGENT_RUNTIME, hosting: process.env.AGENT_HOSTING as Hosting | undefined, storage });
  const sessions = new ClientSessions(supervisor, { db, storage, prefix: "client-sessions/", ownership, secret: "tail-test-secret-with-32-characters!", apiKey: "fixture-only" });
  let calls = 0;
  const provider = createServer(async (req, res) => {
    for await (const _ of req);
    calls++;
    const delta = calls <= 2
      ? { role: "assistant", tool_calls: [{ index: 0, id: `call_${calls}`, type: "function", function: { name: "js_exec", arguments: JSON.stringify({ code: `return await tools.echo({ value: "step ${calls}" })` }) } }] }
      : { role: "assistant", content: "Done." };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const [content, finish] of [[delta, null], [{}, calls <= 2 ? "tool_calls" : "stop"]]) res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: content, finish_reason: finish }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  provider.listen(0, "127.0.0.1"); await once(provider, "listening");
  const model = { id: "fixture", name: "Fixture", api: "openai-completions", provider: "openai", baseUrl: `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1024 } as Model<Api>;
  const server = createServer(getRequestListener(async (req, env) => {
    if (new URL(req.url).pathname.startsWith("/clients/")) return sessions.app.fetch(req, env);
    const body = await req.json() as any;
    return Response.json(await sessions.create(body.tools, { model }, req.headers.get("idempotency-key") ?? undefined), { status: 201 });
  }));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => {
    await sessions.close(); await supervisor.close(); await ownership.close();
    for (const listening of [server, provider]) { listening.closeAllConnections(); await new Promise(resolve => listening.close(resolve)); }
    await rm(root, { recursive: true, force: true });
  });
  const echo = tool({ description: "Echo", input: schema.Object({ value: schema.String() }, { additionalProperties: false }), execute: ({ value }) => ({ echoed: value }) });
  const agent = await new AgentRuntime({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, apiKey: "x", stateDirectory: join(root, "sdk") }).createAgent({ tools: { echo } });
  await agent.status();

  const before = storage.puts;
  assert.equal((await agent.prompt("Echo twice.")).error, null);
  assert.equal(calls, 3);
  const turn = storage.puts - before;
  const tail = Number((await db.query("select count(*) as count from log_records")).rows[0].count);
  await agent.close();
  await sessions.close();
  await supervisor.close();
  const unload = storage.puts - before - turn;
  console.log(JSON.stringify({ type: "storage_writes", turn, unload, tailRows: tail }));
  assert.equal(turn, 0, "no Storage writes during the turn");
  assert.ok(unload <= 2, `at most one segment per log on unload (was ${unload})`);
  assert.equal(Number((await db.query("select count(*) as count from log_records")).rows[0].count), 0, "unloading emptied the tail");
  const history = (await supervisor.history(agent.session.id)).map(message => message.role);
  assert.deepEqual(history, ["user", "assistant", "toolResult", "assistant", "toolResult", "assistant"]);
});
