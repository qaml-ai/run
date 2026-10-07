import { test } from "node:test";
import assert from "node:assert/strict";
import { nodeConfig } from "../src/node-config.ts";

// What used to be the process's settings are each node's own, from its environment, and its agent processes are told
// its settings rather than inheriting the process's.
test("a node's js_exec, history and agent process settings come from its own environment, not the process's", () => {
  const before = { ...process.env };
  process.env.AGENT_HISTORY_BACKLOG_BYTES = "123";
  process.env.AGENT_CODE_WORKERS_MAX = "99";
  process.env.AGENT_OUTBOUND_ALLOW_HTTP = "true";
  try {
    const plain = nodeConfig({ PATH: "/node/bin" });
    assert.equal(plain.historyBacklogBytes, 8_000_000);
    assert.equal(plain.codeCapacity, 16);
    assert.equal(plain.sandboxRequired, false);
    assert.deepEqual({ prespawn: plain.v8.prespawn, max: plain.v8.max, jitless: plain.v8.jitless, seccomp: plain.v8.seccomp }, { prespawn: 0, max: 64, jitless: true, seccomp: true });
    assert.deepEqual(plain.agentEnv, { PATH: "/node/bin" });
    const tuned = nodeConfig({
      PATH: "/node/bin", AGENT_HISTORY_BACKLOG_BYTES: "100000", AGENT_CODE_WORKERS_MAX: "4", AGENT_SANDBOX_REQUIRED: "1", AGENT_SANDBOX_DIR: "/run/launcher",
      AGENT_V8_EXEC: "/opt/v8-exec", AGENT_V8_JITLESS: "false", AGENT_V8_MAX: "8", AGENT_OUTBOUND_ALLOW_CIDRS: "10.0.0.0/8", AGENT_SERVICE_NAME: "svc", OPENROUTER_API_KEY: "never passed on",
    });
    assert.equal(tuned.historyBacklogBytes, 100_000);
    assert.equal(tuned.codeCapacity, 4);
    assert.equal(tuned.sandboxRequired, true);
    assert.deepEqual({ binary: tuned.v8.binary, jitless: tuned.v8.jitless, prespawn: tuned.v8.prespawn, max: tuned.v8.max }, { binary: "/opt/v8-exec", jitless: false, prespawn: 2, max: 8 });
    assert.deepEqual(tuned.agentEnv, {
      PATH: "/node/bin", AGENT_SANDBOX_DIR: "/run/launcher", AGENT_OUTBOUND_ALLOW_CIDRS: "10.0.0.0/8", AGENT_HISTORY_BACKLOG_BYTES: "100000", AGENT_SERVICE_NAME: "svc",
    });
  } finally {
    for (const name of ["AGENT_HISTORY_BACKLOG_BYTES", "AGENT_CODE_WORKERS_MAX", "AGENT_OUTBOUND_ALLOW_HTTP"]) {
      if (before[name] === undefined) delete process.env[name]; else process.env[name] = before[name];
    }
  }
});
