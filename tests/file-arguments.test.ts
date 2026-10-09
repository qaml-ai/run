import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { RuntimeTokenError, verifyFileUrl } from "../clients/server.ts";
import { testRuntime } from "../clients/testing.ts";
import { Accounts } from "../src/accounts.ts";
import { RuntimeSigner } from "../src/identity.ts";
import { TOOL_FILE_LIMITS } from "../src/limits.ts";
import { postgresTail } from "../src/log-tail.ts";
import { Tenants } from "../src/tenants.ts";
import { VolumeService, VOLUME_LIMITS } from "../src/volumes.ts";
import { memoryStorage } from "../shared/storage.ts";
import { testDatabase } from "./database.ts";
import { PNG, pdfBytes } from "./file-fixtures.ts";
import { listen, OPERATOR, runtime, toolCall, toolResults, type T } from "./runtime-server.ts";

const LOCAL = { AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32" };
const auth = { Authorization: `Bearer ${OPERATOR}` };
const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");
/** A PDF of 1.5 MiB: two chunks, so its digest is read. */
const REPORT = Buffer.concat([pdfBytes(["Quarterly report"]), Buffer.alloc(1536 * 1024, 0x20)]);
const MAX_SIZE = 2 * 1024 * 1024;
const LONG_NAME = `long/${"n".repeat(120)}.txt`;

const put = (base: string, volume: string, path: string, body: Uint8Array | string) =>
  fetch(`${base}/v1/volumes/${volume}/files/${path}`, { method: "PUT", body: body as BodyInit, headers: auth }).then(response => response.json());

const fileParameter = (spec: Record<string, unknown>, directory = false) => ({ type: "string", format: "uri", "x-mcp-file": spec, ...(directory ? { "x-camelrun-directory": true } : {}) });

/**
 * An MCP server whose tools take files as SEP-2631 marks them: `attach` a PDF by URL (up to MAX_SIZE), `inline` an
 * image inline only, `site` a directory. Like a remote server it fetches what it is sent while the call runs; `site`
 * also has the agent's directory change under it meanwhile. `links` answers with links to files.
 */
async function appServer(t: T, state: { base: string; workspace: string; pages: string }) {
  const calls: { name: string; args: any; meta: any; got?: any }[] = [];
  const url = await listen(t, async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const server = new Server({ name: "app", version: "1" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
      { name: "attach", description: "Attach a document", inputSchema: { type: "object", properties: { attachment: fileParameter({ accept: ["application/pdf"], maxSize: MAX_SIZE }) } } },
      { name: "inline", description: "Look at an image", inputSchema: { type: "object", properties: { image: fileParameter({ accept: ["image/*"], transferModes: ["inline"] }) } } },
      { name: "site", description: "Deploy a site", inputSchema: { type: "object", properties: { dir: fileParameter({}, true) } } },
      { name: "links", description: "Make files", inputSchema: { type: "object", properties: {} } },
      { name: "loose", description: "Takes anything", inputSchema: { type: "object" } },
    ] }));
    server.setRequestHandler(CallToolRequestSchema, async request => {
      const { name, arguments: args, _meta: meta } = request.params as { name: string; arguments: any; _meta: any };
      const call: (typeof calls)[number] = { name, args, meta };
      calls.push(call);
      if (name === "attach") {
        const response = await fetch(args.attachment);
        call.got = { status: response.status, type: response.headers.get("content-type"), bytes: Buffer.from(await response.arrayBuffer()) };
      }
      if (name === "site") {
        const manifest = await (await fetch(args.dir)).json();
        // The agent's files change while the tool works: it still reads them as they were at the call.
        await put(state.base, state.workspace, "site/index.html", "<h1>v2</h1>");
        await put(state.base, state.workspace, "site/new.txt", "new");
        const index = manifest.files.find((file: any) => file.path === "index.html");
        call.got = { manifest, index: await (await fetch(index.uri)).text(), archive: Buffer.from(await (await fetch(manifest.archive.uri)).arrayBuffer()) };
      }
      if (name === "links") return { content: [
        { type: "resource_link", uri: `${state.pages}/doc.pdf`, name: "doc.pdf", mimeType: "application/pdf" },
        { type: "resource_link", uri: "data:text/plain;base64,aGVsbG8=", name: "hello.txt" },
        { type: "resource_link", uri: `${state.pages}/missing`, name: "missing.txt" },
      ] };
      return { content: [{ type: "text", text: "ok" }] };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    await transport.handleRequest(req, res, text ? JSON.parse(text) : undefined);
  });
  return { url: `${url}/mcp`, calls };
}

test("files reach a tool as URLs bound to the call: a file at its version, a directory as a snapshot, small ones inline", async t => {
  const state = { base: "", workspace: "", pages: "" };
  state.pages = await listen(t, (req, res) => {
    if (req.url === "/doc.pdf") return res.writeHead(200, { "Content-Type": "application/pdf" }).end(pdfBytes(["Linked"]));
    res.writeHead(404).end();
  });
  const app = await appServer(t, state);
  const secretsKey = randomBytes(32).toString("hex");
  const steps = [
    toolCall("app__attach", { attachment: { $file: "/workspace/report.pdf" } }),
    toolCall("app__attach", { attachment: { $file: "/workspace/a.png" } }),
    toolCall("app__attach", { attachment: { $file: "/workspace/big.pdf" } }),
    toolCall("app__inline", { image: { $file: "/workspace/a.png" } }),
    toolCall("app__inline", { image: { $file: "/workspace/huge.png" } }),
    toolCall("app__site", { dir: { $file: "/workspace/site" } }),
    toolCall("app__site", { dir: { $file: "/workspace/report.pdf" } }),
    toolCall("app__attach", { attachment: { $file: "/workspace/site" } }),
    toolCall("app__links", {}),
  ];
  const r = await runtime(t, (_body, index) => steps[index] ?? { role: "assistant", content: "done" }, { ...LOCAL, AGENT_PUBLIC_URL: "", AGENT_SECRETS_KEY: secretsKey });
  state.base = r.base;
  // The tenant's own server (auth runtime) takes files without saying so.
  const definition = (await r.call("/v1/definitions", { body: { name: "App", mcpServers: [{ name: "app", url: app.url, auth: { type: "runtime" }, exposure: "direct" }] } })).json;
  const agent = (await r.call("/v1/agents", { body: { definition: definition.id } })).json;
  state.workspace = (await r.call(`/v1/agents/${agent.id}/mounts`)).json[0].volumeId;
  await put(r.base, state.workspace, "report.pdf", REPORT);
  await put(r.base, state.workspace, "a.png", PNG);
  await put(r.base, state.workspace, "big.pdf", Buffer.concat([REPORT, Buffer.alloc(MAX_SIZE)]));
  await put(r.base, state.workspace, "huge.png", Buffer.concat([PNG, Buffer.alloc(TOOL_FILE_LIMITS.inlineBytes)]));
  await put(r.base, state.workspace, "site/index.html", "<h1>v1</h1>");
  await put(r.base, state.workspace, "site/assets/app.js", "console.log(1)");
  await put(r.base, state.workspace, `site/${LONG_NAME}`, "deep");
  await r.prompt(agent.id, "send the files");

  const tools = r.model.bodies[0].tools.map((tool: any) => tool.function);
  const described = (tool: string, field: string) => tools.find((entry: any) => entry.name === tool).parameters.properties[field].anyOf[1].properties.$file.description;
  assert.match(described("app__attach", "attachment"), /a link to it is sent, valid for 5 minutes \(types application\/pdf; at most 2097152 bytes\)/);
  assert.match(described("app__inline", "image"), /its content is sent \(types image\/\*\)/);
  assert.match(described("app__site", "dir"), /^A directory in your files/);

  // A file: a URL to it at this version, described in _meta with its digest.
  const [attach, inline, site, links] = ["attach", "inline", "site", "links"].map(name => app.calls.find(call => call.name === name)!);
  assert.equal(attach.got.status, 200);
  assert.equal(attach.got.type, "application/pdf");
  assert.deepEqual(attach.got.bytes, REPORT);
  const url = attach.args.attachment as string;
  assert.match(url, new RegExp(`^${r.base}/v1/files/[^/]+/report\\.pdf$`));
  assert.deepEqual(attach.meta["camelrun/files"], { "/attachment": { uri: url, name: "report.pdf", mimeType: "application/pdf", size: REPORT.length, digest: { algorithm: "sha-256", value: sha256(REPORT) } } });
  assert.match(toolResults(r.model.bodies[2]).at(-1), /a\.png is image\/png; this argument takes application\/pdf/);
  assert.match(toolResults(r.model.bodies[3]).at(-1), /big\.pdf is \d+ bytes; this argument takes at most 2097152/);

  // Inline: a data: URI.
  assert.equal(inline.args.image, `data:image/png;base64,${PNG.toString("base64")}`);
  assert.equal(inline.meta["camelrun/files"]["/image"].digest.value, sha256(PNG));
  assert.match(toolResults(r.model.bodies[5]).at(-1), /huge\.png is \d+ bytes; this argument takes files inline only/);

  // A directory: a manifest of a snapshot made for the call, which the agent's later writes do not change.
  const { manifest } = site.got;
  assert.equal(manifest.root, "/workspace/site");
  assert.deepEqual(manifest.files.map((file: any) => file.path).sort(), ["assets/app.js", "index.html", LONG_NAME].sort());
  const index = manifest.files.find((file: any) => file.path === "index.html");
  assert.deepEqual({ ...index, uri: undefined }, { path: "index.html", uri: undefined, name: "index.html", mimeType: "text/plain", size: 11, digest: { algorithm: "sha-256", value: sha256("<h1>v1</h1>") } });
  assert.equal(site.got.index, "<h1>v1</h1>", "the file as it was at the call");
  assert.equal(manifest.archive.mimeType, "application/gzip");
  const directory = mkdtempSync(join(tmpdir(), "file-arguments-"));
  writeFileSync(join(directory, "site.tar.gz"), site.got.archive);
  const listing = execFileSync("tar", ["-tzf", join(directory, "site.tar.gz")], { encoding: "utf8" }).trim().split("\n").sort();
  assert.deepEqual(listing, ["assets/app.js", "index.html", LONG_NAME].sort(), "the archive has the snapshot's files, a long name included");
  assert.equal(execFileSync("tar", ["-xzOf", join(directory, "site.tar.gz"), "index.html"], { encoding: "utf8" }), "<h1>v1</h1>");
  assert.equal(site.meta?.["camelrun/files"], undefined, "a directory is described by its manifest");
  assert.match(toolResults(r.model.bodies[7]).at(-1), /\/workspace\/report\.pdf is a file; this argument takes a directory/);
  assert.match(toolResults(r.model.bodies[8]).at(-1), /\/workspace\/site is a directory/);
  assert.deepEqual((await r.call(`/v1/volumes/${state.workspace}/snapshots`)).json, [], "the call's snapshot is not the tenant's to list");
  assert.equal((await r.db.query("select count(*)::int as count from volume_snapshots where name like 'file-arg:%'")).rows[0].count, 1, "it is kept until its URLs expire");

  // Files a tool links to are saved, and the transcript keeps their paths.
  const saved = toolResults(r.model.bodies[9]).at(-1);
  assert.match(saved, /\[File \/workspace\/tool-outputs\/app__links\/[a-f0-9]{8}\/doc\.pdf \(application\/pdf/);
  assert.match(saved, /\[File \/workspace\/tool-outputs\/app__links\/[a-f0-9]{8}\/hello\.txt \(text\/plain/);
  assert.match(saved, /\[missing\.txt not saved: fetching it answered HTTP 404\]/);
  assert.doesNotMatch(JSON.stringify(r.model.bodies.at(-1).messages), /127\.0\.0\.1|data:text/, "never their URLs");
  assert.ok(links);

  // The URL: a Range, then checked as a tool would check it.
  const range = await fetch(url, { headers: { Range: "bytes=0-4" } });
  assert.equal(range.status, 206);
  assert.equal(await range.text(), "%PDF-");
  const claims = await verifyFileUrl(url, { runtime: r.base, tenant: "alice", agent: agent.id });
  assert.deepEqual([claims.kind, claims.tool, claims.path, claims.agentPath, claims.volume, typeof claims.version, claims.exp - claims.iat], ["file", "app__attach", "/report.pdf", "/workspace/report.pdf", state.workspace, "number", 300]);
  assert.ok(claims.call);
  await assert.rejects(verifyFileUrl(url, { runtime: r.base, agent: "client_other" }), /another agent/);
  await assert.rejects(verifyFileUrl(url, { runtime: r.base, tenant: "bob" }), /another tenant/);
  await assert.rejects(verifyFileUrl(url.replace("127.0.0.1", "localhost"), { runtime: r.base }), /not at the runtime/);

  // Only the runtime's tokens for files, unexpired and unaltered, read anything.
  const token = url.split("/").at(-2)!;
  const tampered = `${token.slice(0, -4)}${token.slice(-4) === "AAAA" ? "BBBB" : "AAAA"}`;
  assert.equal((await fetch(url.replace(token, tampered))).status, 403);
  assert.equal((await fetch(`${r.base}/v1/files/not-a-token/x`)).status, 403);
  const accounts = new Accounts({ tenants: new Tenants({ read: async () => JSON.stringify({ tenants: {} }) }), db: r.db, secretsKey });
  const signer = new RuntimeSigner({ db: r.db, accounts, issuer: r.base });
  const grant = { tenant: "alice", agent: agent.id, call: "c", tool: "app__attach", volume: state.workspace, path: "/report.pdf", agentPath: "/workspace/report.pdf", kind: "file" as const, version: claims.version };
  const expired = await fetch(`${r.base}/v1/files/${await signer.fileToken(grant, Date.now() - 1000)}/report.pdf`);
  assert.deepEqual([expired.status, (await expired.json()).error], [403, "This link has expired"]);
  const identity = await signer.token(`${r.base}/v1/files`, { tenant: "alice", agent: agent.id });
  assert.equal((await fetch(`${r.base}/v1/files/${identity}/report.pdf`)).status, 403, "an identity token is not a file's");
  const other = await fetch(`${r.base}/v1/files/${await signer.fileToken({ ...grant, tenant: "bob" }, Date.now() + 60_000)}/report.pdf`);
  assert.equal(other.status, 404, "a grant names its tenant, which must own the volume");

  // Once the file changes, its URL no longer serves it: never a mix of versions.
  await put(r.base, state.workspace, "report.pdf", "changed");
  const changed = await fetch(url);
  assert.deepEqual([changed.status, (await changed.json()).error], [410, "/workspace/report.pdf changed since the call"]);
});

test("fileArguments: other parties' servers are not offered or sent files unless a definition turns it on", async t => {
  const state = { base: "", workspace: "", pages: "" };
  const app = await appServer(t, state);
  const spec = { openapi: "3.1.0", info: { title: "Docs", version: "1" }, servers: [{ url: "https://docs.example.test" }], paths: {
    "/upload": { post: { operationId: "upload", requestBody: { content: { "multipart/form-data": { schema: { type: "object", properties: { file: { type: "string", format: "binary" } } } } } }, responses: { 200: { description: "ok" } } } },
  } };
  const done = { role: "assistant", content: "done" };
  const steps = [
    toolCall("app__attach", { attachment: { $file: "/workspace/report.pdf" } }),
    toolCall("js_exec", { code: "try { await tools.app__loose({ attachment: { $file: 'report.pdf' } }); return 'sent'; } catch (error) { return String(error.message); }" }),
    toolCall("js_exec", { code: "try { await tools.docs__upload({ body: { file: { $file: 'report.pdf' } } }); return 'sent'; } catch (error) { return String(error.message); }" }),
    done,
    toolCall("app__attach", { attachment: { $file: "/workspace/report.pdf" } }),
  ];
  const r = await runtime(t, (_body, index) => steps[index] ?? done, { ...LOCAL, AGENT_PUBLIC_URL: "" });
  state.base = r.base;
  const refused = await r.call("/v1/definitions", { body: { name: "Bad", mcpServers: [{ name: "app", url: app.url, fileArguments: "yes" }] } });
  assert.equal(refused.status, 400);
  assert.match(refused.json.error, /fileArguments/);
  const definition = (await r.call("/v1/definitions", { body: { name: "Off", mcpServers: [{ name: "app", url: app.url, exposure: "both" }], openApi: [{ name: "docs", spec, exposure: "both" }] } })).json;
  assert.equal(definition.mcpServers[0].fileArguments, undefined, "the default is not stored: it follows auth");
  const agent = (await r.call("/v1/agents", { body: { definition: definition.id } })).json;
  const workspace = (await r.call(`/v1/agents/${agent.id}/mounts`)).json[0].volumeId;
  await put(r.base, workspace, "report.pdf", REPORT);
  await r.prompt(agent.id, "send it");
  const tools = r.model.bodies[0].tools.map((tool: any) => tool.function);
  assert.deepEqual(tools.find((tool: any) => tool.name === "app__attach").parameters.properties.attachment, fileParameter({ accept: ["application/pdf"], maxSize: MAX_SIZE }), "no {$file} offered");
  assert.deepEqual(tools.find((tool: any) => tool.name === "docs__upload").parameters.properties.body.properties.file, { type: "string", format: "binary" });
  // The model is told file arguments are off for the tool, whether its schema refuses them or the runtime does.
  assert.match(toolResults(r.model.bodies[1]).at(-1), /^app__attach is not sent files: file arguments \(\{"\$file": path\}\) are off for this tool/);
  assert.match(toolResults(r.model.bodies[2]).at(-1), /app is not sent files: \$file needs fileArguments "on" in its definition/, "and where that takes anything, the runtime refuses");
  assert.match(toolResults(r.model.bodies[3]).at(-1), /docs__upload is not sent files: file arguments \(\{"\$file": path\}\) are off for this tool/);
  assert.equal(app.calls.length, 0, "nothing reached the server");

  // Turned on, the same server is sent the file.
  const on = await r.call(`/v1/definitions/${definition.id}`, { method: "PATCH", body: { mcpServers: [{ name: "app", url: app.url, exposure: "both", fileArguments: "on" }] } });
  assert.equal(on.status, 200, on.text);
  assert.equal(on.json.mcpServers[0].fileArguments, "on");
  const second = (await r.call("/v1/agents", { body: { definition: definition.id, mounts: [{ volumeId: workspace, path: "/workspace", mode: "rw" }] } })).json;
  await r.prompt(second.id, "send it");
  assert.deepEqual(app.calls[0]?.got?.bytes, REPORT);
});

test("a directory's snapshot for a tool call: within limits, unlisted, apart from the tenant's snapshots, and swept", async t => {
  const { db } = await testDatabase();
  const volumes = new VolumeService({ db, storage: memoryStorage(postgresTail(db, { unfenced: true })) });
  t.after(() => volumes.close());
  const volume = (await volumes.create("acme", { name: "files" })).id;
  for (const name of ["a", "b", "c"]) await volumes.put("acme", volume, `/site/${name}.txt`, Buffer.from(name));
  await volumes.put("acme", volume, "/other.txt", Buffer.from("other"));
  const limit = { files: 3, bytes: 3 };
  const snapshot = (name: string, directory = "/site", within = limit) => volumes.call(volume, "acme", "snapshot", { name, directory, limit: within });

  const made = await snapshot("file-arg:call-1");
  assert.deepEqual([made.files, made.bytes], [3, 3], "only the directory's files");
  const { files } = await volumes.call(volume, "acme", "list", { path: "/", snapshot: made.id });
  assert.deepEqual(files.map((file: any) => file.path), ["/site/a.txt", "/site/b.txt", "/site/c.txt"]);
  await assert.rejects(snapshot("file-arg:call-2", "/site", { files: 2, bytes: 100 }), /\/site has more than 2 files/);
  await assert.rejects(snapshot("file-arg:call-2", "/site", { files: 10, bytes: 2 }), /\/site holds more than 2 bytes/);
  await assert.rejects(volumes.call(volume, "acme", "snapshot", { name: "file-arg:mine" }), /are the runtime's own/);
  await assert.rejects(snapshot("mine"), /are the runtime's own/);

  // The tenant's snapshots count apart: a full volume still sends directories, and they never block the tenant's.
  for (let index = 0; index < VOLUME_LIMITS.snapshots; index++) await db.query("insert into volume_snapshots (id, volume, name, seq, created_at, files, bytes) values ($1, $2, $3, 0, $4, 0, 0)", [`snap_${index.toString(16).padStart(16, "0")}`, volume, `mine ${index}`, Date.now()]);
  assert.equal((await volumes.call(volume, "acme", "snapshots")).length, VOLUME_LIMITS.snapshots, "the call's snapshot is not listed");
  await assert.rejects(volumes.call(volume, "acme", "snapshot", { name: "one more" }), /at most 100 snapshots/);
  const second = await snapshot("file-arg:call-2");

  // One a crash left behind goes once it is 15 minutes old, when the next is made.
  await db.query("update volume_snapshots set created_at = $2 where id = $1", [made.id, Date.now() - 16 * 60_000]);
  await snapshot("file-arg:call-3");
  const left = (await db.query("select id from volume_snapshots where name like 'file-arg:%' order by created_at")).rows.map(row => row.id);
  assert.equal(left.includes(made.id), false);
  assert.ok(left.includes(second.id));
  await assert.rejects(volumes.call(volume, "acme", "list", { path: "/", snapshot: made.id }), /Unknown snapshot/);
});

test("verifyFileUrl checks a file URL's signature, issuer, place, audience, tenant, agent and expiry", async () => {
  const rt = await testRuntime();
  const url = await rt.fileUrl({ agent: "client_a" });
  const claims = await verifyFileUrl(url, { ...rt.options, tenant: "test", agent: "client_a" });
  assert.deepEqual([claims.kind, claims.agentPath, claims.version], ["file", "/workspace/report.pdf", 1]);
  assert.ok((await verifyFileUrl(url, { runtime: rt.url, fetch: rt.fetch })).call, "tenant and agent are optional");
  const refused = async (target: string, pattern: RegExp, options: Record<string, unknown> = {}) => {
    await assert.rejects(verifyFileUrl(target, { ...rt.options, ...options }), (error: unknown) => error instanceof RuntimeTokenError && pattern.test(error.message));
  };
  await refused(url, /another agent/, { agent: "client_b" });
  await refused(url, /another tenant/, { tenant: "acme" });
  await refused(url.replace("https://runtime.test", "https://evil.test"), /not at the runtime/);
  await refused(`${rt.url}/v1/links/x/y`, /Not a file URL/);
  await refused(await rt.fileUrl({}, { expiresIn: -120 }), /expired/);
  await refused(`${rt.url}/v1/files/${await rt.token({}, "https://app.test/mcp")}/x`, /not for a file/);
  const stranger = await testRuntime();
  await refused(await stranger.fileUrl(), /key the runtime does not publish/);
});
