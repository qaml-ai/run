import { portedTest } from '../ported.ts';
const test = portedTest("files", "tests/file-arguments.test.ts");

import assert from "node:assert/strict";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { pdfBytes } from "../../file-fixtures.ts";

import { listen, OPERATOR, runtime, toolCall, toolResults, type T } from "../support.ts";

const LOCAL = { AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32" };

const auth = { Authorization: `Bearer ${OPERATOR}` };

const REPORT = Buffer.concat([pdfBytes(["Quarterly report"]), Buffer.alloc(1536 * 1024, 0x20)]);

const MAX_SIZE = 2 * 1024 * 1024;

const put = (base: string, volume: string, path: string, body: Uint8Array | string) =>
  fetch(`${base}/v1/volumes/${volume}/files/${path}`, { method: "PUT", body: body as BodyInit, headers: auth }).then(response => response.json());

const fileParameter = (spec: Record<string, unknown>, directory = false) => ({ type: "string", format: "uri", "x-mcp-file": spec, ...(directory ? { "x-camelrun-directory": true } : {}) });

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

test("fileArguments: other parties' servers are not offered or sent files unless a definition turns it on", async t => {
  const state = { base: "", workspace: "", pages: "" };
  const app = await appServer(t, state);
  const spec = { openapi: "3.1.0", info: { title: "Docs", version: "1" }, servers: [{ url: "https://docs.example.test" }], paths: {
    "/upload": { post: { operationId: "upload", requestBody: { content: { "multipart/form-data": { schema: { type: "object", properties: { file: { type: "string", format: "binary" } } } } } }, responses: { 200: { description: "ok" } } } },
  } };
  const done = { role: "assistant", content: "done" };
  const steps = [
    toolCall("app__attach", { attachment: { $file: "/workspace/report.pdf" } }),
    toolCall("codemode", { code: "try { await tools.app__loose({ attachment: { $file: 'report.pdf' } }); return 'sent'; } catch (error) { return String(error.message); }" }),
    toolCall("codemode", { code: "try { await tools.docs__upload({ body: { file: { $file: 'report.pdf' } } }); return 'sent'; } catch (error) { return String(error.message); }" }),
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
  // Said first (Pi reports a refused call as its harness's error diagnostic), not after the schema's own complaint.
  assert.match(toolResults(r.model.bodies[1]).at(-1), /^(<harness>\n\[error\] )?app__attach is not sent files: file arguments \(\{"\$file": path\}\) are off for this tool/);
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
