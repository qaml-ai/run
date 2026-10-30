import { test } from "node:test";
import assert from "node:assert/strict";
import { HttpError } from "../src/http.ts";
import { limitHit, limitRefused } from "../src/limit-hits.ts";
import { RateLimited } from "../src/rate-limits.ts";

const MINUTE = 60_000;
/** The lines `fn` logs, parsed. Each test takes its own minutes: the throttle is the process's. */
function logged(t: { mock: { method: (object: object, name: string, fn: () => void) => { mock: { calls: { arguments: unknown[] }[] } } } }) {
  const log = t.mock.method(console, "log", () => {});
  return () => log.mock.calls.map(call => JSON.parse(String(call.arguments[0])));
}

test("one line per tenant, limit and minute, then how many more came", t => {
  const lines = logged(t);
  const at = 1_000 * MINUTE;
  for (let i = 0; i < 5; i++) limitHit({ tenant: "acme", limit: "api_requests", status: 429 }, at + i);
  limitHit({ tenant: "other", limit: "api_requests", status: 429 }, at + 5);
  limitHit({ tenant: "acme", limit: "SPEND_LIMIT", status: 402 }, at + 6);
  limitHit({ tenant: "acme", limit: "TOO_LARGE", status: 413, route: "/v1/volumes/:id/files/*" }, at + 7);
  limitHit({ tenant: "acme", limit: "TOO_LARGE", status: 413, route: "/v1/images" }, at + 8);
  assert.deepEqual(lines().map(line => [line.type, line.tenant, line.limit, line.status, line.route]), [
    ["limit_hit", "acme", "api_requests", 429, undefined], ["limit_hit", "other", "api_requests", 429, undefined], ["limit_hit", "acme", "SPEND_LIMIT", 402, undefined],
    ["limit_hit", "acme", "TOO_LARGE", 413, "/v1/volumes/:id/files/*"], ["limit_hit", "acme", "TOO_LARGE", 413, "/v1/images"],
  ]);
  limitHit({ tenant: "acme", limit: "api_requests", status: 429 }, at + MINUTE);
  const next = lines().slice(5);
  assert.deepEqual(next.map(line => [line.type, line.tenant, line.limit, line.repeats]), [["limit_hit_repeats", "acme", "api_requests", 4], ["limit_hit", "acme", "api_requests", undefined]]);
});

test("a flood stays one line a minute", t => {
  const lines = logged(t);
  const at = 2_000 * MINUTE;
  for (let i = 0; i < 100_000; i++) limitHit({ tenant: "acme", limit: "api_requests", status: 429 }, at + i % MINUTE);
  assert.equal(lines().filter(line => line.type === "limit_hit").length, 1);
});

test("a refusal is said by the first handler it reaches, by its limit's name or its code, and never with its message", t => {
  const lines = logged(t);
  const at = 3_000 * MINUTE;
  const secret = "/workspace/private-plans.txt is too large";
  const tooLarge = new HttpError(413, secret);
  limitRefused(tooLarge, 413, "acme", "volume:store", at);
  limitRefused(tooLarge, 413, "acme", "/v1/volumes/:id/files/*", at);
  limitRefused(new RateLimited({ name: "api_requests", scope: "ip", max: 600, windowSeconds: 60 }, 5, "Too many requests"), 429, undefined, undefined, at);
  limitRefused(new HttpError(402, `${secret} credit`, "END_USER_CREDIT"), 402, "acme", undefined, at);
  limitRefused(new HttpError(507, "full", "STORAGE_LIMIT"), 507, "acme", undefined, at);
  // Not a limit's refusal.
  for (const status of [400, 401, 403, 404, 409, 500, 503]) limitRefused(new HttpError(status, secret), status, "acme", undefined, at);
  const said = lines().filter(line => line.type === "limit_hit");
  assert.deepEqual(said.map(line => [line.tenant, line.limit, line.status]), [["acme", "TOO_LARGE", 413], [null, "api_requests", 429], ["acme", "END_USER_CREDIT", 402], ["acme", "STORAGE_LIMIT", 507]]);
  assert.ok(!JSON.stringify(said).includes("private-plans"), "what was refused is not logged");
});
