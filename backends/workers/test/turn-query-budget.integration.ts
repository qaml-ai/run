// Postgres statements one agent turn runs, counted by the pilot DB profile (src/db-profile.ts) inside the
// agent's Durable Object, from admission through post-turn settlement, webhooks and usage. The ceilings are
// the counts measured when this file was added (2026-11-13, camelfs/files-model c1975e42); each change that
// removes statements from a turn lowers its ceiling here, so a regression fails instead of drifting back.
//
// Front-Worker statements (directory lookups before the request reaches the object) are not in the DO
// profile and are not counted. The slow turn measures the per-second watchdog work while a model call is in
// flight; its ceiling carries a few statements of slack because tick timing varies run to run.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { startFixture } from "./fixture.ts";

const CEILINGS = {
  // Limit ticks read the admission snapshot, and balance reads no longer flush durable usage receipts (nothing on
  // Workers writes an unaccounted one): a few statements of run-to-run slack.
  // Measured 73 / 73 / 67 / 73 / 72 (was 87 / 82 / 93 / 82 / 82).
  simple: 80,
  // Measured 96 / 96 / 96 / 96 / 106 (was 128 / 123 / 123 / 123 / 123).
  tool: 112,
  // A 3 s model call; measured 88 / 81 / 83 / 88 / 81 (was 97 / 96 / 96 / 103 / 97).
  slow: 94,
} as const;

test("a turn's Postgres statements stay under the budget", { timeout: 180_000 }, async t => {
  const f = await startFixture({
    entrypoint: fileURLToPath(new URL("./alarm-entry.ts", import.meta.url)),
    vars: { PILOT_DB_PROFILE: "1" },
  });
  t.after(() => f.stop());
  const call = async (path: string, body?: unknown) => {
    const response = await fetch(f.url + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${f.token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const value = await response.json() as any;
    assert.ok(response.ok, `${path}: ${JSON.stringify(value)}`);
    return value;
  };
  const { id: agent } = await call("/v1/agents", { model: "test/echo" });
  type Phases = Record<string, { queries: number; statements: Record<string, { queries: number }> }>;
  const profile = async () => (await call(`/experimental/agents/${agent}/__test/alarm-state`)).profile as { epoch: string; phases: Phases };
  const total = (phases: Phases) => Object.values(phases).reduce((sum, phase) => sum + phase.queries, 0);
  /** The profile once post-turn work has landed: no new statement for 1.5 s. */
  const settled = async () => {
    let last = await profile();
    for (let quiet = 0, i = 0; quiet < 3; i++) {
      assert.ok(i < 60, "the agent kept running statements 30 s after its turn");
      await delay(500);
      const next = await profile();
      quiet = total(next.phases) === total(last.phases) ? quiet + 1 : 0;
      last = next;
    }
    return last;
  };
  const turn = async (id: string, text: string) => {
    const before = await settled();
    await call(`/v1/agents/${agent}/requests`, { id, method: "prompt", params: { text } });
    for (let i = 0; ; i++) {
      assert.ok(i < 200, `${id} did not complete`);
      if ((await call(`/v1/agents/${agent}/requests/${id}?wait=1`)).state === "completed") break;
    }
    const after = await settled();
    assert.equal(after.epoch, before.epoch, "the agent object restarted mid-measurement; its counts reset");
    const statements: Record<string, number> = {};
    for (const [phase, measures] of Object.entries(after.phases))
      for (const [category, { queries }] of Object.entries(measures.statements)) {
        const delta = queries - (before.phases[phase]?.statements[category]?.queries ?? 0);
        if (delta) statements[`${phase} ${category}`] = delta;
      }
    return { count: total(after.phases) - total(before.phases), statements };
  };

  const counts: Record<string, number> = {};
  const breakdowns: Record<string, Record<string, number>> = {};
  for (const [name, text] of [["simple", "hello"], ["tool", "tool:write:alpha"], ["slow", "slow:3000:hello slowly"]] as const) {
    const { count, statements } = await turn(name, text);
    counts[name] = count;
    breakdowns[name] = statements;
  }
  t.diagnostic(`statements per turn: ${JSON.stringify(counts)}`);
  for (const [name, statements] of Object.entries(breakdowns))
    t.diagnostic(`${name} billing reads: ${JSON.stringify(Object.fromEntries(Object.entries(statements)
      .filter(([category]) => / select:[^ ]*\b(?:tenants|credit_accounts)\b/.test(category))))}`);
  for (const name of Object.keys(CEILINGS) as (keyof typeof CEILINGS)[])
    assert.ok(counts[name] <= CEILINGS[name],
      `${name} turn ran ${counts[name]} statements, over its budget of ${CEILINGS[name]}:\n${JSON.stringify(Object.entries(breakdowns[name]).sort((a, b) => b[1] - a[1]), null, 1)}`);
});
