import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRequestListener } from "@hono/node-server";
import type { Api, Model } from "@earendil-works/pi-ai";
import { memoryStorage, fileStorage } from "../shared/storage.ts";
import { AgentSupervisor, type Hosting } from "../src/supervisor.ts";
import { ClientSessions } from "../src/client-sessions.ts";
import { readJson } from "../src/http.ts";
import { FRAME_BYTES } from "../shared/client-protocol.ts";
import { CHUNK_BYTES, VolumeService, type Mount } from "../src/volumes.ts";
import { searchLines } from "../src/volume-tools.ts";
import { AgentError, AgentRuntime, memoryJournalStore, type AgentClient } from "../clients/node.ts";
import type { Db } from "../src/db.ts";
import { testDatabase } from "./database.ts";
import { postgresTail } from "../src/log-tail.ts";

type Context = { after(fn: () => Promise<void> | void): void };
const bytes = (text: string) => Buffer.from(text, "utf8");
const never = new AbortController().signal;

async function service(t: Context, storage?: ReturnType<typeof memoryStorage>, db?: Db) {
  db ??= (await testDatabase()).db;
  storage ??= memoryStorage(postgresTail(db, { unfenced: true }));
  const volumes = new VolumeService({ db, storage });
  t.after(() => volumes.close());
  const write = async (id: string, path: string, content: string | Buffer, ifMatch?: number, tenant = "acme") =>
    volumes.call(id, tenant, "commit", { path, ...await volumes.store(tenant, typeof content === "string" ? bytes(content) : content), ...(ifMatch !== undefined ? { ifMatch } : {}) });
  const read = async (id: string, path: string, tenant = "acme") => {
    const entry = await volumes.call(id, tenant, "stat", { path });
    return (await volumes.readRange(tenant, entry, 0, entry.size)).toString("utf8");
  };
  return { volumes, storage, write, read };
}

/** File tools as an agent with `mounts` calls them. */
const tools = (volumes: VolumeService, mounts: Mount[], agent = "client_agent", tenant = "acme") =>
  (name: string, args: Record<string, unknown>) => volumes.tool({ tenant, agent, mounts }, name, args, never) as Promise<any>;

test("contents are content-addressed chunks: identical data and unchanged chunks are stored once", async t => {
  const { volumes, storage, write, read } = await service(t);
  const { id } = await volumes.create("acme", { name: "docs" });
  await write(id, "/a.txt", "same bytes");
  await write(id, "/copy/a.txt", "same bytes");
  assert.equal(storage.blobs.size, 1, "one chunk for two files with the same content");
  // Three chunks, then a change to the last byte: only the last chunk is new.
  const large = Buffer.alloc(3 * CHUNK_BYTES, "x");
  const first = await write(id, "/large.bin", large);
  assert.equal(first.chunks.length, 3);
  assert.equal(storage.blobs.size, 2, "identical 1 MiB chunks dedupe within a file too");
  large[large.length - 1] = 121;
  const second = await write(id, "/large.bin", large);
  assert.deepEqual(second.chunks.slice(0, 2), first.chunks.slice(0, 2));
  assert.equal(storage.blobs.size, 3);
  assert.equal(await read(id, "/copy/a.txt"), "same bytes");
  // Chunks are per tenant: another tenant's identical content is its own chunk.
  const other = await volumes.create("other");
  await write(other.id, "/a.txt", "same bytes", undefined, "other");
  assert.equal(storage.blobs.size, 4);
});

test("versioned writes reject stale versions, and the tree keeps files and directories apart", async t => {
  const { volumes, write } = await service(t);
  const { id } = await volumes.create("acme");
  const v1 = await write(id, "/notes.md", "one", 0);
  await assert.rejects(write(id, "/notes.md", "again", 0), (error: any) => error.status === 412 && error.current === v1.version && /already exists/.test(error.message));
  const v2 = await write(id, "/notes.md", "two", v1.version);
  assert.ok(v2.version > v1.version);
  await assert.rejects(write(id, "/notes.md", "three", v1.version), (error: any) => error.status === 412 && error.current === v2.version);
  await assert.rejects(volumes.call(id, "acme", "remove", { path: "/notes.md", ifMatch: v1.version }), (error: any) => error.status === 412);
  await assert.rejects(write(id, "/notes.md/child", "x"), /\/notes.md is a file/);
  await write(id, "/dir/file", "x");
  await assert.rejects(write(id, "/dir", "x"), /\/dir is a directory/);
  await assert.rejects(write(id, "/../escape", "x"), /Invalid path/);
  assert.deepEqual((await volumes.call(id, "acme", "ls", { path: "/" })).entries.map((entry: any) => [entry.name, entry.type]), [["dir", "directory"], ["notes.md", "file"]]);
  await volumes.call(id, "acme", "remove", { path: "/dir/file", ifMatch: (await volumes.call(id, "acme", "stat", { path: "/dir/file" })).version });
  assert.deepEqual((await volumes.call(id, "acme", "ls", { path: "/" })).entries.map((entry: any) => entry.name), ["notes.md"], "empty directories disappear");
  const changes = await volumes.call(id, "acme", "changes", { since: 0 });
  assert.deepEqual(changes.changes.map((change: any) => change.kind), ["write", "write", "write", "delete"]);
});

test("the tree survives a reload from its log, including after folding", async t => {
  const { db } = await testDatabase();
  const storage = memoryStorage(postgresTail(db, { unfenced: true }));
  const first = await service(t, storage, db);
  const { id } = await first.volumes.create("acme");
  for (let index = 0; index < 1100; index++) await first.write(id, `/f/${index % 50}.txt`, `v${index}`);
  await first.volumes.close();
  const second = await service(t, storage, db);
  assert.equal(await second.read(id, "/f/49.txt"), "v1099");
  const info = await second.volumes.call(id, "acme", "info");
  assert.equal(info.files, 50);
  assert.equal(info.seq, 1100);
});

test("snapshots and forks copy metadata only and diverge independently", async t => {
  const { volumes, storage, write, read } = await service(t);
  const { id } = await volumes.create("acme", { name: "source" });
  await write(id, "/a.txt", "a1");
  await write(id, "/b.txt", "b1");
  const snapshot = await volumes.call(id, "acme", "snapshot", { name: "before" });
  assert.equal(snapshot.files, 2);
  await write(id, "/a.txt", "a2");
  const chunks = storage.blobs.size;
  const fork = await volumes.call(id, "acme", "fork", { name: "fork" });
  const past = await volumes.call(id, "acme", "fork", { snapshot: snapshot.id });
  assert.equal(storage.blobs.size, chunks, "forking wrote no content");
  assert.deepEqual(fork.origin, { volume: id, seq: 3 });
  assert.equal(await read(past.id, "/a.txt"), "a1", "a snapshot fork has the snapshot's files");
  assert.equal(await read(fork.id, "/a.txt"), "a2");
  // Diverge: each side's writes stay on its side.
  await write(id, "/a.txt", "a3");
  await write(fork.id, "/b.txt", "b-fork");
  await volumes.call(fork.id, "acme", "remove", { path: "/a.txt" });
  assert.equal(await read(id, "/a.txt"), "a3");
  assert.equal(await read(id, "/b.txt"), "b1");
  assert.equal(await read(fork.id, "/b.txt"), "b-fork");
  await assert.rejects(read(fork.id, "/a.txt"), /does not exist/);
  assert.equal(await read(past.id, "/a.txt"), "a1");
  assert.deepEqual((await volumes.call(id, "acme", "snapshots")).map((entry: any) => entry.name), ["before"]);
  await volumes.call(id, "acme", "deleteSnapshot", { snapshot: snapshot.id });
  assert.equal(await read(past.id, "/b.txt"), "b1", "forks do not depend on their snapshot");
  assert.deepEqual((await volumes.list("acme")).map(volume => volume.name).sort(), ["fork", "source", "source (fork)"]);
});

test("tenants cannot reach each other's volumes, by operation or by mount", async t => {
  const { volumes, write } = await service(t);
  const { id } = await volumes.create("acme");
  await write(id, "/secret.txt", "acme only");
  assert.equal(await volumes.owns(id, "evil"), false);
  assert.deepEqual(await volumes.list("evil"), []);
  for (const op of ["info", "stat", "ls", "list", "snapshot", "fork", "delete"]) {
    await assert.rejects(volumes.call(id, "evil", op, { path: "/secret.txt" }), (error: any) => error.status === 404, op);
  }
  await assert.rejects(volumes.mountsFor("evil", "client_x", [{ volumeId: id, path: "/stolen", mode: "ro" }]), /Unknown volume/);
  // A mount that outlived the tenant check still cannot cross tenants.
  await assert.rejects(tools(volumes, [{ volumeId: id, path: "/stolen", mode: "ro" }], "client_x", "evil")("read", { path: "/stolen/secret.txt" }), /Unknown volume/);
});

test("file tools: mount paths, read-only mounts, subpaths and edit conflicts the model can act on", async t => {
  const { volumes, write } = await service(t);
  const { id } = await volumes.create("acme");
  await write(id, "/team/plan.md", "alpha\nbeta\n");
  const mounts: Mount[] = [{ volumeId: id, path: "/workspace", mode: "rw" }, { volumeId: id, path: "/team", mode: "ro", subpath: "/team" }];
  const call = tools(volumes, mounts);
  assert.deepEqual((await call("ls", { path: "/" })).entries.map((entry: any) => entry.name), ["workspace", "team"]);
  const viaSubpath = await call("read", { path: "/team/plan.md" });
  assert.equal(viaSubpath.content, "alpha\nbeta\n");
  assert.equal(viaSubpath.path, "/team/plan.md");
  await assert.rejects(call("write", { path: "/team/plan.md", content: "x" }), /\/team is mounted read-only/);
  await assert.rejects(call("edit", { path: "/team/plan.md", old: "alpha", new: "x" }), /read-only/);
  await assert.rejects(call("read", { path: "/elsewhere/x" }), /not inside a mount/);
  await assert.rejects(call("read", { path: "/workspace/../../etc/passwd" }), /Invalid path/);
  // Relative paths resolve against the first mount.
  const read = await call("read", { path: "team/plan.md" });
  assert.equal(read.path, "/workspace/team/plan.md");
  // Another writer changes the file after this agent read it.
  await write(id, "/team/plan.md", "alpha\nBETA\n");
  await assert.rejects(call("edit", { path: "/workspace/team/plan.md", old: "beta", new: "gamma", version: read.version }),
    /Edit rejected: \/workspace\/team\/plan.md changed since you read it \(you had version \d+; it is now version \d+\)\. Read it again/);
  await assert.rejects(call("write", { path: "/workspace/team/plan.md", content: "x", version: read.version }), /Write rejected: .*changed since you read it/);
  const fresh = await call("read", { path: "/workspace/team/plan.md" });
  const edited = await call("edit", { path: "/workspace/team/plan.md", old: "BETA", new: "gamma", version: fresh.version });
  assert.equal(edited.version, fresh.version + 1);
  assert.equal((await call("read", { path: "/team/plan.md" })).content, "alpha\ngamma\n");
  await assert.rejects(call("edit", { path: "/workspace/team/plan.md", old: "missing", new: "x" }), /not found/);
  await call("write", { path: "/workspace/dup.txt", content: "a a a" });
  await assert.rejects(call("edit", { path: "/workspace/dup.txt", old: "a", new: "b" }), /appears 3 times/);
  assert.equal((await call("edit", { path: "/workspace/dup.txt", old: "a", new: "b", replaceAll: true })).size, 5);
  await assert.rejects(call("write", { path: "/workspace/new.txt", content: "x", version: 1 }), /no longer exists|now deleted/);
  assert.equal((await call("write", { path: "/workspace/new.txt", content: "x", version: 0 })).size, 1);
});

test("large files are read in bounded windows that fetch only the chunks they cover", async t => {
  const { db } = await testDatabase();
  const storage = memoryStorage(postgresTail(db, { unfenced: true }));
  const reads: string[] = [];
  const readBlob = storage.readBlob.bind(storage);
  storage.readBlob = key => { reads.push(key); return readBlob(key); };
  const { volumes, write } = await service(t, storage, db);
  const { id } = await volumes.create("acme");
  // Three chunks of distinct text, with a multi-byte character straddling the read window's end.
  const line = (index: number) => `line ${String(index).padStart(7, "0")} ${"é".repeat(20)}\n`;
  const text = Array.from({ length: 60_000 }, (_, index) => line(index)).join("");
  await write(id, "/big.log", text);
  const call = tools(volumes, [{ volumeId: id, path: "/workspace", mode: "rw" }]);
  const first = await call("read", { path: "/workspace/big.log" });
  assert.ok(Buffer.byteLength(first.content) <= 32 * 1024);
  assert.equal(first.nextOffset, Buffer.byteLength(first.content));
  assert.ok(text.startsWith(first.content), "the window ends on a character boundary");
  assert.equal(reads.length, 1, "one chunk fetched for the first window");
  reads.length = 0;
  const offset = 2 * CHUNK_BYTES + 10;
  const tail = await call("read", { path: "/workspace/big.log", offset, length: 1000 });
  assert.equal(reads.length, 1, "only the chunk holding the window is fetched");
  assert.equal(tail.offset, offset);
  const binary = Buffer.alloc(100); binary[3] = 0;
  await write(id, "/blob.bin", binary);
  assert.equal((await call("read", { path: "/workspace/blob.bin" })).binary, true);
});

test("glob and grep are capped by result, file and byte limits", async t => {
  const { volumes, write } = await service(t);
  const { id } = await volumes.create("acme");
  for (let index = 0; index < 250; index++) await write(id, `/src/${index % 5}/file${index}.ts`, `export const value${index} = ${index};\n// TODO item ${index}\n`);
  await write(id, "/src/readme.md", "TODO docs\n");
  await write(id, "/huge.txt", Buffer.alloc(5 * 1024 * 1024, "TODO "));
  await write(id, "/image.png", Buffer.from([0, 1, 2, 84, 79, 68, 79]));
  const call = tools(volumes, [{ volumeId: id, path: "/workspace", mode: "rw" }]);
  const all = await call("glob", { pattern: "**/*.ts" });
  assert.equal(all.paths.length, 200);
  assert.equal(all.truncated, true);
  assert.ok(all.paths.every((path: string) => path.startsWith("/workspace/src/") && path.endsWith(".ts")));
  const scoped = await call("glob", { pattern: "*.{md,png}", path: "/workspace/src" });
  assert.deepEqual(scoped.paths, ["/workspace/src/readme.md"]);
  assert.equal((await call("glob", { pattern: "src/1/file1?.ts" })).paths.length, 2);
  const grep = await call("grep", { pattern: "TODO" });
  assert.equal(grep.matches.length, 50);
  assert.match(grep.truncated, /more than 50 matches/);
  assert.deepEqual(grep.matches[0], { path: "/workspace/src/0/file0.ts", line: 2, text: "// TODO item 0" });
  const docs = await call("grep", { pattern: "todo", ignoreCase: true, glob: "**/*.md" });
  assert.deepEqual(docs.matches.map((match: any) => match.path), ["/workspace/src/readme.md"]);
  const skipped = await call("grep", { pattern: "TODO", path: "/workspace/huge.txt" });
  assert.deepEqual([skipped.matches.length, skipped.filesSkipped], [0, 1], "files over the grep size limit are skipped");
  assert.equal((await call("grep", { pattern: "TODO", path: "/workspace/image.png" })).filesSkipped, 1, "binary files are skipped");
  const regex = await call("grep", { pattern: "value1\\d = ", regex: true, limit: 200 });
  assert.equal(regex.matches.length, 10);
  await assert.rejects(call("grep", { pattern: "(", regex: true }), /Invalid regular expression/);
});

test("a catastrophically backtracking grep pattern is stopped at its deadline without blocking the runtime", async () => {
  let ticks = 0;
  const ticker = setInterval(() => ticks++, 10);
  const started = Date.now();
  await assert.rejects(searchLines({ source: "(a+)+$", flags: "", files: [{ path: "/x", text: `${"a".repeat(900)}b` }], limit: 10, width: 240 }, Date.now() + 300, never), /ran out of time/);
  clearInterval(ticker);
  assert.ok(Date.now() - started < 2000);
  assert.ok(ticks >= 10, "the event loop kept running while the pattern backtracked");
});

/** An OpenAI-compatible provider on localhost; `reply` answers each request (default: "ok"). */
async function fixtureModel(t: Context, reply: (body: any, index: number) => Promise<unknown> | unknown = () => ({ role: "assistant", content: "ok" })) {
  const bodies: any[] = [];
  const provider = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    bodies.push(JSON.parse(raw));
    const delta = await reply(bodies.at(-1), bodies.length) as any;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const [content, finish_reason] of [[delta, null], [{}, delta.tool_calls ? "tool_calls" : "stop"]]) res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: content, finish_reason }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  provider.listen(0, "127.0.0.1"); await once(provider, "listening");
  t.after(async () => { provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); });
  const model = { id: "fixture", name: "Fixture", api: "openai-completions", provider: "openai", baseUrl: `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1024 } as Model<Api>;
  return { bodies, model };
}

/** Agents over SSE with volumes enabled, as the server wires them (default tenant, file storage). */
async function agents(t: Context) {
  const root = await mkdtemp(join(tmpdir(), "volumes-agents-"));
  const supervisor = new AgentSupervisor(join(root, "agents"), { runtime: process.env.AGENT_RUNTIME, hosting: process.env.AGENT_HOSTING as Hosting | undefined });
  const storage = fileStorage(join(root, "state"));
  const { db } = await testDatabase();
  let sessions: ClientSessions;
  const volumes = new VolumeService({ db, storage, deliver: (agent, tenant, request) => sessions.submit(agent, tenant, request) });
  sessions = new ClientSessions(supervisor, { db, storage, prefix: "client-sessions/", secret: "volumes-test-secret-with-32-characters", apiKey: "fixture-only", volumes });
  let model = (await fixtureModel(t)).model;
  const server = createServer(getRequestListener(async (req, env) => {
    if (new URL(req.url).pathname.startsWith("/clients/")) return sessions.app.fetch(req, env);
    try {
      const body = await readJson(req.body, FRAME_BYTES);
      return Response.json(await sessions.create(body.tools, { model }, req.headers.get("idempotency-key") ?? undefined, {}, "default", undefined, mountsFor.shift()), { status: 201 });
    } catch (error) { return Response.json({ error: String(error) }, { status: (error as any).status ?? 400 }); }
  }));
  const mountsFor: unknown[] = [];
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const clients: AgentClient[] = [];
  t.after(async () => {
    await Promise.all(clients.map(client => client.close()));
    await sessions.close();
    await supervisor.close();
    await volumes.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  return {
    volumes, sessions,
    setModel(chosen: Model<Api>) { model = chosen; },
    async start(mounts?: unknown) {
      mountsFor.push(mounts);
      const agent = await new AgentRuntime({ url, apiKey: "unused" }).createAgent({ tools: {} });
      clients.push(agent);
      return agent;
    },
  };
}

test("file tools work from js_exec, and agents share a volume through mounts", async t => {
  const f = await agents(t);
  const writer = await f.start();
  const workspace = VolumeService.workspaceOf(writer.session.id);
  const result = await writer.execute(`
    await tools.write({ path: "/workspace/notes/today.md", content: "ship volumes\\nTODO tests\\n" });
    const read = await tools.read({ path: "/workspace/notes/today.md" });
    await tools.edit({ path: "/workspace/notes/today.md", old: "TODO tests", new: "DONE tests", version: read.version });
    return {
      found: await tools.search("grep"),
      ls: await tools.ls({ path: "/workspace/notes" }),
      glob: await tools.glob({ pattern: "**/*.md" }),
      grep: await tools.grep({ pattern: "DONE" }),
      text: (await tools.read({ path: "/workspace/notes/today.md" })).content,
    };`);
  const value = JSON.parse(result.output[0]);
  assert.ok(JSON.stringify(value.found).includes("grep"));
  assert.deepEqual(value.ls.entries.map((entry: any) => entry.name), ["today.md"]);
  assert.deepEqual(value.glob.paths, ["/workspace/notes/today.md"]);
  assert.deepEqual(value.grep.matches, [{ path: "/workspace/notes/today.md", line: 2, text: "DONE tests" }]);
  assert.equal(value.text, "ship volumes\nDONE tests\n");
  await assert.rejects(writer.execute('return await tools.read({ path: "/workspace/missing.md" })'), /does not exist/);

  // A second agent mounts the writer's workspace read-only and is told about changes.
  const reader = await f.start([{ volumeId: workspace, path: "/shared", mode: "ro", subpath: "/notes", notify: true }]);
  assert.equal(JSON.parse((await reader.execute('return await tools.read({ path: "/shared/today.md" })')).output[0]).content, "ship volumes\nDONE tests\n");
  await assert.rejects(reader.execute('return await tools.write({ path: "/shared/today.md", content: "x" })'), /mounted read-only/);
  await assert.rejects(reader.execute('return await tools.ls({ path: "/workspace" })'), /not inside a mount/);
  await writer.execute('await tools.write({ path: "/workspace/notes/tomorrow.md", content: "more" }); await tools.write({ path: "/workspace/private.md", content: "outside the mount" })');
  let wake: any;
  for (let tries = 0; !(wake = (await reader.outcomes()).requests.find((request: any) => request.id.startsWith("volume-") && request.prompt.includes("tomorrow"))); tries++) {
    assert.ok(tries < 100, "the reader was prompted about the change");
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.match(wake.prompt, /\/shared\/tomorrow.md \(written\)/);
  assert.doesNotMatch(wake.prompt, /private/, "only changes inside the mount are reported");
  assert.equal((await writer.outcomes()).requests.some((request: any) => request.id.startsWith("volume-")), false, "writers are not woken by their own changes");

  // Mounts change through the owner of the agent; an idle agent restarts without the file tools.
  await reader.waitForRequest(wake.id);
  await f.sessions.setMounts(reader.session.id, "default", []);
  await assert.rejects(reader.execute('return await tools.read({ path: "/shared/today.md" })'), /not a function/);
  await assert.rejects(f.sessions.setMounts(reader.session.id, "default", [{ volumeId: workspace, path: "/a", mode: "ro" }, { volumeId: workspace, path: "/a/b", mode: "ro" }]), /overlaps/);
});

test("an edit based on a stale read is rejected and the model sees why", async t => {
  const f = await agents(t);
  let volume = "";
  const call = (name: string, args: unknown) => ({ role: "assistant", tool_calls: [{ index: 0, id: `call_${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
  const { bodies, model } = await fixtureModel(t, async (body, index) => {
    if (index === 1) return call("read", { path: "/workspace/plan.md" });
    if (index > 2) return { role: "assistant", content: "The plan changed; I will re-read it." };
    const version = JSON.parse(body.messages.at(-1).content).version;
    // Someone else writes the file between the model's read and its edit.
    await f.volumes.call(volume, "default", "commit", { path: "/plan.md", ...await f.volumes.store("default", Buffer.from("step one\nstep TWO\n")) });
    return call("edit", { path: "/workspace/plan.md", old: "step two", new: "step 2", version });
  });
  f.setModel(model);
  const agent = await f.start();
  volume = VolumeService.workspaceOf(agent.session.id);
  await f.volumes.call(volume, "default", "commit", { path: "/plan.md", ...await f.volumes.store("default", Buffer.from("step one\nstep two\n")) });
  assert.equal((await agent.prompt("Rename step two.")).error, null);
  assert.ok(bodies[0].tools.some((tool: any) => tool.function.name === "edit"), "file tools are direct tools");
  const result = bodies[2].messages.find((message: any) => message.role === "tool" && message.tool_call_id === "call_edit");
  assert.match(result.content, /Edit rejected: \/workspace\/plan.md changed since you read it \(you had version 1; it is now version 2\)/);
  const stored = await f.volumes.call(volume, "default", "stat", { path: "/plan.md" });
  assert.equal((await f.volumes.readRange("default", stored, 0, stored.size)).toString(), "step one\nstep TWO\n", "the other writer's change survived");
});

test("the REST API and SDK manage volumes within a tenant, and nothing crosses tenants", async t => {
  const root = await mkdtemp(join(tmpdir(), "volumes-api-"));
  const sha = (value: string) => createHash("sha256").update(value).digest("hex");
  const alice = "alice-volumes-token-at-least-24-chars", bob = "bob-volumes-token-at-least-24-chars";
  writeFileSync(join(root, "tenants.json"), JSON.stringify({ tenants: { alice: { tokenSha256: sha(alice), apiKeys: { "*": "fixture-key" } }, bob: { tokenSha256: sha(bob), apiKeys: { "*": "fixture-key" } } } }));
  const { url: databaseUrl } = await testDatabase();
  const child = spawn(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", fileURLToPath(new URL("../src/server.ts", import.meta.url))], {
    env: { PATH: process.env.PATH, HOME: root, AGENT_DATA_DIR: root, AGENT_DATABASE_URL: databaseUrl, PORT: "0", HOST: "127.0.0.1", AGENT_TENANTS_FILE: join(root, "tenants.json"), AGENT_SESSION_SECRET: "volumes-api-session-secret-with-32-chars", ...(process.env.AGENT_HOSTING ? { AGENT_HOSTING: process.env.AGENT_HOSTING } : {}) } as NodeJS.ProcessEnv,
    stdio: ["ignore", "pipe", "inherit"],
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const closed = once(child, "close"); child.kill("SIGTERM"); await closed; }
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const [line] = await once(child.stdout!, "data");
  const url = `http://127.0.0.1:${JSON.parse(String(line).split("\n")[0]).address.port}`;
  const as = (token: string) => new AgentRuntime({ url, apiKey: token, journalStore: memoryJournalStore() });
  const a = as(alice), b = as(bob);

  const created = await a.createVolume({ name: "reports" });
  const volume = a.volume(created.id);
  const large = new Uint8Array(2 * 1024 * 1024 + 5).map((_, index) => index % 251);
  const first = await volume.write("/data/large.bin", large, { version: 0 });
  assert.equal(first.size, large.length);
  await assert.rejects(volume.write("data/large.bin", "x", { version: 0 }), (error: AgentError) => error.status === 412);
  await assert.rejects(volume.write("data/large.bin", "x", { version: first.version + 7 }), (error: AgentError) => error.status === 412 && /is at version/.test(error.message));
  assert.deepEqual((await volume.read("data/large.bin")).data, large);
  // A range crossing a chunk boundary streams just those bytes.
  const range = await volume.read("data/large.bin", { range: [1024 * 1024 - 3, 1024 * 1024 + 3] });
  assert.deepEqual([...range.data], [...large.slice(1024 * 1024 - 3, 1024 * 1024 + 3)]);
  assert.equal(range.version, first.version);
  const raw = await fetch(`${url}/v1/volumes/${created.id}/files/data/large.bin`, { headers: { Authorization: `Bearer ${alice}`, Range: "bytes=99999999-" } });
  assert.equal(raw.status, 416);
  await volume.write("data/notes/a b.md", "spaces are fine");
  assert.deepEqual((await volume.list({ prefix: "/data", glob: "**/*.md" })).files.map(file => file.path), ["/data/notes/a b.md"]);
  assert.equal(await volume.readText("data/notes/a b.md"), "spaces are fine");
  const snapshot = await volume.snapshot({ name: "v1" });
  const fork = a.volume((await volume.fork({ name: "copy" })).id);
  await volume.remove("data/notes/a b.md");
  assert.equal(await fork.readText("data/notes/a b.md"), "spaces are fine");
  assert.deepEqual((await volume.snapshots()).map(entry => entry.id), [snapshot.id]);
  assert.deepEqual((await volume.changes()).changes.map(change => change.kind), ["write", "write", "delete"]);

  // An agent mounts the volume read-only; its default workspace is its own.
  const agent = await a.createAgent({ tools: {}, mounts: [{ volumeId: created.id, path: "/reports", mode: "ro", subpath: "/data" }] });
  t.after(() => agent.close());
  assert.equal(JSON.parse((await agent.execute('return await tools.ls({ path: "/reports" })')).output[0]).entries[0].name, "large.bin");
  assert.deepEqual(await a.mounts(agent.session.id), [{ volumeId: created.id, path: "/reports", mode: "ro", subpath: "/data" }]);
  const plain = await a.createAgent({ tools: {} });
  t.after(() => plain.close());
  const workspace = (await a.mounts(plain.session.id))[0];
  assert.deepEqual({ ...workspace, volumeId: "" }, { volumeId: "", path: "/workspace", mode: "rw" });
  assert.ok((await a.listVolumes()).some(entry => entry.id === workspace.volumeId && entry.name === "workspace"));

  // Bob sees none of it and cannot reach it by id, through the API, a mount, or his agents' tools.
  assert.deepEqual((await b.listVolumes()).filter(entry => entry.name !== "workspace"), []);
  const theirs = b.volume(created.id);
  for (const attempt of [() => theirs.info(), () => theirs.read("data/large.bin"), () => theirs.write("data/x", "x"), () => theirs.fork(), () => theirs.snapshot(), () => theirs.remove("data/large.bin"), () => theirs.delete(), () => theirs.list(), () => theirs.changes()]) {
    await assert.rejects(attempt(), (error: AgentError) => error.status === 404);
  }
  await assert.rejects(b.createAgent({ tools: {}, mounts: [{ volumeId: created.id, path: "/stolen", mode: "ro" }] }), /Unknown volume/);
  const bobs = await b.createAgent({ tools: {} });
  t.after(() => bobs.close());
  await assert.rejects(b.setMounts(bobs.session.id, [{ volumeId: created.id, path: "/stolen", mode: "ro" }]), (error: AgentError) => error.status === 404);
  await assert.rejects(b.setMounts(agent.session.id, []), (error: AgentError) => error.status === 404, "nor change Alice's agents' mounts");
  await assert.rejects(b.mounts(agent.session.id), (error: AgentError) => error.status === 404);

  // Deleting an agent deletes its own workspace, not the volumes it merely mounted.
  await plain.destroy();
  assert.equal((await a.listVolumes()).some(entry => entry.id === workspace.volumeId), false);
  await assert.rejects(a.volume(workspace.volumeId).info(), (error: AgentError) => error.status === 404);
  assert.ok((await volume.info()).id === created.id);

  await volume.delete();
  await assert.rejects(volume.info(), (error: AgentError) => error.status === 404);
  await assert.rejects(agent.execute('return await tools.ls({ path: "/reports" })'), /Unknown volume/);
  assert.equal(await fork.readText("data/large.bin").then(text => text.length > 0), true, "a fork outlives its source");
});
