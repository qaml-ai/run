import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// scripts/sprite-test is only this repo's configuration; the machinery is the shared core that ships with the sprites
// skill (~/.agents/skills/sprites/scripts/sprite-test-core.sh), also run by camel-bots. The configuration names the core
// features it uses, so a core that lacks one fails here, and at every run, instead of drifting quietly.
const script = fileURLToPath(new URL("../scripts/sprite-test", import.meta.url));
const core = process.env.SPRITE_TEST_CORE ?? join(homedir(), ".agents/skills/sprites/scripts/sprite-test-core.sh");

test("scripts/sprite-test is valid bash", () => {
  execFileSync("bash", ["-n", script]);
});

test(
  "the installed sprite-test core has every feature scripts/sprite-test requires",
  { skip: existsSync(core) ? false : `no sprite-test core at ${core} (CI and the sprites run without one)` },
  () => {
    const result = spawnSync("bash", [script, "--check-core"], { encoding: "utf8", env: { ...process.env, SPRITE_TEST_CORE: core } });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /all present/);
  },
);
