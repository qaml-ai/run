import { test } from "node:test";
import assert from "node:assert/strict";
import { Attempt, httpAttempt, meter, resolveKey, route } from "../src/capabilities/router.ts";
import type { UsageRecord } from "../src/client-sessions/state.ts";

const search = { one: "search", many: "searches" };
const run = (order: string[], options: { keys?: Record<string, boolean>; answers: Record<string, () => unknown>; signal?: AbortSignal; key?: (provider: string) => Promise<any> }) => {
  const tried: string[] = [];
  return { tried, routed: route({
    kind: "thing", tenant: "t", agent: "a", order, signal: options.signal,
    key: options.key ?? (async provider => options.keys?.[provider] === false ? undefined : { key: `key-${provider}`, platform: provider === "platform" }),
    attempt: async (provider, credential) => { tried.push(`${provider}:${credential.key}`); return options.answers[provider]!(); },
    exhausted: (failures, unkeyed) => new Error(`failed [${failures.join("; ")}] unkeyed [${unkeyed.join(",")}]`),
  }) };
};
const fails = (message: string, next = true) => () => { throw new Attempt(message, next); };

/** Run `fn` with console.error captured. */
async function logged<T>(fn: () => Promise<T>) {
  const lines: string[] = [], original = console.error;
  console.error = (line: string) => { lines.push(line); };
  try { return { lines, value: await fn() }; } finally { console.error = original; }
}

test("route answers from the first provider, without touching the rest or logging a fallback", async () => {
  const { lines, value } = await logged(async () => { const r = run(["a", "b"], { answers: { a: () => "from a", b: () => assert.fail("not reached") } }); return { ...await r.routed, tried: r.tried }; });
  assert.deepEqual(value, { provider: "a", credential: { key: "key-a", platform: false }, value: "from a", tried: ["a:key-a"] });
  assert.deepEqual(lines, []);
});

test("route skips a provider without a key, moves on when told to, and logs what failed before the one that answered", async () => {
  const { lines, value } = await logged(async () => { const r = run(["a", "b", "c"], { keys: { a: false }, answers: { b: fails("b is down"), c: () => "from c" } }); return { ...await r.routed, tried: r.tried }; });
  assert.deepEqual(value.tried, ["b:key-b", "c:key-c"]);
  assert.equal(value.provider, "c");
  assert.deepEqual(lines.map(line => JSON.parse(line)), [{ type: "thing_fallback", tenant: "t", agent: "a", answered: "c", failed: ["b is down"] }]);
});

test("route stops at an Attempt that says not to go on, and tells exhausted what failed and what had no key", async () => {
  const r = run(["a", "b", "c"], { keys: { a: false }, answers: { b: fails("b refused", false), c: () => assert.fail("not reached") } });
  await assert.rejects(r.routed, /^Error: failed \[b refused\] unkeyed \[a\]$/);
  assert.deepEqual(r.tried, ["b:key-b"]);
  await assert.rejects(run(["a", "b"], { keys: { a: false, b: false }, answers: {} }).routed, /^Error: failed \[\] unkeyed \[a,b\]$/);
  await assert.rejects(run(["a", "b"], { answers: { a: fails("one"), b: fails("two") } }).routed, /^Error: failed \[one; two\] unkeyed \[\]$/);
});

test("route ends at an error that is not an Attempt, a refused key, or an abort, each as it is", async () => {
  const bug = new TypeError("a bug");
  const r = run(["a", "b"], { answers: { a: () => { throw bug; }, b: () => assert.fail("not reached") } });
  await assert.rejects(r.routed, error => error === bug);
  assert.deepEqual(r.tried, ["a:key-a"]);

  const refused = new Error("out of credit");
  await assert.rejects(run(["a", "b"], { key: async () => { throw refused; }, answers: {} }).routed, error => error === refused);

  // An abort ends it even where the attempt's failure would have moved on.
  const controller = new AbortController();
  const aborted = new Attempt("aborted", true);
  const a = run(["a", "b"], { signal: controller.signal, answers: { a: () => { controller.abort(); throw aborted; }, b: () => assert.fail("not reached") } });
  await assert.rejects(a.routed, error => error === aborted);
});

test("httpAttempt moves on from a refused key, payment, timeout, rate limit or server error, and stops at any other 4xx", () => {
  const cases: [number, string, boolean][] = [
    [401, "x rejected the search API key (HTTP 401)", true],
    [403, "x rejected the search API key (HTTP 403)", true],
    [402, "x refused the search for payment (HTTP 402)", true],
    [408, "x search failed (HTTP 408)", true],
    [429, "x is rate limiting searches (HTTP 429)", true],
    [500, "x search failed (HTTP 500)", true],
    [503, "x search failed (HTTP 503)", true],
    [400, "x refused the search request (HTTP 400)", false],
    [404, "x refused the search request (HTTP 404)", false],
    [422, "x refused the search request (HTTP 422)", false],
  ];
  for (const [status, message, next] of cases) {
    const attempt = httpAttempt("x", status, search);
    assert.ok(attempt instanceof Attempt);
    assert.deepEqual([attempt.message, attempt.next], [message, next]);
  }
});

test("resolveKey: only the platform's own key is the platform's, and only it is refused for spent credit", async () => {
  const refusal = new Error("out of credit");
  const accounts = (source: string | undefined, limited?: Error) => {
    const checks: string[] = [];
    return { checks, accounts: {
      providerKey: async () => source ? { key: "k", source } : undefined,
      billing: { creditLimit: async (tenant: string) => { checks.push(tenant); return limited; } },
    } as any };
  };
  assert.equal(await resolveKey(accounts(undefined).accounts, "t", "p"), undefined);

  for (const source of ["tenant", "admin"]) {
    const a = accounts(source, refusal);
    assert.deepEqual(await resolveKey(a.accounts, "t", "p"), { key: "k", platform: false });
    assert.deepEqual(a.checks, []);
  }

  const platform = accounts("platform");
  assert.deepEqual(await resolveKey(platform.accounts, "t", "p"), { key: "k", platform: true });
  assert.deepEqual(platform.checks, ["t"]);
  await assert.rejects(resolveKey(accounts("platform", refusal).accounts, "t", "p"), error => error === refusal);
});

test("meter records the tenant's usage and charges its end user", () => {
  const usage = { provider: "p", model: "m", usage: { cost: { total: 1 } }, platform: true } as UsageRecord;
  const calls: unknown[][] = [];
  meter({ recordUsage: (...args: unknown[]) => { calls.push(["record", ...args]); } } as any, { endUserCharge: (...args) => { calls.push(["charge", ...args]); } }, "t", "a", usage);
  assert.deepEqual(calls, [["record", "t", "a", usage], ["charge", "a", usage]]);
});
