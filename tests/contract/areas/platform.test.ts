import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentError, AgentRuntime } from "../../../clients/node.ts";
import { PNG, pdfBytes } from "../../file-fixtures.ts";
import { contractTest, OPERATOR, OTHER_OPERATOR, toolCall, until } from "../support.ts";

// Original public assertions are retained. Only server construction is replaced.
for (const provider of ['daytona', 'sprites']) contractTest("computers", "tests/computers-api.test.ts",`native ${provider} computer API is tenant scoped and tools refresh on an existing agent`, async (t, r) => {
  const seen: string[][] = [];
  r.setModel( (body, index) => {
    seen.push((body.tools ?? []).map((tool: any) => tool.function.name));
    return index === 1 ? toolCall('computer_status', {}, 'status') : { role: 'assistant', content: 'done' };
  });
  const made = await r.call('/v1/agents', { body: { name: 'Computer test', codeMode: false, fileTools: false } });
  assert.equal(made.status, 201, made.text);
  const agent = made.json.id;
  await r.prompt(agent, 'Before connecting');
  assert.ok(!seen[0].includes('computer_status'));
  const input = { agent, provider, credentials: { apiKey: 'test-secret-do-not-return' }, leaseSeconds: 60, dailySeconds: 120 };
  assert.equal((await r.call('/v1/computers', {body:{...input, credentials:{}}})).status, 400);
  assert.equal((await r.call('/v1/computers', {body:{...input, credentials:{...input.credentials, tokenId:'extra'}}})).status, 400);
  assert.equal((await r.call('/v1/computers', { body: input, token: OTHER_OPERATOR })).status, 404);
  const connected = await r.call('/v1/computers', { body: input });
  assert.equal(connected.status, 201, connected.text);
  assert.doesNotMatch(connected.text, /test-secret-do-not-return/);
  assert.equal((await r.call('/v1/computers', { body: input })).status, 409);
  await r.prompt(agent, 'Inspect the computer');
  assert.ok(seen[1].includes('computer_status'));
  assert.ok(seen[1].includes('computer_exec'));
  const result = await r.call(`/v1/agents/${agent}/computer`);
  assert.equal(result.json.session, null);
  assert.equal((await r.call(`/v1/agents/${agent}/computer`, { token: OTHER_OPERATOR })).status, 404);
  assert.equal((await r.call(`/v1/computers/${connected.json.id}`, { method: 'DELETE', token: OTHER_OPERATOR })).status, 404);
  assert.equal((await r.call(`/v1/computers/${connected.json.id}`, { method: 'DELETE' })).status, 200);
  await r.prompt(agent, 'After disconnecting');
  assert.ok(!seen.at(-1)!.includes('computer_status'));
});

contractTest("computers", "tests/computers-api.test.ts",'a computer connected during eager startup is available on the first turn', async (t, r) => {
  r.setModel( (_body,index) => index === 0 ? toolCall('computer_status',{},'first') : { role:'assistant', content:'done' });
  const agent = (await r.call('/v1/agents',{body:{name:'New computer agent',codeMode:false,fileTools:false}})).json.id;
  assert.equal((await r.call('/v1/computers',{body:{agent,provider:'daytona',credentials:{apiKey:'fake'},leaseSeconds:60,dailySeconds:120}})).status,201);
  await r.prompt(agent,'Inspect your computer');
  assert.ok(r.model.bodies[0].tools.some((tool: any) => tool.function.name === 'computer_status'));
  const result = r.model.bodies[1].messages.find((message: any) => message.role === 'tool');
  assert.doesNotMatch(JSON.stringify(result), /unavailable|not available|error/);
});


for (const builtin of ['delegate', 'agents']) for (const subagents of [true, false]) contractTest("computers", "tests/computers-api.test.ts",`${builtin} child creation inherits computer attachments when asked for a fresh computer: ${subagents}`, async (t, r) => {
  r.setModel( body => {
    const system = body.messages.filter((m: any) => m.role === 'system' || m.role === 'developer').map((m: any) => JSON.stringify(m.content)).join(' ');
    if (!system.includes('COMPUTER_PARENT') || body.messages.some((m: any) => m.role === 'tool')) return { role: 'assistant', content: 'done' };
    return toolCall(builtin === 'agents' ? 'spawn_agent' : 'delegate', { agent: 'worker', task: 'child task', computer: 'fresh' }, 'child');
  });
  await r.call('/v1/definitions', { headers: { 'Idempotency-Key': 'worker' }, body: { name: 'Worker', systemPrompt: 'COMPUTER_CHILD' } });
  const parent = (await r.call('/v1/agents', { body: { systemPrompt: 'COMPUTER_PARENT', builtins: [builtin], delegate: { agents: ['worker'] } } })).json.id;
  const attached = await r.call('/v1/computers', { body: { agent: parent, provider: 'e2b', credentials: { apiKey: 'fixture-only' }, subagents } });
  assert.equal(attached.status, 201, attached.text);
  assert.equal(attached.json.subagents, subagents);
  const run = await r.prompt(parent, 'start');
  const child = run.outcome.result.toolCalls.find((c: any) => c.agentId)?.agentId;
  assert.ok(child);
  const status = await r.call(`/v1/agents/${child}/computer`);
  assert.equal(status.status, subagents ? 200 : 404, status.text);
  if (subagents) {
    assert.notEqual(status.json.connection.id, attached.json.id);
    assert.equal(status.json.connection.provider, 'e2b');
    assert.equal(status.json.connection.subagents, true);
    assert.equal(status.json.session, null);
    assert.equal((await r.call(`/v1/agents/${parent}/computer`)).json.session, null);
  }
  await r.call(`/v1/agents/${child}`, { method: 'DELETE' });
  assert.ok(!(await r.call('/v1/computers')).json.some((c: any) => c.agent === child));
});
// Children share their parent computer unless explicitly opted out.
for (const builtin of ['delegate', 'agents']) for (const [name, target, computer, has] of [
  ['an instructions child shares the computer by default', { instructions: 'You check one thing.' }, undefined, true],
  ['a definition child shares the computer by default', { agent: 'worker' }, undefined, true],
  ['an explicit none gives a child no computer', { instructions: 'You check one thing.' }, 'none', false],
  ['an explicit fresh gives a child a computer', { instructions: 'You check one thing.' }, 'fresh', true],
] as const) contractTest("computers", "tests/computers-api.test.ts", `${builtin}: ${name}`, async (t, r) => {
  const childTools: string[][] = [];
  r.setModel(body => {
    const system = body.messages.filter((m: any) => m.role === 'system' || m.role === 'developer').map((m: any) => JSON.stringify(m.content)).join(' ');
    if (system.includes('COMPUTER_PARENT')) return body.messages.some((m: any) => m.role === 'tool') ? { role: 'assistant', content: 'done' }
      : toolCall(builtin === 'agents' ? 'spawn_agent' : 'delegate', { ...target, task: 'child task', ...computer ? { computer } : {} }, 'child');
    childTools.push((body.tools ?? []).map((tool: any) => tool.function.name));
    return { role: 'assistant', content: 'done' };
  });
  await r.call('/v1/definitions', { headers: { 'Idempotency-Key': 'worker' }, body: { name: 'Worker', systemPrompt: 'COMPUTER_CHILD' } });
  const parent = (await r.call('/v1/agents', { body: { systemPrompt: 'COMPUTER_PARENT', builtins: [builtin], delegate: { agents: ['worker'], instructions: true } } })).json.id;
  assert.equal((await r.call('/v1/computers', { body: { agent: parent, provider: 'e2b', credentials: { apiKey: 'fixture-only' }, subagents: true } })).status, 201);
  const run = await r.prompt(parent, 'start');
  const child = run.outcome.result.toolCalls.find((c: any) => c.agentId)?.agentId;
  assert.ok(child);
  assert.equal((await r.call(`/v1/agents/${child}/computer`)).status, has ? 200 : 404);
  if (builtin === 'delegate') {
    assert.equal(childTools.length, 1);
    assert.equal(childTools[0].some(tool => tool.startsWith('computer_')), has);
  }
});
contractTest("files", "tests/files.test.ts:76","the REST API stores the upload's type and serves downloads with safe headers", async (t, server) => {
  const volume = (await server.call("/v1/volumes", { body: { name: "files" } })).json.id;
  const auth = { Authorization: `Bearer ${OPERATOR}` };
  const put = (path: string, body: Uint8Array | string, type?: string) => fetch(`${server.base}/v1/volumes/${volume}/files/${path}`, { method: "PUT", body: body as BodyInit, headers: { ...auth, ...(type ? { "Content-Type": type } : {}) } }).then(response => response.json());
  assert.equal((await put("page.html", "<script>alert(1)</script>", "text/html")).contentType, "text/html");
  assert.equal((await put("pic", PNG)).contentType, "image/png");
  const html = await fetch(`${server.base}/v1/volumes/${volume}/files/page.html`, { headers: auth });
  assert.equal(html.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(html.headers.get("x-content-type-options"), "nosniff");
  assert.equal(html.headers.get("content-security-policy"), "sandbox; default-src 'none'");
  assert.match(html.headers.get("content-disposition")!, /^attachment/);
  // Proxies may weaken or drop the ETag (Cloudflare's gzip makes it W/"n"); the version has a header of its own.
  assert.equal(html.headers.get("x-file-version"), html.headers.get("etag")!.replaceAll('"', ""));
  const pic = await fetch(`${server.base}/v1/volumes/${volume}/files/pic`, { headers: { ...auth, Range: "bytes=0-7" } });
  assert.equal(pic.status, 206);
  assert.equal(pic.headers.get("content-type"), "image/png");
  assert.match(pic.headers.get("content-disposition")!, /^inline/);
  const listing = (await server.call(`/v1/volumes/${volume}/files`)).json;
  assert.deepEqual(listing.files.map((file: any) => file.contentType), ["text/html", "image/png"]);
});

contractTest("files", "tests/files.test.ts:98","signed links: bound to tenant, volume, path, method, expiry, size and content type; tampering fails", async (t, server) => {
  const volume = (await server.call("/v1/volumes", { body: { name: "links" } })).json.id;
  await fetch(`${server.base}/v1/volumes/${volume}/files/docs/a.txt`, { method: "PUT", body: "hello", headers: { Authorization: `Bearer ${OPERATOR}` } });
  const link = async (body: object, token?: string) => server.call(`/v1/volumes/${volume}/links`, { body, token });
  const local = (url: string) => url.replace("https://agents.example.test", server.base);

  const get = (await link({ path: "/docs/a.txt" })).json;
  assert.match(get.url, /^https:\/\/agents\.example\.test\/v1\/links\/[\w-]+\.[\w-]+\/a\.txt$/);
  assert.ok(get.expiresAt > Date.now() + 14 * 60_000 && get.expiresAt <= Date.now() + 15 * 60_000, "15 minutes by default");
  const fetched = await fetch(local(get.url));
  assert.equal(await fetched.text(), "hello");
  assert.equal(fetched.headers.get("x-content-type-options"), "nosniff");
  assert.equal(fetched.headers.get("content-type"), "text/plain; charset=utf-8");
  // The name segment is only for browsers; the grant names the file.
  assert.equal(await (await fetch(local(get.url).replace(/a\.txt$/, "other.txt"))).text(), "hello");
  assert.equal((await fetch(local(get.url), { method: "PUT", body: "x" })).status, 405, "a download link cannot upload");

  // Tampering with the grant or the signature fails.
  const [prefix, token] = [local(get.url).split("/v1/links/")[0], local(get.url).split("/v1/links/")[1].split("/")[0]];
  const [payload, mac] = token.split(".");
  const grant = JSON.parse(Buffer.from(payload, "base64url").toString());
  const forged = Buffer.from(JSON.stringify({ ...grant, path: "/docs/secret.txt" })).toString("base64url");
  // The signature's first character always changes the MAC (its last carries only 4 bits, and may already be what a swap writes).
  const otherMac = `${mac[0] === "A" ? "B" : "A"}${mac.slice(1)}`;
  for (const bad of [`${forged}.${mac}`, `${payload}.${otherMac}`, payload, `${payload}.${mac}.x`]) {
    const response = await fetch(`${prefix}/v1/links/${bad}/a.txt`);
    assert.equal(response.status, 403, bad);
  }
  assert.equal((await link({ path: "/docs/a.txt", expiresIn: 90_000 })).status, 400, "lifetimes are capped");
  assert.equal((await link({ path: "/docs/a.txt" }, "other-operator-token-at-least-24-chars")).status, 404, "another tenant cannot sign for this volume");

  // Upload links: size and content type are part of the grant.
  const put = (await link({ path: "/in/photo.png", method: "PUT", maxBytes: PNG.length, contentType: "image/png" })).json;
  assert.equal((await fetch(local(put.url), { method: "PUT", body: Buffer.concat([PNG, Buffer.from("x")]) })).status, 413);
  assert.equal((await fetch(local(put.url), { method: "PUT", body: PNG, headers: { "Content-Type": "text/html" } })).status, 415);
  const uploaded = await fetch(local(put.url), { method: "PUT", body: PNG });
  assert.equal(uploaded.status, 201);
  assert.deepEqual(await uploaded.json().then(({ path, size, contentType, by }) => ({ path, size, contentType, by })), { path: "/in/photo.png", size: PNG.length, contentType: "image/png", by: "link" });
  assert.equal((await fetch(local(put.url))).status, 405, "an upload link cannot download");

  const brief = (await link({ path: "/docs/a.txt", expiresIn: 1 })).json;
  await new Promise(resolve => setTimeout(resolve, 1100));
  const expired = await fetch(local(brief.url));
  assert.equal(expired.status, 403);
  assert.match((await expired.json()).error, /expired/);
  // A deleted volume's links stop working.
  await server.call(`/v1/volumes/${volume}`, { method: "DELETE" });
  assert.equal((await fetch(local(get.url))).status, 404);
});

contractTest("files", "tests/files.test.ts:261","the TypeScript SDK attaches bytes, Blobs, local paths and workspace files; a file deleted or replaced after attaching still reads as attached", async (t, server) => {
  server.setModel(() => ({ role: "assistant", content: "seen" }));
  const client = new AgentRuntime({ url: server.base, apiKey: OPERATOR });
  const agent = await client.createAgent({ tools: {} });
  t.after(() => agent.close());
  const root = await mkdtemp(join(tmpdir(), "contract-files-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const local = join(root, "notes.txt");
  writeFileSync(local, "local notes");
  const pdf = pdfBytes(["Invoice 42"]);
  await agent.files.upload("/workspace/in/earlier.png", PNG);
  const result = await agent.prompt("Look", { idempotencyKey: "with-files", files: [PNG, new Blob([pdf], { type: "application/pdf" }), local, { path: "/workspace/in/earlier.png" }, { name: "data.csv", data: new TextEncoder().encode("a,b"), contentType: "text/csv" }] });
  assert.equal(result.reply, "seen");
  const listing = await agent.files.list({ path: "/workspace/uploads/with-files" });
  assert.deepEqual(listing.files.map(file => [file.path, file.contentType]), [
    ["/workspace/uploads/with-files/attachment-1", "image/png"], ["/workspace/uploads/with-files/attachment-2", "application/pdf"],
    ["/workspace/uploads/with-files/data.csv", "text/csv"], ["/workspace/uploads/with-files/notes.txt", "text/plain"],
  ]);
  const first = server.model.bodies.at(-1).messages.find((message: any) => message.role === "user").content;
  assert.equal(first.filter((part: any) => part.type === "image_url").length, 2);
  assert.equal(first.filter((part: any) => part.type === "file").length, 1);
  assert.ok(first.some((part: any) => part.text?.startsWith("[File /workspace/uploads/with-files/notes.txt (text/plain")));
  assert.ok(first.some((part: any) => part.text === "[File /workspace/uploads/with-files/data.csv (text/csv, 1 KB), beginning:\na,b]"), "a text file comes with its first lines");

  // The attached files change afterwards: the earlier message still carries what was attached.
  const volume = (await client.mounts(agent.session.id))[0].volumeId;
  await client.volume(volume).remove("/uploads/with-files/attachment-1");
  await agent.files.upload("/workspace/in/earlier.png", Buffer.concat([PNG, Buffer.from("changed")]));
  await agent.prompt("Again");
  const replayed = server.model.bodies.at(-1).messages.find((message: any) => message.role === "user").content.filter((part: any) => part.type === "image_url").map((part: any) => part.image_url.url);
  assert.deepEqual(replayed, [`data:image/png;base64,${PNG.toString("base64")}`, `data:image/png;base64,${PNG.toString("base64")}`]);
  assert.deepEqual(JSON.stringify(server.model.bodies.at(-2).messages.slice(0, 2)), JSON.stringify(server.model.bodies.at(-1).messages.slice(0, 2)), "the same references give the same request: the cached prefix holds");

  // Files out: download and a signed link, with the agent's token only.
  const downloaded = await agent.files.download("/workspace/uploads/with-files/data.csv");
  assert.deepEqual([new TextDecoder().decode(downloaded.data), downloaded.contentType], ["a,b", "text/csv"]);
  const link = await agent.files.link("/workspace/uploads/with-files/data.csv");
  assert.equal(link.path, "/workspace/uploads/with-files/data.csv");
  assert.equal(await (await fetch(link.url.replace("https://agents.example.test", server.base))).text(), "a,b");
  await assert.rejects(agent.files.link("/elsewhere/x"), (error: AgentError) => error.status === 400);
  await assert.rejects(agent.prompt("x", { files: [{ path: "/workspace/nope" }] }), (error: AgentError) => error.status === 400 && /does not exist/.test(error.message));
});

contractTest("volumes", "tests/volumes.test.ts:538","the REST API and SDK manage volumes within a tenant, and nothing crosses tenants", async (t, r) => {
  const url = r.base, alice = OPERATOR, bob = OTHER_OPERATOR;
  const as = (token: string) => new AgentRuntime({ url, apiKey: token });
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

  // Many files read at once, at one seq, or as a snapshot had them.
  const project = a.volume((await a.createVolume({ name: "project" })).id);
  await project.write("src/a.ts", "export const a = 1;\n");
  await project.write("src/b.ts", "export const b = 2;\n");
  await project.write("logo.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
  const all = await project.readAll();
  assert.equal(all.seq, (await project.info()).seq);
  assert.deepEqual(all.files.map(entry => [entry.path, entry.text ?? null, entry.data ?? null]), [
    ["/logo.png", null, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]).toString("base64")],
    ["/src/a.ts", "export const a = 1;\n", null], ["/src/b.ts", "export const b = 2;\n", null],
  ]);
  assert.equal(all.files[1].sha256, createHash("sha256").update("export const a = 1;\n").digest("hex"));
  assert.deepEqual((await project.readAll({ prefix: "/src", glob: "a.*" })).files.map(entry => entry.path), ["/src/a.ts"]);
  const published = await project.snapshot({ name: "v1" });
  await project.write("src/a.ts", "export const a = 3;\n");
  await project.remove("src/b.ts");
  const then = await project.readAll({ snapshot: published.id });
  assert.deepEqual([then.seq, then.snapshot, then.files.map(entry => entry.text ?? "")], [published.seq, published.id, ["", "export const a = 1;\n", "export const b = 2;\n"]]);
  assert.equal(new TextDecoder().decode((await project.read("src/a.ts", { snapshot: published.id })).data), "export const a = 1;\n");
  assert.equal(await project.readText("src/a.ts"), "export const a = 3;\n");
  assert.deepEqual((await project.list({ snapshot: published.id })).files.map(entry => entry.path), ["/logo.png", "/src/a.ts", "/src/b.ts"]);
  await assert.rejects(project.readAll({ snapshot: "snap_0000000000000000" }), (error: AgentError) => error.status === 404);
  // Changes under a path, and several volumes' seqs in one request.
  assert.deepEqual((await project.changes(0, { prefix: "/src" })).changes.map(change => [change.kind, change.path]), [["write", "/src/a.ts"], ["write", "/src/b.ts"], ["write", "/src/a.ts"], ["delete", "/src/b.ts"]]);
  assert.deepEqual((await a.volumes([project.id, created.id])).map(entry => [entry.id, entry.seq]), [[project.id, (await project.info()).seq], [created.id, (await volume.info()).seq]]);
  await assert.rejects(b.volume(project.id).readAll(), (error: AgentError) => error.status === 404, "another tenant reads nothing");

  // An agent mounts the volume read-only; its default workspace is its own.
  const agent = await a.createAgent({ tools: {}, mounts: [{ volumeId: created.id, path: "/reports", mode: "ro", subpath: "/data" }] });
  t.after(() => agent.close());
  assert.equal(JSON.parse((await agent.execute('return await tools.ls({ path: "/reports" })')).output[0]).entries[0].name, "large.bin");
  const given = await a.mounts(agent.session.id);
  assert.deepEqual(given[0], { volumeId: created.id, path: "/reports", mode: "ro", subpath: "/data" });
  assert.deepEqual(given.slice(1).map(mount => [mount.path, mount.volumeId === `vol_${createHash("sha256").update(`workspace:${agent.session.id}`).digest("hex").slice(0, 24)}`]), [["/workspace", true]], "its own workspace beside the mounts given");
  const bare = await a.createAgent({ tools: {}, mounts: [{ volumeId: created.id, path: "/reports", mode: "ro" }, { workspace: false }] });
  t.after(() => bare.close());
  assert.deepEqual((await a.mounts(bare.session.id)).map(mount => mount.path), ["/reports"], "{workspace: false} leaves it out");
  const replaced = await a.createAgent({ tools: {}, mounts: [{ volumeId: created.id, path: "/workspace", mode: "rw" }] });
  t.after(() => replaced.close());
  assert.deepEqual((await a.mounts(replaced.session.id)).map(mount => [mount.path, mount.volumeId]), [["/workspace", created.id]], "a mount at /workspace takes its place");
  const files = (await a.toolSources(agent.session.id, { schemas: true })).find(source => source.kind === "files")!;
  assert.ok(files.tools.some(tool => tool.name === "read" && tool.parameters));
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

  // A volume made with an idempotency key is made once.
  const keyed = await a.createVolume({ name: "draft" }, { idempotencyKey: "draft-bot-1" });
  assert.equal((await a.createVolume({ name: "draft" }, { idempotencyKey: "draft-bot-1" })).id, keyed.id);

  // {workspace: true} keeps the agent's own workspace beside other mounts; the first mount is where relative paths go.
  const both = await a.upsertAgent("builder-1", { tools: {}, mounts: [{ volumeId: keyed.id, path: "/bot", mode: "rw" }, { workspace: true }] });
  const mounted = await a.mounts(both.session.id);
  assert.deepEqual(mounted.map(mount => [mount.path, mount.mode]), [["/bot", "rw"], ["/workspace", "rw"]]);
  assert.match(mounted[1].volumeId, /^vol_[a-f0-9]{24}$/);
  assert.equal((await a.upsertAgent("builder-1", { tools: {}, mounts: [{ volumeId: keyed.id, path: "/bot", mode: "rw" }, { workspace: true }] })).session.id, both.session.id, "the same mounts again are no change");
  await assert.rejects(a.createAgent({ tools: {}, mounts: [{ workspace: true }, { volumeId: keyed.id, path: "/workspace/bot", mode: "rw" }] }), /overlaps/);
  // Other mounts on an upsert are a 409, unless it says remount: true; then they are set between its turns.
  const elsewhere = [{ volumeId: keyed.id, path: "/draft", mode: "rw" as const }, { workspace: true as const }];
  await assert.rejects(a.upsertAgent("builder-1", { tools: {}, mounts: elsewhere }), (error: AgentError) => error.status === 409 && /mounts cannot change.*remount: true/.test(error.message));
  const moved = await a.upsertAgent("builder-1", { tools: {}, mounts: elsewhere, remount: true });
  assert.ok(moved.reconfigured);
  await until(async () => (await a.mounts(both.session.id))[0].path === "/draft", "the new mounts");
  assert.deepEqual((await a.mounts(both.session.id)).map(mount => mount.volumeId), [keyed.id, mounted[1].volumeId], "the same workspace");
  await a.upsertAgent("builder-1", { tools: {}, mounts: [{ volumeId: keyed.id, path: "/bot", mode: "rw" }, { workspace: true }], remount: true });
  await until(async () => (await a.mounts(both.session.id))[0].path === "/bot", "the mounts back");

  // An agent's own workspace goes with it even when later mounts left it out.
  const dropped = mounted[1].volumeId;
  await a.setMounts(both.session.id, [{ volumeId: keyed.id, path: "/bot", mode: "rw" }]);
  assert.ok((await a.volume(dropped).info()).id === dropped, "still there while the agent is");
  assert.equal((await fetch(`${url}/v1/agents/${both.session.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${alice}` } })).status, 200);
  await until(async () => (await a.volume(dropped).info().then(() => false, (error: AgentError) => error.status === 404)), "the dropped workspace to be deleted");
  assert.ok((await a.volume(keyed.id).info()).id === keyed.id, "the mounted volume stays");

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

