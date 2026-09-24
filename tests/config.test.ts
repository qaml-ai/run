import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Start the server with `env` and return what it failed with; the settings are checked before anything connects. */
function startupError(env: Record<string, string>) {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", fileURLToPath(new URL("../src/server.ts", import.meta.url))], {
    env: { PATH: process.env.PATH, AGENT_RUNTIME_TOKEN: "config-test-operator-token-24", AGENT_SESSION_SECRET: "config-test-session-secret-with-32-chars", ...env },
    encoding: "utf8", timeout: 30_000,
  });
  assert.notEqual(result.status, 0);
  return result.stderr;
}

test("hosted-agent caps are AGENT_MAX_AGENTS(_PER_TENANT), and the older AGENT_MAX_PROCESSES names still work", () => {
  assert.match(startupError({ AGENT_MAX_AGENTS: "0" }), /AGENT_MAX_AGENTS must be a positive integer/);
  assert.match(startupError({ AGENT_MAX_PROCESSES: "0" }), /AGENT_MAX_PROCESSES must be a positive integer/);
  assert.match(startupError({ AGENT_MAX_AGENTS_PER_TENANT: "x" }), /AGENT_MAX_AGENTS_PER_TENANT must be a positive integer/);
  assert.match(startupError({ AGENT_MAX_PROCESSES_PER_TENANT: "-1" }), /AGENT_MAX_PROCESSES_PER_TENANT must be a positive integer/);
  // The new name wins when both are set.
  assert.match(startupError({ AGENT_MAX_AGENTS: "0", AGENT_MAX_PROCESSES: "10" }), /AGENT_MAX_AGENTS must be/);
  // Valid caps get past the check (to the database, absent here).
  assert.doesNotMatch(startupError({ AGENT_MAX_AGENTS: "10", AGENT_MAX_PROCESSES_PER_TENANT: "5" }), /must be a positive integer/);
});
