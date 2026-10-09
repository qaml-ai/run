import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { AgentRuntime, fileBytes, publishTool, type ProjectFile } from "../clients/typescript.ts";
import { serveTools } from "../clients/server.ts";
import { testRuntime } from "../clients/testing.ts";
import { OPERATOR, OTHER_OPERATOR, runtime } from "./runtime-server.ts";

/** A check like an application's: every .ts file must export something, and nothing may be named secret. */
const validate = (files: ProjectFile[]) => files.flatMap(file =>
  file.path.includes("secret") ? [{ path: file.path, message: "no secrets in a project" }]
  : file.path.endsWith(".ts") && !file.text?.includes("export") ? [{ path: file.path, line: 1, message: "exports nothing" }] : []);

test("a project is a keyed volume seeded once, mounted with the workspace beside it, and published as checked snapshots", async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "ok" }));
  const sdk = new AgentRuntime({ url: r.base, apiKey: OPERATOR });
  const project = await sdk.projects.create({ key: "bot-1", template: { "bot.ts": "export const greet = () => 'hi';\n", "README.md": "# Bot\n" } });
  await project.volume.write("bot.ts", "export const greet = () => 'hello';\n");
  // The same key is the same project, and its template never overwrites what is there.
  const again = await sdk.projects.create({ key: "bot-1", template: { "bot.ts": "export const greet = () => 'hi';\n" } });
  assert.equal(again.id, project.id);
  assert.equal(await project.volume.readText("bot.ts"), "export const greet = () => 'hello';\n");
  assert.notEqual((await new AgentRuntime({ url: r.base, apiKey: OTHER_OPERATOR }).projects.create({ key: "bot-1" })).id, project.id, "keys are per tenant");

  // An agent works in it at /bot, with its workspace beside it.
  const builder = await sdk.upsertAgent("builder-1", { tools: {}, ...project.mount("/bot") });
  assert.deepEqual((await sdk.mounts(builder.session.id)).map(mount => [mount.path, mount.mode]), [["/bot", "rw"], ["/workspace", "rw"]]);

  // A publish that finds problems stores nothing and keeps no version.
  await project.volume.write("notes.ts", "// todo\n");
  const stored: { version: string; files: string[] }[] = [];
  const store = (files: ProjectFile[], version: { id: string }) => { stored.push({ version: version.id, files: files.map(file => file.path) }); return stored.length; };
  const refused = await project.publish({ validate, store });
  assert.deepEqual(refused, { ok: false, problems: [{ path: "/notes.ts", line: 1, message: "exports nothing" }] });
  assert.deepEqual(await project.versions(), []);

  // Fixed, it publishes: what was checked is what is stored, the snapshot is the version.
  await project.volume.write("notes.ts", "export const notes = [];\n");
  const published = await project.publish({ validate, store });
  assert.ok(published.ok);
  assert.deepEqual(stored, [{ version: published.version.id, files: ["/README.md", "/bot.ts", "/notes.ts"] }]);
  await project.volume.write("bot.ts", "export const greet = () => 'changed';\n");
  const v1 = await project.files({ version: published.version.id });
  assert.equal(new TextDecoder().decode(fileBytes(v1.files.find(file => file.path === "/bot.ts")!)), "export const greet = () => 'hello';\n");
  // The same idempotency key publishes once; older versions beyond `keep` go.
  const first = await project.publish({ validate, store, idempotencyKey: "call-1" });
  const retried = await project.publish({ validate, store, idempotencyKey: "call-1" });
  assert.ok(first.ok && retried.ok);
  assert.equal(retried.version.id, first.version.id);
  await project.publish({ validate, store, keep: 2 });
  assert.equal((await project.versions()).length, 2);

  // A deleted project's key makes no other.
  const gone = await sdk.projects.create({ key: "bot-gone" });
  await gone.volume.delete();
  await assert.rejects(sdk.projects.create({ key: "bot-gone" }), (error: { status?: number; message: string }) => error.status === 409 && /was deleted; use another key/.test(error.message));
});

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

test("a project is restored in place to a published version, and a check hands what it computed to store and the result", async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "ok" }));
  const sdk = new AgentRuntime({ url: r.base, apiKey: OPERATOR });
  const project = await sdk.projects.create({ key: "bot-restore", template: { "bot.ts": "export const v = 1;\n", "lib/util.ts": "export const u = 1;\n" } });
  // The check bundles as it checks; the bundle reaches store and the result, so nothing bundles twice.
  const bundle = (files: ProjectFile[]) => ({ problems: [], data: { entries: files.map(file => file.path), bytes: files.reduce((sum, file) => sum + file.size, 0) } });
  const kept: unknown[] = [];
  const published = await project.publish({ validate: bundle, store: (_files, version, { checked }) => { kept.push(checked); return version.id; } });
  assert.ok(published.ok);
  assert.deepEqual(published.checked, { entries: ["/bot.ts", "/lib/util.ts"], bytes: 40 });
  assert.deepEqual(kept, [published.checked]);
  const retried = await project.publish({ validate: bundle, store: (_files, _version, { checked }) => checked, idempotencyKey: "k" });
  const again = await project.publish({ validate: bundle, store: (_files, _version, { checked }) => checked, idempotencyKey: "k" });
  assert.ok(retried.ok && again.ok);
  assert.deepEqual(again.stored, retried.stored, "a retried publish hands on the same data");

  // The agent changes the project: a file changed, one added, one removed, a directory where a file was.
  await project.volume.write("bot.ts", "export const v = 2;\n");
  await project.volume.write("extra.ts", "export const e = 1;\n");
  await project.volume.remove("lib/util.ts");
  await project.volume.write("lib/util.ts/nested.ts", "export const n = 1;\n").catch(() => {});
  const before = (await project.volume.info()).seq;
  const restored = await project.restore(published.version.id);
  assert.ok(restored.written >= 2 && restored.removed >= 1, JSON.stringify(restored));
  const files = (await project.files()).files.map(file => [file.path, file.text]);
  assert.deepEqual(files, [["/bot.ts", "export const v = 1;\n"], ["/lib/util.ts", "export const u = 1;\n"]]);
  // Each restored file is a change, as agents mounting it hear of changes.
  const changes = (await project.volume.changes(before)).changes.map(change => [change.path, change.kind]);
  assert.ok(changes.some(([path, kind]) => path === "/bot.ts" && kind === "write"));
  assert.ok(changes.some(([path, kind]) => path === "/extra.ts" && kind === "delete"));
  // Restoring again changes nothing; the version is still published; an unknown snapshot is a 404.
  assert.deepEqual({ ...await project.restore(published.version.id), seq: 0 }, { snapshot: published.version.id, seq: 0, written: 0, removed: 0 });
  assert.ok((await project.versions()).some(version => version.id === published.version.id));
  await assert.rejects(project.restore("snap_0000000000000000"), (error: { status?: number }) => error.status === 404);

  // A version as a tar.gz, for a build: its files as it had them, named relative to the path asked for.
  await project.volume.write("bot.ts", "export const v = 3;\n");
  const unpack = async (archive: { body: ReadableStream<Uint8Array> }) => {
    const dir = await mkdtemp(join(tmpdir(), "project-archive-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, "a.tar.gz"), Buffer.from(await new Response(archive.body).arrayBuffer()));
    execFileSync("tar", ["-xzf", "a.tar.gz"], { cwd: dir });
    return dir;
  };
  const whole = await project.archive({ version: published.version.id });
  assert.ok(whole.seq > 0);
  const dir = await unpack(whole);
  assert.equal(readFileSync(join(dir, "bot.ts"), "utf8"), "export const v = 1;\n");
  assert.equal(readFileSync(join(dir, "lib/util.ts"), "utf8"), "export const u = 1;\n");
  const lib = await unpack(await project.archive({ path: "/lib" }));
  assert.deepEqual(readdirSync(lib).sort(), ["a.tar.gz", "util.ts"]);
  const live = await unpack(await project.archive());
  assert.equal(readFileSync(join(live, "bot.ts"), "utf8"), "export const v = 3;\n");
});

test("pinned versions outlast keep and the snapshot cap, carry labels, and a snapshot can be made from contents", async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "ok" }));
  const sdk = new AgentRuntime({ url: r.base, apiKey: OPERATOR });
  const project = await sdk.projects.create({ key: "bot-pinned", template: { "bot.ts": "export const v = 1;\n" } });
  const store = () => "stored";
  // A release pins its version with a label; plain publishes come and go with keep.
  const release = await project.publish({ store, pin: true, labels: { release: "v1" } });
  assert.ok(release.ok);
  assert.deepEqual([release.version.pinned, release.version.labels], [true, { release: "v1" }]);
  for (let i = 2; i <= 4; i++) {
    await project.volume.write("bot.ts", `export const v = ${i};\n`);
    assert.ok((await project.publish({ store, keep: 2 })).ok);
  }
  const versions = await project.versions();
  assert.equal(versions.length, 3, "the pinned release and the last two");
  assert.ok(versions.some(version => version.id === release.version.id));
  assert.deepEqual((await project.versions({ labels: { release: "v1" } })).map(version => version.id), [release.version.id]);
  assert.deepEqual(await project.versions({ labels: { release: "v9" } }), []);
  // Labels change by PATCH; ?label= filters over REST too.
  await project.pin(release.version.id, { release: "v1", channel: "stable" });
  assert.equal((await r.call(`/v1/volumes/${project.id}/snapshots?label=channel:stable&label=release:v1`)).json.length, 1);
  assert.equal((await r.call(`/v1/volumes/${project.id}/snapshots`, { method: "PATCH" as never, body: {} })).status, 404);
  assert.equal((await r.call(`/v1/volumes/${project.id}/snapshots/${release.version.id}`, { method: "PATCH", body: { labels: { ["k".repeat(65)]: "x" } } })).status, 400);

  // A pinned snapshot is kept from a delete, unless forced or unpinned; restoring another version keeps it.
  await assert.rejects(project.volume.deleteSnapshot(release.version.id), (error: { status?: number }) => error.status === 409);
  const latest = versions.at(-1)!;
  await project.restore(release.version.id);
  assert.equal(await project.volume.readText("bot.ts"), "export const v = 1;\n");
  assert.equal((await project.versions()).length, 3, "a restore keeps every snapshot");
  assert.ok((await project.unpin(latest.id)).pinned === false);

  // From contents: a pinned snapshot of files given, the volume untouched; read, archived and restored like any other.
  const before = await project.volume.info();
  const imported = await project.volume.snapshot({ name: "published:import-v0", pinned: true, labels: { release: "v0" }, files: { "/bot.ts": "export const v = 0;\n", "/data.bin": new Uint8Array([0, 1, 2]) } });
  assert.deepEqual([imported.pinned, imported.files, imported.bytes], [true, 2, 23]);
  const after = await project.volume.info();
  assert.deepEqual([after.seq, after.files], [before.seq, before.files], "the volume is untouched");
  const read = await project.files({ version: imported.id });
  assert.deepEqual(read.files.map(file => [file.path, file.text ?? file.data]), [["/bot.ts", "export const v = 0;\n"], ["/data.bin", "AAEC"]]);
  assert.ok((await project.archive({ version: imported.id })).seq >= 0);
  assert.equal(new TextDecoder().decode((await project.volume.read("bot.ts", { snapshot: imported.id })).data), "export const v = 0;\n");
  for (const files of [{ "/": "x" }, { "/a": 1 }, Object.fromEntries(Array.from({ length: 1001 }, (_, i) => [`/f${i}`, "x"]))]) {
    const refused = await r.call(`/v1/volumes/${project.id}/snapshots`, { body: { files } });
    assert.ok(refused.status === 400 || refused.status === 413, `${refused.status} ${refused.text}`);
  }

  // Pinned snapshots count apart: a volume at its 100 others still takes a pinned one, and refuses a 101st other.
  const crowded = await sdk.createVolume({ name: "crowded" });
  const volume = sdk.volume(crowded.id);
  for (let i = 0; i < 100; i++) await volume.snapshot({ name: `s${i}` });
  await assert.rejects(volume.snapshot({ name: "one too many" }), (error: { status?: number }) => error.status === 409);
  assert.ok((await volume.snapshot({ name: "kept", pinned: true })).pinned);
  // A forced delete takes a pinned one; deleting the volume takes the rest, pinned or not.
  await volume.deleteSnapshot((await volume.snapshots({ labels: {} })).at(-1)!.id, { force: true });
  assert.equal((await r.call(`/v1/volumes/${crowded.id}`, { method: "DELETE" })).status, 200);
  assert.equal((await r.call(`/v1/volumes/${project.id}`, { method: "DELETE" })).status, 200);
});
