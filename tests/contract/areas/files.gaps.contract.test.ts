import {portedTest} from '../ported.ts';
const test = portedTest("files", "tests/files.test.ts");
import assert from 'node:assert/strict';
import {AgentRuntime} from '../../../clients/node.ts';
import {pdfBytes,PNG} from '../../file-fixtures.ts';
import {OPERATOR,runtime,toolCall,until} from '../support.ts';

test("an upload streams to storage a chunk at a time: the source is never more than a few chunks ahead of storage", async t => {
  // The source retains its direct-storage backpressure and chunk-count assertions.
  const size = 64 * 1024 * 1024;
  const piece = Buffer.alloc(64 * 1024, 7);
  // The same stream end to end over HTTP, through an upload link.
  const server = await runtime(t, () => ({ role: "assistant", content: "ok" }));
  const volume = (await server.call("/v1/volumes", { body: { name: "big" } })).json.id;
  const put = (await server.call(`/v1/volumes/${volume}/links`, { body: { path: "/big.bin", method: "PUT" } })).json;
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= size) return controller.close();
      sent += piece.length;
      controller.enqueue(piece);
    },
  });
  const response = await fetch(put.url.replace("https://agents.example.test", server.base), { method: "PUT", body, duplex: "half" } as RequestInit);
  const uploaded = await response.json();
  assert.equal(response.status, 201, JSON.stringify(uploaded));
  assert.equal(uploaded.size, size);
  const tail = await fetch(`${server.base}/v1/volumes/${volume}/files/big.bin`, { headers: { Authorization: `Bearer ${OPERATOR}`, Range: "bytes=-3" } });
  assert.deepEqual([...Buffer.from(await tail.arrayBuffer())], [7, 7, 7]);
});

test("attachments over REST land in the workspace, the transcript keeps references, and the model sees them natively", async t => {
  const server = await runtime(t, () => ({ role: "assistant", content: "seen", usage: { prompt_tokens: 5000, completion_tokens: 7 } }));
  const agent = (await server.call("/v1/agents", { body: { name: "reader" } })).json.id;
  const auth = { Authorization: `Bearer ${OPERATOR}` };
  const PDF = pdfBytes(["Quarterly report"]);
  const uploaded = await (await fetch(`${server.base}/v1/agents/${agent}/uploads/turn-1/report.pdf`, { method: "PUT", body: PDF, headers: auth })).json();
  assert.equal(uploaded.path, "/workspace/uploads/turn-1/report.pdf");
  assert.equal(uploaded.contentType, "application/pdf");
  const bad = async (files: unknown, pattern: RegExp) => {
    const response = await server.call(`/v1/agents/${agent}/prompt`, { body: { text: "x", files } });
    assert.ok(response.status === 400 || response.status === 413, `${response.status} ${response.text}`);
    assert.match(response.json.error, pattern);
  };
  await bad(Array.from({ length: 21 }, () => ({ path: uploaded.path })), /At most 20 files/);
  await bad([{ name: "a", data: "not base64!" }], /\{path\}.*\{name, data/);
  await bad([{ path: "/etc/passwd" }], /not inside a mount/);
  await bad([{ path: "/workspace/missing.png" }], /does not exist/);
  await bad([{ name: "big.bin", data: Buffer.alloc(4 * 1024 * 1024 + 3).toString("base64") }], /Inline files are limited/);

  const accepted = await server.call(`/v1/agents/${agent}/prompt`, { body: { text: "What are these?", requestId: "turn-1", files: [{ path: uploaded.path }, { name: "../../etc/shot.png", data: PNG.toString("base64") }, { name: "shot.png", data: PNG.toString("base64") }] } });
  assert.equal(accepted.status, 202, accepted.text);
  await until(async () => (await server.call(`/v1/agents/${agent}/requests/turn-1`)).json.state === "completed", "the turn");
  // Names are sanitized, and collide only within a request.
  const listed = (await server.call(`/v1/volumes/${(await server.call(`/v1/agents/${agent}/mounts`)).json[0].volumeId}/files?prefix=/uploads/turn-1`)).json.files;
  assert.deepEqual(listed.map((file: any) => [file.path, file.contentType]), [["/uploads/turn-1/report.pdf", "application/pdf"], ["/uploads/turn-1/shot-2.png", "image/png"], ["/uploads/turn-1/shot.png", "image/png"]]);

  // The model got the text, a line per file, and native blocks: the image, and the PDF as a document (OpenRouter takes files).
  const user = server.model.bodies.at(-1).messages.find((message: any) => message.role === "user");
  assert.equal(user.content[0].text, "What are these?");
  assert.match(user.content[1].text, /^\[File \/workspace\/uploads\/turn-1\/report\.pdf \(application\/pdf, 1 KB\)\]$/);
  assert.deepEqual(user.content[2], { type: "file", file: { filename: "document.pdf", file_data: `data:application/pdf;base64,${PDF.toString("base64")}` } });
  assert.match(user.content[3].text, /shot\.png \(image\/png/);
  assert.deepEqual(user.content[4], { type: "image_url", image_url: { url: `data:image/png;base64,${PNG.toString("base64")}` } });

  // The transcript holds references (volume, path, version, type and chunks), never the bytes.
  const history = (await server.call(`/v1/agents/${agent}/history`)).json;
  const stored = history.messages.find((message: any) => message.role === "user").content;
  assert.deepEqual(stored.slice(1).map((block: any) => [block.type, block.path, block.contentType, block.media]), [
    ["file", "/workspace/uploads/turn-1/report.pdf", "application/pdf", { kind: "pdf", pages: 1 }],
    ["file", "/workspace/uploads/turn-1/shot.png", "image/png", { kind: "image", mimeType: "image/png", width: 2, height: 3 }],
    ["file", "/workspace/uploads/turn-1/shot-2.png", "image/png", { kind: "image", mimeType: "image/png", width: 2, height: 3 }],
  ]);
  assert.ok(stored.every((block: any) => block.type === "text" || (block.version > 0 && block.chunks.length === 1 && block.volume.startsWith("vol_"))));
  assert.ok(!JSON.stringify(history).includes(PNG.toString("base64")) && !JSON.stringify(history).includes(PDF.toString("base64").slice(0, 40)), "no base64 in the transcript");
  const requests = (await server.call(`/v1/agents/${agent}`)).json.requests;
  assert.ok(!JSON.stringify(requests).includes(PNG.toString("base64")));
  // Billing is what the provider reported for the one request: files add no model calls and no usage of their own.
  assert.equal(server.model.bodies.length, 1);
  const { totals } = (await server.call("/v1/usage")).json;
  assert.deepEqual([totals.responses, totals.input, totals.output], [1, 5000, 7]);
});

test("a run's outcome lists the files it wrote and presented, and a presented file is an event with a download link", async t => {
  const server = await runtime(t, (_body, index) => [
    toolCall("write", { path: "/workspace/out/summary.md", content: "# Summary" }),
    toolCall("codemode", { code: 'await tools.write({ path: "/workspace/out/chart.svg", content: "<svg/>" })' }),
    toolCall("present_file", { path: "/workspace/out/chart.svg", caption: "Q3 chart" }),
    { role: "assistant", content: "Here is your chart." },
  ][index] ?? { role: "assistant", content: "ok" });
  const events: any[] = [];
  const client = new AgentRuntime({ url: server.base, apiKey: OPERATOR });
  const agent = await client.createAgent({ tools: {}, onEvent: event => { if (event.type === "file_presented") events.push(event); } });
  t.after(() => agent.close());
  const result = await agent.prompt("Make me a chart");
  assert.equal(result.reply, "Here is your chart.");
  assert.deepEqual(result.files.map((file: any) => [file.path, file.contentType]), [["/workspace/out/summary.md", "text/markdown"], ["/workspace/out/chart.svg", "image/svg+xml"]]);
  assert.deepEqual(result.presented.map((file: any) => [file.type, file.path, file.caption, file.contentType, file.size]), [["file", "/workspace/out/chart.svg", "Q3 chart", "image/svg+xml", 6]]);
  await until(() => events.length, "the file_presented event");
  assert.equal(events[0].file.path, "/workspace/out/chart.svg");
  const fetched = await fetch(events[0].url.replace("https://agents.example.test", server.base));
  assert.equal(fetched.headers.get("content-type"), "image/svg+xml");
  assert.equal(Buffer.from(await fetched.arrayBuffer()).length, 6);
  // Each run has its own list; a code execution is a run too.
  await agent.prompt("Thanks");
  const later = (await agent.outcomes()).requests.at(-1)!.outcome!.result as any;
  assert.equal(later.files, undefined);
  const executed = await agent.execute('await tools.present_file({ path: "/workspace/out/summary.md" })');
  assert.deepEqual(executed.presented.map((file: any) => file.path), ["/workspace/out/summary.md"]);
});
