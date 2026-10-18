import { test } from "node:test";
import assert from "node:assert/strict";
import { request, type IncomingMessage } from "node:http";
import { once } from "node:events";
import { OPERATOR, runtime, sleep } from "./runtime-server.ts";

/** A GET over node:http, which shows the hop-by-hop headers fetch hides. */
const get = (url: string, headers: Record<string, string> = {}) => new Promise<{ response: IncomingMessage; body: string }>((resolve, reject) => {
  request(url, { headers: { Authorization: `Bearer ${OPERATOR}`, ...headers } }, response => {
    let body = ""; response.setEncoding("utf8");
    response.on("data", chunk => body += chunk).on("end", () => resolve({ response, body })).on("error", reject);
  }).on("error", reject).end();
});

test("idle sockets outlive the load balancer's 360 s; a drain answers a long poll under way in full, with Connection: close", async t => {
  const r = await runtime(t, () => ({ content: "done" }));
  const health = await get(`${r.base}/healthz`);
  assert.match(String(health.response.headers["keep-alive"]), /timeout=365/);
  const agent = (await r.call("/v1/agents", { body: {} })).json.id as string;
  // A long poll from the latest cursor, with nothing to say, waits; the drain starts while it does.
  const { cursor } = JSON.parse((await get(`${r.base}/v1/agents/${agent}/events?poll=1`)).body);
  let answered = false;
  const polled = get(`${r.base}/v1/agents/${agent}/events?poll=1&wait=5`, { "Last-Event-ID": String(cursor) }).finally(() => { answered = true; });
  await sleep(500);
  assert.equal(answered, false, "the poll waits");
  const exited = once(r.child, "exit");
  r.child.kill("SIGTERM");
  const { response } = await polled;
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers.connection, "close");
  await exited;
});
