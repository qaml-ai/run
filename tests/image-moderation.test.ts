import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import { imageModeration, MODERATION_IMAGE_BYTES } from "../src/image-moderation.ts";
import { Outbound } from "../src/outbound.ts";
import { RateLimits, rateLimitConfig, RateLimited } from "../src/rate-limits.ts";
import { testDatabase } from "./database.ts";
import { pngBytes } from "./file-fixtures.ts";
import { listen, runtime, free, OPERATOR, OTHER_OPERATOR } from "./runtime-server.ts";

const names = ["sexual", "sexual/minors", "harassment", "harassment/threatening", "hate", "hate/threatening", "illicit", "illicit/violent", "self-harm", "self-harm/intent", "self-harm/instructions", "violence", "violence/graphic"];
function result(flagged = false) { return {
  flagged, categories: Object.fromEntries(names.map(n => [n, flagged && n === "sexual"])),
  category_scores: Object.fromEntries(names.map(n => [n, flagged && n === "sexual" ? 0.99 : 0])),
  category_applied_input_types: Object.fromEntries(names.map(n => [n, n === "sexual/minors" ? [] : ["image"]])),
}; }
const image = pngBytes(32, 32), signal = new AbortController().signal;

test("moderation sends one inline image, preserves signals and never invents a clean result", async () => {
  let body: unknown = { id: "modr-test", model: "omni-moderation-latest", results: [result(true)] }, status = 200;
  const calls: any[] = [];
  const service = imageModeration({ key: () => "platform-fixture", admit: async () => undefined,
    outbound: { fetch: async (url, init) => { calls.push({ url, init }); return Response.json(body, { status }); } },
  });
  const checked = await service.check(image, "image/png", signal);
  assert.equal(checked.flagged, true);
  assert.deepEqual(checked.category_applied_input_types["sexual/minors"], []);
  assert.equal(calls[0].url, "https://api.openai.com/v1/moderations");
  assert.deepEqual(calls[0].init.secrets, { Authorization: "Bearer platform-fixture" });
  assert.equal(calls[0].init.maxRedirects, 0);
  assert.equal((await service.check(await sharp(image).jpeg().toBuffer(), "image/jpeg", signal)).flagged, true);
  assert.deepEqual(JSON.parse(calls[0].init.body), { model: "omni-moderation-latest", input: [{ type: "image_url", image_url: { url: `data:image/png;base64,${image.toString("base64")}` } }] });
  for (const invalid of [{}, { id: "x", model: "x", results: [] }, { id: "x", model: "x", results: [{ flagged: false }] },
    { id: "x", model: "x", results: [{ ...result(true), flagged: false }] },
    { id: "x", model: "x", results: [{ ...result(), category_scores: {} }] },
    { id: "x", model: "x", results: [{ ...result(), category_applied_input_types: Object.fromEntries(names.map(n => [n, []])) }] }]) {
    body = invalid;
    await assert.rejects(service.check(image, "image/png", signal), (e: any) => e.status === 502 && e.code === "MODERATION_FAILED");
  }
  body = { id: "x", model: "x", results: [result()] };
  for (status of [400, 401, 429, 500]) await assert.rejects(service.check(image, "image/png", signal), (e: any) => e.status === 502 && !e.message.includes("platform-fixture"));
  const sent = calls.length;
  await assert.rejects(service.check(new Uint8Array(MODERATION_IMAGE_BYTES + 1), "image/png", signal), (e: any) => e.status === 413);
  for (const [bytes, type] of [[image, "image/jpeg"], [image.subarray(0, 24), "image/png"], [Buffer.from("not image"), "image/png"]] as const)
    await assert.rejects(service.check(bytes, type, signal), (e: any) => e.status === 415);
  assert.equal(calls.length, sent);
  const missing = imageModeration({ key: () => undefined, admit: async () => undefined, outbound: {} as any });
  await assert.rejects(missing.check(image, "image/png", signal), (e: any) => e.status === 503);
});

test("moderation aborts a slow provider with a bounded error", async t => {
  const endpoint = await listen(t, async (_req, res) => { await new Promise(resolve => setTimeout(resolve, 150)); res.end("{}"); });
  const service = imageModeration({ key: () => "fixture", admit: async () => undefined, endpoint,
    timeoutMs: 30, outbound: new Outbound({ allowHttp: true, allow: ["127.0.0.1/32"] }),
  });
  await assert.rejects(service.check(image, "image/png", signal), (e: any) => e.status === 504 && e.code === "MODERATION_TIMEOUT");
});

test("moderation quota is atomic across nodes and independent for tenants", async () => {
  const { db } = await testDatabase();
  let now = 120_001;
  const create = () => new RateLimits({ db, config: rateLimitConfig({}), hashKey: "fixture", nodes: () => 2, free: async () => false, now: () => now });
  const a = create(), b = create();
  const answers = await Promise.allSettled(Array.from({ length: 125 }, (_, i) => (i % 2 ? a : b).imageModeration("one")));
  assert.equal(answers.filter(r => r.status === "fulfilled").length, 120);
  for (const answer of answers) if (answer.status === "rejected") {
    assert.ok(answer.reason instanceof RateLimited);
    assert.equal(answer.reason.retryAfter, 60);
  }
  assert.equal((await b.imageModeration("two")).remaining, 119);
  now += 60_000;
  assert.equal((await a.imageModeration("one")).remaining, 119);
});

test("HTTP moderation authenticates, caps bytes, uses platform key and does not need paid model runs", async t => {
  let count = 0;
  const endpoint = await listen(t, async (req, res) => {
    assert.equal(req.headers.authorization, "Bearer platform-fixture");
    for await (const _ of req) { /* drain */ }
    count++;
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "m", model: "omni-moderation-latest", results: [result()] }));
  });
  const { createHash } = await import("node:crypto");
  const hash = (s: string) => createHash("sha256").update(s).digest("hex");
  const r = await runtime(t, free(() => ({ role: "assistant", content: "ok" })), { AGENT_MODERATION_URL: endpoint, AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32" }, {
    tenants: { alice: { tokenSha256: hash(OPERATOR), apiKeys: { openai: "tenant-key-unused" }, maxMonthlyCost: 0 }, bob: { tokenSha256: hash(OTHER_OPERATOR) } },
    platformKeys: { openai: "platform-fixture" },
  });
  const send = (token: string | null, bytes: Uint8Array = image, type = "image/png") => fetch(`${r.base}/v1/moderations/images`, {
    method: "POST", headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": type }, body: new Uint8Array(bytes),
  });
  assert.equal((await send(null)).status, 401);
  const ok = await send(OPERATOR);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("x-ratelimit-limit"), "120");
  assert.deepEqual(await ok.json(), { id: "m", model: "omni-moderation-latest", ...result() });
  assert.equal((await send(OTHER_OPERATOR)).status, 200);
  assert.equal((await send(OPERATOR, image, "application/json")).status, 415);
  assert.equal((await send(OPERATOR, new Uint8Array(MODERATION_IMAGE_BYTES + 1))).status, 413);
  assert.equal(count, 2);
  // Force the current tenant window to its limit without 120 provider calls.
  const now = Date.now(), start = Math.floor(now / 60_000) * 60_000;
  await r.db.query("update rate_limits set count=120, window_start=$2, expires_at=$3 where key=$1", ["image_moderations:alice", start, start + 60_000]);
  const limited = await send(OPERATOR);
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("retry-after")) >= 1);
  assert.equal(limited.headers.get("x-ratelimit-remaining"), "0");
  assert.equal(count, 2);
});
