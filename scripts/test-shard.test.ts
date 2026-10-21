import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("test-shard.ts", import.meta.url));
function plan(selected?: string[], includeSim = false) {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", script, "--plan", "5"], {
    encoding: "utf8", env: { ...process.env, TEST_FILES: selected && JSON.stringify(selected), TEST_INCLUDE_SIM: String(includeSim) },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.split("\n").filter(line => line.startsWith("process "));
}

test("PR process shards cover each selected file once, including internally inline sims", () => {
  const selected = ["tests/agent-host.test.ts", "tests/sim.test.ts", "tests/sim-hooks.test.ts", "tests/config.test.ts"];
  const lines = plan(selected, true);
  const files = lines.flatMap(line => line.replace(/^process \d+\/\d+: ~\d+s /, "").split(" ").filter(Boolean));
  assert.deepEqual(files.sort(), selected.map(file => file.slice(6)).sort());
  assert.ok(lines.some(line => /~0s $/.test(line)), "unused shards have no files");
  assert.doesNotMatch(plan(undefined).join("\n"), / sim(?:-|\.)/);
  assert.match(plan(undefined, true).join("\n"), / sim\.test\.ts/);
});

test("an empty selected shard exits without invoking the test runner", () => {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", script, "1/5"], {
    encoding: "utf8", env: { ...process.env, TEST_FILES: "[]" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /empty shard/);
});
