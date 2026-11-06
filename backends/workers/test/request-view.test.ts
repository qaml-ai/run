import assert from "node:assert/strict";
import test from "node:test";
import { requestView } from "../src/request-view.ts";

test("public requests omit pending input and billing internals", async () => {
  const view = await requestView({
    id: "run",
    method: "prompt",
    state: "queued",
    startedAt: 123,
    params: { text: "private-input" },
    fingerprint: '{"secret":"private-input"}',
    billing: { tenantId: "internal-tenant" },
    task: 7,
    piId: "internal-task",
    accepted: true,
    admitted: true,
    agentSpendAt: 456,
  });
  assert.equal(view.state, "running");
  assert.equal(view.id, "run");
  assert.equal(view.startedAt, 123);
  assert.match(view.fingerprint, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(
    JSON.stringify(view),
    /private-input|internal-tenant|internal-task|agentSpendAt|admitted|accepted/,
  );
});
