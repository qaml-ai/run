import { test } from "node:test";
import assert from "node:assert/strict";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { memoryStorage } from "../shared/storage.ts";
import { postgresTail } from "../src/log-tail.ts";
import { TOOL_FILE_LIMITS } from "../src/limits.ts";
import { ToolFiles } from "../src/tool-files.ts";
import { VolumeService } from "../src/volumes.ts";
import { testDatabase } from "./database.ts";
import { PNG, pdfBytes } from "./file-fixtures.ts";
import { listen, OPERATOR, runtime, toolCall, toolResults, type T } from "./runtime-server.ts";

const LOCAL = { AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32" };
const PDF = pdfBytes(["Quarterly report"]);
const auth = { Authorization: `Bearer ${OPERATOR}` };

/** Put a file in a volume over the API. */
const put = (base: string, volume: string, path: string, body: Uint8Array | string, type?: string) =>
  fetch(`${base}/v1/volumes/${volume}/files/${path}`, { method: "PUT", body: body as BodyInit, headers: { ...auth, ...(type ? { "Content-Type": type } : {}) } }).then(response => response.json());
/** The files under a prefix of a volume, by path. */
const files = async (base: string, volume: string, prefix: string) =>
  ((await fetch(`${base}/v1/volumes/${volume}/files?prefix=${encodeURIComponent(prefix)}`, { headers: auth }).then(response => response.json())).files as { path: string; size: number; contentType: string }[]);
const read = (base: string, volume: string, path: string) => fetch(`${base}/v1/volumes/${volume}/files${path}`, { headers: auth }).then(async response => Buffer.from(await response.arrayBuffer()));

/**
 * An MCP server whose `send` tool takes a file as base64 and one as a link (which it fetches from
 * the runtime, as a remote server would), and whose `outputs` tool answers with every kind of file.
 */
async function fileServer(t: T, runtimeBase: () => string) {
  const seen: { content?: string; fetched?: Buffer; fetchedType?: string }[] = [];
  const url = await listen(t, async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const server = new Server({ name: "files", version: "1" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
      { name: "send", description: "Send a document", inputSchema: { type: "object", properties: {
        title: { type: "string" }, content: { type: "string", contentEncoding: "base64" }, source_url: { type: "string" },
      } } },
      { name: "outputs", description: "Make files", inputSchema: { type: "object", properties: {} } },
    ] }));
    server.setRequestHandler(CallToolRequestSchema, async request => {
      if (request.params.name === "outputs") return { content: [
        { type: "text", text: "made" },
        { type: "image", data: PNG.toString("base64"), mimeType: "image/png" },
        { type: "audio", data: Buffer.from("RIFFfake").toString("base64"), mimeType: "audio/wav" },
        { type: "resource", resource: { uri: "file:///tmp/..%2F..%2F.hidden%00.pdf", mimeType: "application/pdf", blob: PDF.toString("base64") } },
        { type: "resource", resource: { uri: "memo://notes/long.txt", mimeType: "text/plain", text: "x".repeat(TOOL_FILE_LIMITS.textBytes + 1) } },
        { type: "resource", resource: { uri: "memo://notes/short.txt", text: "short note" } },
        { type: "resource_link", uri: "https://example.test/doc", name: "doc" },
      ] };
      const args = request.params.arguments as { content?: string; source_url?: string };
      const entry: (typeof seen)[number] = { ...(args.content ? { content: args.content } : {}) };
      if (args.source_url) {
        // The link names the runtime's public URL; this test reaches the runtime where it listens.
        const response = await fetch(args.source_url.replace("https://agents.example.test", runtimeBase()));
        entry.fetched = Buffer.from(await response.arrayBuffer());
        entry.fetchedType = response.headers.get("content-type") ?? undefined;
      }
      seen.push(entry);
      return { content: [{ type: "text", text: "sent" }] };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    await transport.handleRequest(req, res, text ? JSON.parse(text) : undefined);
  });
  return { url: `${url}/mcp`, seen };
}

test("MCP tools take files by {$file}: base64 or a signed link, only from the agent's mounts", async t => {
  let base = "";
  const mcp = await fileServer(t, () => base);
  const steps = [
    toolCall("files__send", { title: "Q3", content: { $file: "/data/notes.txt" }, source_url: { $file: "/workspace/report.pdf" } }),
    toolCall("files__send", { content: { $file: "/etc/passwd" } }),
    toolCall("files__send", { content: { $file: "/workspace/../data/notes.txt" } }),
    toolCall("files__send", { title: { $file: "/data/notes.txt" } }),
    toolCall("files__send", { content: { $file: "/workspace/big.bin" } }),
    toolCall("js_exec", { code: "await tools.files__send({ content: { $file: 'notes.txt' } }); return 'ok';" }),
  ];
  const r = await runtime(t, (_body, index) => steps[index] ?? { role: "assistant", content: "done" }, LOCAL);
  base = r.base;
  const data = (await r.call("/v1/volumes", { body: { name: "data" } })).json.id;
  const workspace = (await r.call("/v1/volumes", { body: { name: "workspace" } })).json.id;
  await put(r.base, data, "notes.txt", "read-only notes");
  await put(r.base, workspace, "report.pdf", PDF);
  await put(r.base, workspace, "notes.txt", "workspace notes");
  await put(r.base, workspace, "big.bin", Buffer.alloc(TOOL_FILE_LIMITS.inlineBytes + 1));
  const definition = (await r.call("/v1/definitions", { body: { name: "Files", mcpServers: [{ name: "files", url: mcp.url, exposure: "both" }] } })).json;
  const agent = (await r.call("/v1/agents", { body: { definition: definition.id, mounts: [{ volumeId: workspace, path: "/workspace", mode: "rw" }, { volumeId: data, path: "/data", mode: "ro" }] } })).json;
  await r.prompt(agent.id, "send the files");

  const send = r.model.bodies[0].tools.find((tool: any) => tool.function.name === "files__send").function.parameters;
  assert.equal(send.properties.content.anyOf[1].required[0], "$file", "a base64 field offers {$file}");
  assert.equal(send.properties.source_url.anyOf.length, 2, "so does a field named like a URL");
  assert.equal(send.properties.title.type, "string", "a plain string does not");

  assert.equal(Buffer.from(mcp.seen[0].content!, "base64").toString(), "read-only notes", "a read-only mount's file is read");
  assert.deepEqual(mcp.seen[0].fetched, PDF, "the link fetches the file");
  assert.equal(mcp.seen[0].fetchedType, "application/pdf");
  assert.match(toolResults(r.model.bodies[2]).at(-1), /\/etc\/passwd is not inside a mount/);
  assert.match(toolResults(r.model.bodies[3]).at(-1), /Invalid path/);
  assert.match(toolResults(r.model.bodies[4]).at(-1), /Validation failed/, "only fields that take files accept {$file}");
  assert.match(toolResults(r.model.bodies[5]).at(-1), new RegExp(`at most ${TOOL_FILE_LIMITS.inlineBytes} can be sent inline`));
  assert.match(toolResults(r.model.bodies[6]).at(-1), /ok/);
  assert.equal(Buffer.from(mcp.seen[1].content!, "base64").toString(), "workspace notes", "from js_exec, relative to the first mount");
  assert.equal(mcp.seen.length, 2, "refused files never reach the server");
});

test("MCP images, audio, blobs and long text are saved to the workspace, under sanitized names", async t => {
  const mcp = await fileServer(t, () => "");
  const r = await runtime(t, (_body, index) => [
    toolCall("files__outputs", {}),
    toolCall("js_exec", { code: "const out = await tools.files__outputs({}); return out.filter(part => part.type === 'file').map(part => part.path.split('/').pop() + ':' + part.contentType);" }),
  ][index] ?? { role: "assistant", content: "done" }, LOCAL);
  const definition = (await r.call("/v1/definitions", { body: { name: "Files", mcpServers: [{ name: "files", url: mcp.url, exposure: "both" }] } })).json;
  const agent = (await r.call("/v1/agents", { body: { definition: definition.id } })).json;
  const outcome = await r.prompt(agent.id, "make files");
  assert.ok(outcome.outcome.result.files.some((file: any) => /^\/workspace\/tool-outputs\/files__outputs\/[a-f0-9]{8}\/image-1\.png$/.test(file.path) && file.contentType === "image/png"), "saved outputs are listed in the run's files");
  const workspace = (await r.call(`/v1/agents/${agent.id}/mounts`)).json[0].volumeId;
  const saved = await files(r.base, workspace, "/tool-outputs/files__outputs");
  const names = saved.map(file => `${file.path.split("/").pop()}:${file.contentType}`).sort();
  assert.deepEqual(names, ["audio-2.wav:audio/wav", "audio-2.wav:audio/wav", "hidden.pdf:application/pdf", "hidden.pdf:application/pdf", "image-1.png:image/png", "image-1.png:image/png", "long.txt:text/plain", "long.txt:text/plain"], "each call saves to its own directory");
  assert.ok(saved.every(file => /^\/tool-outputs\/files__outputs\/[a-f0-9]{8}\/[^/]+$/.test(file.path)), "names from the server cannot leave the call's directory");
  const pdf = saved.find(file => file.path.endsWith(".pdf"))!;
  assert.deepEqual(await read(r.base, workspace, pdf.path), PDF);

  const result = toolResults(r.model.bodies[1]).at(-1);
  assert.match(result, /made/);
  assert.match(result, /short note/, "a short text resource stays text");
  assert.match(result, /Resource: doc https:\/\/example\.test\/doc/, "a resource link stays a link");
  assert.match(result, /\[File \/workspace\/tool-outputs\/files__outputs\/[a-f0-9]{8}\/long\.txt \(text\/plain, 65 KB\), beginning:\nx{199}…\]/, "with its first line, cut short");
  const messages = JSON.stringify(r.model.bodies[1].messages);
  assert.ok(messages.includes(PNG.toString("base64")), "the model sees the image");
  assert.ok(messages.includes(PDF.toString("base64")), "and the PDF");
  assert.equal(messages.includes("x".repeat(1000)), false, "but not the long text");
  assert.deepEqual(toolResults(r.model.bodies[2]).at(-1), JSON.stringify(["image-1.png:image/png", "audio-2.wav:audio/wav", "hidden.pdf:application/pdf", "long.txt:text/plain"]), "code gets each file's path and type");
});

/** An API that takes uploads (multipart, raw bytes, base64 in JSON) and answers with a file. */
async function uploadApi(t: T) {
  const seen: { path: string; type?: string; length?: string; body: Buffer }[] = [];
  let base = "";
  const binary = { type: "string", format: "binary" };
  const spec = () => ({
    openapi: "3.1.0", info: { title: "Docs", version: "1" }, servers: [{ url: base }],
    paths: {
      "/upload": { post: { operationId: "upload", requestBody: { required: true, content: { "multipart/form-data": { schema: { type: "object", properties: { file: binary, caption: { type: "string" }, attachments: { type: "array", items: binary } } } } } }, responses: { 200: { description: "ok" } } } },
      "/raw/{name}": { put: { operationId: "putRaw", parameters: [{ name: "name", in: "path", required: true, schema: { type: "string" } }], requestBody: { content: { "application/pdf": { schema: binary } } }, responses: { 200: { description: "ok" } } } },
      "/any": { post: { operationId: "putAny", requestBody: { content: { "image/*": { schema: binary } } }, responses: { 200: { description: "ok" } } } },
      "/json": { post: { operationId: "postJson", requestBody: { content: { "application/json": { schema: { type: "object", properties: { data: { type: "string", format: "byte" } } } } } }, responses: { 200: { description: "ok" } } } },
      "/render": { get: { operationId: "render", responses: { 200: { description: "a picture" } } } },
      "/text": { get: { operationId: "text", responses: { 200: { description: "text" } } } },
    },
  });
  const url = await listen(t, async (req, res) => {
    const parts: Buffer[] = [];
    for await (const chunk of req) parts.push(chunk);
    const path = new URL(req.url!, "http://x").pathname;
    if (path === "/openapi.json") return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(spec()));
    if (path === "/render") return res.writeHead(200, { "Content-Type": "image/png", "Content-Disposition": `attachment; filename="../../.ssh/authorized_keys.png"` }).end(PNG);
    if (path === "/text") return res.writeHead(200, { "Content-Type": "text/plain" }).end("x".repeat(1024 * 1024 + 1));
    seen.push({ path, type: req.headers["content-type"], length: req.headers["content-length"], body: Buffer.concat(parts) });
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
  });
  base = url;
  return { url, seen };
}

test("OpenAPI operations upload files (multipart, raw bytes, base64) and save binary responses", async t => {
  const api = await uploadApi(t);
  const r = await runtime(t, (_body, index) => [
    toolCall("docs__upload", { body: { file: { $file: "/workspace/report.pdf" }, caption: "Q3", attachments: [{ $file: "/workspace/a.png" }] } }),
    toolCall("docs__putRaw", { name: "q3", body: { $file: "/workspace/report.pdf" } }),
    toolCall("docs__putAny", { body: { $file: "/workspace/a.png" } }),
    toolCall("docs__postJson", { body: { data: { $file: "/workspace/a.png" } } }),
    toolCall("docs__render", {}),
    toolCall("js_exec", { code: "const file = await tools.docs__render({}); return file.path.split('/').pop() + ':' + file.contentType + ':' + file.size;" }),
    toolCall("docs__text", {}),
  ][index] ?? { role: "assistant", content: "done" }, LOCAL);
  const definition = await r.call("/v1/definitions", { body: { name: "Docs", openApi: [{ name: "docs", spec: `${api.url}/openapi.json`, exposure: "both" }] } });
  assert.equal(definition.status, 201, definition.text);
  assert.deepEqual(definition.json.openApi[0].tools, ["upload", "putRaw", "putAny", "postJson", "render", "text"], "upload operations are tools now");
  const agent = (await r.call("/v1/agents", { body: { definition: definition.json.id } })).json;
  const workspace = (await r.call(`/v1/agents/${agent.id}/mounts`)).json[0].volumeId;
  await put(r.base, workspace, "report.pdf", PDF);
  await put(r.base, workspace, "a.png", PNG);
  await r.prompt(agent.id, "upload");

  const upload = r.model.bodies[0].tools.find((tool: any) => tool.function.name === "docs__upload").function.parameters;
  assert.match(upload.properties.body.properties.file.anyOf[1].properties.$file.description, /uploaded/);
  const [multipart, raw, any, json] = api.seen;
  const form = await new Response(multipart.body as unknown as BodyInit, { headers: { "Content-Type": multipart.type! } }).formData();
  const file = form.get("file") as File;
  assert.equal(file.name, "report.pdf");
  assert.equal(file.type, "application/pdf");
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), PDF);
  assert.equal(form.get("caption"), "Q3");
  assert.deepEqual(Buffer.from(await (form.getAll("attachments")[0] as File).arrayBuffer()), PNG);
  assert.equal(Number(multipart.length), multipart.body.length, "the length is known ahead of the stream");
  assert.deepEqual([raw.path, raw.type, raw.body], ["/raw/q3", "application/pdf", PDF]);
  assert.deepEqual([any.type, any.body], ["image/png", PNG], "a body of any image type is sent as the file's type");
  assert.deepEqual(JSON.parse(json.body.toString()), { data: PNG.toString("base64") });

  const rendered = toolResults(r.model.bodies[5]).at(-1);
  assert.match(rendered, /\[File \/workspace\/tool-outputs\/docs__render\/[a-f0-9]{8}\/authorized_keys\.png \(image\/png/, "the response's file name is sanitized");
  assert.ok(JSON.stringify(r.model.bodies[5].messages).includes(PNG.toString("base64")), "the model sees the saved image");
  assert.match(toolResults(r.model.bodies[6]).at(-1), new RegExp(`authorized_keys.png:image/png:${PNG.length}`));
  assert.match(toolResults(r.model.bodies[7]).at(-1), /Response larger than 1048576 bytes/, "text answers keep the 1 MiB cap");
});

test("web_fetch saves PDFs and images to the workspace and shows them to the model", async t => {
  const pages = await listen(t, (req, res) => {
    if (req.url === "/files/report.pdf") return res.writeHead(200, { "Content-Type": "application/pdf" }).end(PDF);
    if (req.url === "/pic") return res.writeHead(200, { "Content-Type": "image/png" }).end(PNG);
    res.writeHead(404).end();
  });
  const r = await runtime(t, (_body, index) => [
    toolCall("web_fetch", { url: `${pages}/files/report.pdf` }),
    toolCall("js_exec", { code: `const page = await tools.web_fetch({ url: "${pages}/pic" }); return page.path + ':' + page.contentType + ':' + page.size;` }),
  ][index] ?? { role: "assistant", content: "done" }, LOCAL);
  const definition = (await r.call("/v1/definitions", { body: { name: "Reader", builtins: ["web_fetch"] } })).json;
  const agent = (await r.call("/v1/agents", { body: { definition: definition.id } })).json;
  await r.prompt(agent.id, "read them");
  const report = JSON.parse(toolResults(r.model.bodies[1]).at(-1).split("\n")[0]);
  assert.deepEqual({ ...report, path: report.path.replace(/[a-f0-9]{8}/, "ID") }, { url: `${pages}/files/report.pdf`, status: 200, contentType: "application/pdf", path: "/workspace/tool-outputs/web_fetch/ID/report.pdf", size: PDF.length });
  assert.ok(JSON.stringify(r.model.bodies[1].messages).includes(PDF.toString("base64")), "the model sees the PDF");
  assert.match(toolResults(r.model.bodies[2]).at(-1), new RegExp(`/workspace/tool-outputs/web_fetch/[a-f0-9]{8}/pic:image/png:${PNG.length}`));
  const workspace = (await r.call(`/v1/agents/${agent.id}/mounts`)).json[0].volumeId;
  assert.deepEqual(await read(r.base, workspace, report.path.slice("/workspace".length)), PDF);
});

test("a call and a run save only so much, never outside the workspace", async t => {
  const { db } = await testDatabase();
  const volumes = new VolumeService({ db, storage: memoryStorage(postgresTail(db, { unfenced: true })) });
  t.after(() => volumes.close());
  const mounts = [...await volumes.mountsFor("acme", "agent", [{ volumeId: (await volumes.create("acme", { name: "ro" })).id, path: "/ref", mode: "ro" }]), ...await volumes.mountsFor("acme", "agent", undefined)];
  const run = { left: 10 };
  const files = new ToolFiles({ volumes, tenant: "acme", agent: "agent", mounts, tool: "../evil", run });
  const first = await files.save("../../.env", Buffer.from("12345678"), "text/plain");
  assert.match(first.path, /^\/workspace\/tool-outputs\/evil\/[a-f0-9]{8}\/env$/, "saved in the writable workspace, under a sanitized name");
  const again = await files.save("../../.env", Buffer.from("1"));
  assert.match(again.path, /\/env-2$/, "names in one call do not collide");
  await assert.rejects(files.save("more", Buffer.from("123")), /larger than the 1 bytes the tool may still save/);
  assert.equal(run.left, 1, "what a refused save stored does not count");
  const next = new ToolFiles({ volumes, tenant: "acme", agent: "agent", mounts, tool: "t", run });
  await next.save("one", Buffer.from("1"));
  await assert.rejects(next.save("two", Buffer.from("1")), /has saved as much as it may/, "the run's budget is shared by its calls");
  const readOnly = new ToolFiles({ volumes, tenant: "acme", agent: "agent", mounts: mounts.slice(0, 1), tool: "t", run: { left: 100 } });
  await assert.rejects(readOnly.save("x", Buffer.from("1")), /no writable mount/);
});
