import test from "node:test";
import assert from "node:assert/strict";
import { runCaps, runLimit } from "../src/run-limits.ts";
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
