import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("ordered files keep failure reporting, timings and independent file timeouts", () => {
  const dir = mkdtempSync(join(tmpdir(), "test-files-"));
  try {
    const write = (name: string, body: string) => {
      const path = join(dir, `${name}.test.mjs`);
      writeFileSync(path, `import { test } from "node:test"; ${body}`);
      return path;
    };
    const invoke = (files: string[], timeout = 240_000) => spawnSync(process.execPath, [
      "--experimental-strip-types", `--test-timeout=${timeout}`, fileURLToPath(new URL("test-files.ts", import.meta.url)),
      join(dir, "timings.json"), join(dir, "failed"), ...files,
    ], { env: { ...process.env, NODE_TEST_CONTEXT: undefined, TEST_DATABASE_PER_FILE: undefined, TEST_CONCURRENCY: "1" }, encoding: "utf8" });
    const first = write("z", 'test("ordered first", () => {});');
    const failed = write("a", 'test("intentional failure", () => { throw new Error("fixture failure"); });');
    const result = invoke([first, failed]);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /# tests 2/);
    assert.ok(result.stdout.indexOf("ordered first") < result.stdout.indexOf("intentional failure"));
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(dir, "timings.json"), "utf8"))), ["z.test.mjs", "a.test.mjs"]);
    assert.equal(readFileSync(join(dir, "failed"), "utf8"), "a.test.mjs\n");
    const slow = write("slow", 'test("slow", async () => new Promise(resolve => setTimeout(resolve, 1_000)));');
    const timed = invoke([slow], 100);
    assert.equal(timed.status, 1, timed.stdout + timed.stderr);
    assert.match(timed.stdout, /testTimeoutFailure|timed out/);
    assert.equal(readFileSync(join(dir, "failed"), "utf8"), "slow.test.mjs\n");
    // Together these exceed the deadline; each file has its own timer.
    const separate = ["one", "two"].map(name => write(name, 'test("slow", async () => new Promise(resolve => setTimeout(resolve, 1_200)));'));
    const passed = invoke(separate, 2_000);
    assert.equal(passed.status, 0, passed.stdout + passed.stderr);
    assert.match(passed.stdout, /# pass 2/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
