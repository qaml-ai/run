import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type RequestListener } from "node:http";
import { Outbound, OutboundBlocked } from "../src/security-outbound.ts";
import { PublicOutbound } from "../src/public-outbound.ts";

async function server(handler: RequestListener) {
  const listener = createServer(handler);
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      listener.close(error => error ? reject(error) : resolve());
      listener.closeAllConnections();
    }),
  };
}
const outbound = () => new Outbound({ allowHttp: true, allow: ["127.0.0.1/32"] });

test("limited public outbound checks redirect destinations and explicit MCP exceptions", async () => {
  const networking = { type: "limited" as const, allowedHosts: ["example.com"], allowPackageManagers: false, allowMcpServers: false };
  let calls = 0;
  const policy = new PublicOutbound({ networking, resolve: async () => ["93.184.216.34"], transport: async () => {
    calls++; return new Response(null, { status: 302, headers: { location: "https://other.com/file" } });
  } });
  await assert.rejects(policy.fetch("https://example.com", { maxRedirects: 1 }), /Network destination is not allowed/);
  assert.equal(calls, 1);
  const mcp = new PublicOutbound({ networking: { ...networking, allowMcpServers: true }, mcpHosts: ["other.com"], resolve: async () => ["93.184.216.34"] });
  assert.equal((await mcp.reachable("https://other.com")).hostname, "other.com");
  await assert.rejects(policy.reachable("https://other.com"), /Network destination is not allowed/);
});

test("source outbound caps the response body, including webhook replies", async t => {
  const receiver = await server((_request, response) => response.end(Buffer.alloc(64 * 1024 + 1)));
  t.after(receiver.close);
  const response = await outbound().fetch(receiver.url, { maxBytes: 64 * 1024 });
  await assert.rejects(response.arrayBuffer(), /Response larger than 65536 bytes/);
});

test("source outbound deadline bounds headers and body; stream opts out after headers", async t => {
  const receiver = await server((request, response) => {
    if (request.url !== "/headers") { response.writeHead(200); response.write("first"); }
    const timer = setTimeout(() => response.end("last"), 180);
    response.on("close", () => clearTimeout(timer));
  });
  t.after(receiver.close);
  await assert.rejects(outbound().fetch(`${receiver.url}/headers`, { timeoutMs: 30 }), OutboundBlocked);
  const response = await outbound().fetch(`${receiver.url}/body`, { timeoutMs: 30 });
  await assert.rejects(response.text());
  const stream = await outbound().fetch(`${receiver.url}/stream`, { timeoutMs: 30, stream: true });
  assert.equal(await stream.text(), "firstlast");
});

test("source outbound refuses redirects by default and drops secrets across origins", async t => {
  let received: { secret?: string; method?: string } = {};
  const target = await server((request, response) => {
    received = { secret: request.headers["x-private"] as string | undefined, method: request.method };
    response.end("received");
  });
  t.after(target.close);
  const origin = await server((_request, response) => {
    response.writeHead(303, { location: target.url }); response.end();
  });
  t.after(origin.close);
  await assert.rejects(outbound().fetch(origin.url), /Redirects are not followed/);
  const response = await outbound().fetch(origin.url, { method: "POST", body: "data", secrets: { "x-private": "fake-test-value" }, maxRedirects: 1 });
  assert.equal(await response.text(), "received");
  assert.deepEqual(received, { secret: undefined, method: "GET" });
  assert.equal(response.url, target.url + "/");
});
