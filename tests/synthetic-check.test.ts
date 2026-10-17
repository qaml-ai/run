import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

/** A fake public API for the synthetic check (infra/synthetic/check.mjs): /healthz, and POST /v1/runs answering `run`. */
async function fakeApi(t: { after(fn: () => unknown): void }, run: (body: any) => { status: number; body: unknown }, health = 200) {
  const seen: any[] = [];
  const server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    seen.push({ method: request.method, url: request.url, authorization: request.headers.authorization, body: text ? JSON.parse(text) : undefined });
    const answer = request.url === "/healthz" ? { status: health, body: { ok: health === 200 } } : run(text ? JSON.parse(text) : undefined);
    response.writeHead(answer.status, { "content-type": "application/json" }).end(JSON.stringify(answer.body));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen };
}

async function load(url: string) {
  Object.assign(process.env, { SYNTHETIC_URL: url, SYNTHETIC_SERVICE_NAME: "camelai-agent-runtime", SYNTHETIC_TOKEN: "synthetic-token" });
  // A fresh module per test: its URL is read when it loads.
  return await import(`../infra/synthetic/check.mjs?${Math.random()}`);
}

test("the synthetic check: health, then one stateless run answered OK (waited on while running), as an EMF line the alarm reads", async t => {
  let polls = 0;
  const api = await fakeApi(t, () => polls++ ? { status: 200, body: { id: "run_1", status: "completed", text: "OK.", error: null } } : { status: 202, body: { id: "run_1", status: "running" } });
  const check = await load(api.url);
  const result = await check.check();
  assert.equal(result.error, undefined);
  assert.deepEqual(api.seen.map(request => `${request.method} ${request.url}`), ["GET /healthz", "POST /v1/runs?wait=60", "GET /v1/runs/run_1?wait=25"]);
  assert.equal(api.seen[1].authorization, "Bearer synthetic-token");
  assert.deepEqual(api.seen[1].body.spendLimit, { usd: 0.05 });
  const line = JSON.parse(check.line(result, 1000));
  assert.equal(line._aws.CloudWatchMetrics[0].Namespace, "AgentRuntime");
  assert.deepEqual(line._aws.CloudWatchMetrics[0].Dimensions, [["ServiceName"]], "the -synthetic alarm reads the {ServiceName} set");
  assert.deepEqual([line.ServiceName, line.SyntheticChecks, line.SyntheticFailures, line.ok], ["camelai-agent-runtime", 1, 0, true]);
});

test("the synthetic check fails on a refusal (its status and code), a failed run, a reply that is not OK, or health", async t => {
  const refused = await load((await fakeApi(t, () => ({ status: 402, body: { code: "END_USER_CREDIT", error: "out of credit" } }))).url);
  assert.deepEqual(await refused.check().then((result: any) => [result.step, result.error]), ["run", "HTTP 402 END_USER_CREDIT"]);
  const failed = await load((await fakeApi(t, () => ({ status: 200, body: { id: "r", status: "failed", text: "", error: { code: "model_error", message: "x" } } }))).url);
  assert.deepEqual(await failed.check().then((result: any) => result.error), "run failed model_error");
  const wrong = await load((await fakeApi(t, () => ({ status: 200, body: { id: "r", status: "completed", text: "I cannot", error: null } }))).url);
  assert.equal((await wrong.check()).error, "the reply was not OK");
  const down = await load((await fakeApi(t, () => ({ status: 200, body: {} }), 503)).url);
  assert.deepEqual(await down.check(), { step: "healthz", error: "HTTP 503" });
});

test("a failed check names its step and the API's code, never a reply's text", async () => {
  const check = await load("http://127.0.0.1:9");
  const failed = JSON.parse(check.line({ step: "run", error: "HTTP 402 END_USER_CREDIT", runMs: 120 }, 1000));
  assert.deepEqual([failed.ok, failed.step, failed.error, failed.SyntheticFailures, failed.SyntheticRunMs], [false, "run", "HTTP 402 END_USER_CREDIT", 1, 120]);
  assert.ok(failed._aws.CloudWatchMetrics[0].Metrics.some((metric: { Name: string }) => metric.Name === "SyntheticRunMs"));
  // Unreachable: the handler catches it and writes a failed line.
  const lines: string[] = [];
  const log = console.log;
  console.log = (line: string) => lines.push(line);
  try { assert.deepEqual(await check.handler(), { ok: false }); } finally { console.log = log; }
  assert.equal(JSON.parse(lines[0]).SyntheticFailures, 1);
});
