import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// scripts/sprite-test is only this repo's configuration; the machinery is scripts/sprite-test-core.sh, a copy of the core
// camel-bots runs too. The configuration names the core features it uses, so a core that lacks one fails here, and at
// every run, instead of drifting quietly.
const script = fileURLToPath(new URL("../scripts/sprite-test", import.meta.url));
const core = fileURLToPath(new URL("../scripts/sprite-test-core.sh", import.meta.url));

test("scripts/sprite-test and its core are valid bash", () => {
  execFileSync("bash", ["-n", script]);
  execFileSync("bash", ["-n", core]);
});

test("scripts/sprite-test-core.sh has every feature scripts/sprite-test requires", () => {
  const result = spawnSync("bash", [script, "--check-core"], { encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /all present/);
});
