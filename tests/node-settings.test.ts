import { test } from "node:test";
import assert from "node:assert/strict";
import { nodeConfig } from "../src/node-config.ts";
import { loadDecision, MAX_RESUMES } from "../src/client-sessions.ts";

// What used to be the process's settings are each node's own, from its environment, and its agent processes are told
// its settings rather than inheriting the process's.
test("a node's js_exec and agent process settings come from its own environment, not the process's", () => {
  const before = { ...process.env };
  process.env.AGENT_CODE_WORKERS_MAX = "99";
  process.env.AGENT_OUTBOUND_ALLOW_HTTP = "true";
  try {
    const plain = nodeConfig({ PATH: "/node/bin" });
    assert.equal(plain.codeCapacity, 16);
    assert.equal(plain.sandboxRequired, false);
    assert.deepEqual({ prespawn: plain.v8.prespawn, max: plain.v8.max, jitless: plain.v8.jitless, seccomp: plain.v8.seccomp }, { prespawn: 0, max: 64, jitless: true, seccomp: true });
    assert.deepEqual(plain.agentEnv, { PATH: "/node/bin" });
    const tuned = nodeConfig({
      PATH: "/node/bin", AGENT_CODE_WORKERS_MAX: "4", AGENT_SANDBOX_REQUIRED: "1", AGENT_SANDBOX_DIR: "/run/launcher",
      AGENT_V8_EXEC: "/opt/v8-exec", AGENT_V8_JITLESS: "false", AGENT_V8_MAX: "8", AGENT_OUTBOUND_ALLOW_CIDRS: "10.0.0.0/8", AGENT_SERVICE_NAME: "svc", OPENROUTER_API_KEY: "never passed on",
    });
    assert.equal(tuned.codeCapacity, 4);
    assert.equal(tuned.sandboxRequired, true);
    assert.deepEqual({ binary: tuned.v8.binary, jitless: tuned.v8.jitless, prespawn: tuned.v8.prespawn, max: tuned.v8.max }, { binary: "/opt/v8-exec", jitless: false, prespawn: 2, max: 8 });
    assert.deepEqual(tuned.agentEnv, {
      PATH: "/node/bin", AGENT_SANDBOX_DIR: "/run/launcher", AGENT_OUTBOUND_ALLOW_CIDRS: "10.0.0.0/8", AGENT_SERVICE_NAME: "svc",
    });
  } finally {
    for (const name of ["AGENT_CODE_WORKERS_MAX", "AGENT_OUTBOUND_ALLOW_HTTP"]) {
      if (before[name] === undefined) delete process.env[name]; else process.env[name] = before[name];
    }
  }
});

test("the legacy engine's settings are accepted and ignored: a node that still has them starts, and says so", () => {
  assert.deepEqual(nodeConfig({}).ignored, []);
  for (const engine of ["legacy", "pi-durable"]) {
    const config = nodeConfig({ AGENT_ENGINE: engine, AGENT_PI_CANARY_AGENTS: "a,b", AGENT_PI_CANARY_TENANTS: "" });
    assert.deepEqual(config.ignored, ["AGENT_ENGINE", "AGENT_PI_CANARY_AGENTS", "AGENT_PI_CANARY_TENANTS"]);
  }
});

test("node-loss resume limit defaults to two and accepts only positive integers", () => {
  assert.equal(MAX_RESUMES, 2);
  assert.equal(nodeConfig({}).maxResumes, MAX_RESUMES);
  assert.equal(nodeConfig({ AGENT_MAX_RESUMES: "7" }).maxResumes, 7);
  for (const value of ["0", "-1", "1.5", "NaN", ""]) assert.throws(() => nodeConfig({ AGENT_MAX_RESUMES: value }), /AGENT_MAX_RESUMES/);
});

test("the configured resume limit applies to the same run, while a clean handoff is not a resume", () => {
  const request = { id: "run", fingerprint: "run", method: "prompt" as const, state: "running" as const, began: 1, resumes: 1 };
  assert.equal(loadDecision(request, 1), "resume_limit");
  assert.equal(loadDecision(request, 2), "resume");
  assert.equal(loadDecision({ ...request, handedOff: { step: "model", boundaryWaitMs: 0 } }, 1), "resume");
});

test("the host transcript's settings are ignored, and said so: every agent's history is its Pi journal", () => {
  const settings = { AGENT_HISTORY_BACKLOG_BYTES: "100000", AGENT_PI_DUAL_READ: "log", AGENT_PI_DUAL_WRITE: "1", AGENT_PI_HISTORY_SOURCE_TENANTS: "camel_bots" };
  assert.deepEqual(nodeConfig(settings).ignored, Object.keys(settings));
  assert.deepEqual(nodeConfig({ ...settings, PATH: "/node/bin" }).agentEnv, { PATH: "/node/bin" });
});

test("memory retirement defaults to off, accepts zero, and rejects invalid windows", () => {
  assert.equal(nodeConfig({}).memoryRetireMs, 0);
  assert.equal(nodeConfig({}).memoryRetireFallbackMs, 600_000);
  assert.equal(nodeConfig({ AGENT_MEMORY_RETIRE_FALLBACK_MS: "1234" }).memoryRetireFallbackMs, 1234);
  assert.throws(() => nodeConfig({ AGENT_MEMORY_RETIRE_FALLBACK_MS: "0" }), /AGENT_MEMORY_RETIRE_FALLBACK_MS/);
  assert.equal(nodeConfig({ AGENT_MEMORY_RETIRE_MS: "0" }).memoryRetireMs, 0);
  assert.equal(nodeConfig({ AGENT_MEMORY_RETIRE_MS: "1234" }).memoryRetireMs, 1234);
  for (const value of ["-1", "1.5", "NaN", "Infinity"]) {
    assert.throws(() => nodeConfig({ AGENT_MEMORY_RETIRE_MS: value }), /AGENT_MEMORY_RETIRE_MS/);
  }
});

test("the removed user entry deduplication setting is accepted and ignored", () => {
  const config = nodeConfig({ AGENT_PI_DEDUPE_USER_ENTRIES: "true" });
  assert.ok(config.ignored.includes("AGENT_PI_DEDUPE_USER_ENTRIES"));
  assert.equal(config.agentEnv.AGENT_PI_DEDUPE_USER_ENTRIES, undefined);
});
