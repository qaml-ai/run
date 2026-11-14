import test from "node:test";
import assert from "node:assert/strict";
import { AgentRunLimits, runCaps, runLimit } from "../src/run-limits.ts";
import { ADMIN_RUN_LIMITS, RUN_LIMITS } from "../src/run-caps-policy.ts";
test("run caps lower runtime defaults and preserve response, duration and spend classes", () => {
  const config = {
    runLimits: { maxResponses: 30, maxSeconds: 600 },
    spendLimit: { usd: 2 },
  };
  const run = {
    id: "a",
    began: 1000,
    params: {
      runLimits: { maxResponses: 10, maxSeconds: 1000 },
      spendLimit: { usd: 3 },
    },
  };
  assert.deepEqual(runCaps(config, run), {
    maxResponses: 10,
    maxSeconds: 600,
    spendUsd: 3,
  });
  assert.equal(
    runLimit(config, run, { responses: 10, costUsd: 0 }, 1001)?.code,
    "turn_limit",
  );
  assert.equal(
    runLimit(config, run, { responses: 0, costUsd: 0 }, 601000)?.code,
    "turn_limit",
  );
  assert.equal(
    runLimit(config, run, { responses: 0, costUsd: 3 }, 1001)?.code,
    "spend_limit",
  );
  assert.equal(
    runLimit(config, run, { responses: 9, costUsd: 1.99 }, 1001),
    undefined,
  );
});

test("tenant and admin caps bound explicit agent and request limits", () => {
  assert.deepEqual(runCaps({}, { id: "run" }), { ...RUN_LIMITS, spendUsd: Infinity });
  assert.deepEqual(runCaps({}, { id: "run" }, ADMIN_RUN_LIMITS), { ...ADMIN_RUN_LIMITS, spendUsd: Infinity });
  const run = { id: "run", began: 0, params: { runLimits: { maxResponses: 50, maxSeconds: 300 } } };
  assert.deepEqual(runCaps({ runLimits: { maxResponses: 20 } }, run, { maxResponses: 5, maxSeconds: 60 }), { maxResponses: 5, maxSeconds: 60, spendUsd: Infinity });
  assert.match(runLimit({}, run, { responses: 0, costUsd: 0 }, 60_000, { maxResponses: 5, maxSeconds: 60 })!.error, /time limit of 1 minute/);
});

test("a child's settled cost stops its parent before another model request", async () => {
  const values = new Map<string, unknown>([['run-usage:parent', { responses: 1, costUsd: 0.15 }]]);
  const storage = {
    get: async (key: string) => values.get(key),
    put: async (key: string, value: unknown) => { values.set(key, value); },
  } as unknown as DurableObjectStorage;
  const limits = new AgentRunLimits(storage, async () => ({
    config: {}, run: { id: 'parent', state: 'running', params: { spendLimit: { usd: 0.4 } } }, childCost: async () => 0.3,
  }));
  assert.deepEqual(await limits.check(), {
    error: 'This run has reached its spend limit of $0.4 ($0.45 spent)',
    limit: 'run', code: 'spend_limit', stopped: 'spend_limit',
  });
});

test("a watchdog tick and deadline use the snapshot without SQL", async () => {
  const values = new Map<string, unknown>([['run-usage:parent', { responses: 1, costUsd: 0.125 }]]);
  const storage = {
    get: async (key: string) => values.get(key),
    put: async (key: string, value: unknown) => { values.set(key, value); },
  } as unknown as DurableObjectStorage;
  const limits = new AgentRunLimits(storage, async () => ({
    config: {},
    run: {
      id: "parent", state: "running", began: 1000,
      limitsSnapshot: {
        spend: { usd: 1, spent: 0.5, setAt: 0 },
        childCostAtAdmission: 0.25,
        most: { maxSeconds: 8, maxResponses: 10 },
      },
    },
    agentId: "agent",
    childCost: async () => 0.625,
    authoritative: async () => assert.fail("snapshot checks must not read Postgres"),
  }));
  assert.equal(await limits.deadline(), 9000);
  const stopped = await limits.check(2000, false);
  assert.equal(stopped?.limit, "agent");
  assert.match(stopped!.error, /\(\$1 spent since it was set\)/);
  assert.equal(values.get("run-limit:parent"), stopped);
});

test("provider preflight and legacy ticks read current spend", async () => {
  const storage = { get: async () => undefined, put: async () => {} } as unknown as DurableObjectStorage;
  const snapshot = { spend: null, childCostAtAdmission: 0, most: RUN_LIMITS };
  const run: { id: string; state: string; limitsSnapshot?: typeof snapshot } = {
    id: "parent", state: "running", limitsSnapshot: snapshot,
  };
  let reads = 0;
  const limits = new AgentRunLimits(storage, async () => ({
    config: {}, run, agentId: "agent",
    authoritative: async () => {
      reads++;
      return { spend: { usd: 0, spent: 0, setAt: 0 }, most: RUN_LIMITS };
    },
  }));
  assert.equal(await limits.check(1000, false), undefined);
  assert.equal(reads, 0);
  assert.equal((await limits.check())?.limit, "agent");
  assert.equal(reads, 1);
  delete run.limitsSnapshot;
  assert.equal((await limits.check(1000, false))?.limit, "agent");
  assert.equal(reads, 2);
});
