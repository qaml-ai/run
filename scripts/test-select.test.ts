import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { selectTests, SMOKE } from "./test-select.ts";

function fixture(run: (root: string, write: (path: string, code?: string) => void) => void) {
  const root = mkdtempSync(join(tmpdir(), "test-select-"));
  const write = (path: string, code = "") => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), code); };
  try {
    for (const file of SMOKE) write(file);
    for (let i = 0; i < 20; i++) write(`tests/unrelated-${i}.test.ts`);
    run(root, write);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("transitive imports, re-exports, cycles, dynamic imports and JS extension resolution", () => fixture((root, write) => {
  write("src/leaf.ts");
  write("shared/barrel.ts", 'export * from "../src/leaf.js"; export * from "../clients/cycle.ts";');
  write("clients/cycle.ts", 'import "../shared/barrel.ts";');
  write("tests/one.test.ts", 'import { value } from "../shared/barrel.ts";');
  write("tests/two.test.ts", 'await import("../src/leaf.ts");');
  write("tests/three.test.ts", 'type T = import("../src/leaf.ts").T;');
  write("tests/four.test.ts", 'const t = require("../src/leaf.ts");');
  write("tests/ignored.test.ts", '// import "../src/leaf.ts";\nconst example = `import "../src/leaf.ts"`;');
  const result = selectTests(root, ["src/leaf.ts"]);
  assert.equal(result.full, false);
  assert.deepEqual(result.files, [...SMOKE, ...["one", "two", "three", "four"].map(s => `tests/${s}.test.ts`)].sort());
}));

test("changed test files select themselves, and extensionless directory imports resolve", () => fixture((root, write) => {
  write("src/feature/index.ts");
  write("tests/feature.test.ts", 'import "../src/feature";');
  assert.ok(selectTests(root, ["src/feature/index.ts"]).files.includes("tests/feature.test.ts"));
  assert.ok(selectTests(root, ["tests/unrelated-1.test.ts"]).files.includes("tests/unrelated-1.test.ts"));
}));

test("deleted modules still select importers; unmapped deletions fall back", () => fixture((root, write) => {
  write("tests/deletion.test.ts", 'import "../src/deleted.ts";');
  assert.equal(selectTests(root, ["src/deleted.ts"]).full, false);
  assert.ok(selectTests(root, ["src/deleted.ts"]).files.includes("tests/deletion.test.ts"));
  assert.equal(selectTests(root, ["src/unknown.ts"]).full, true);
}));

test("infrastructure and helpers always run all tests", () => fixture((root) => {
  for (const path of ["package.json", "package-lock.json", "tsconfig.json", "clients/tsconfig.test.json", "tests/database.ts", "tests/runtime-server.ts", "tests/sim/sim.ts", "scripts/test-shard.ts", "scripts/test-select.test.ts", "migrations/001.sql", ".github/workflows/ci.yml", ".github/ISSUE_TEMPLATE/bug.yml", "sandbox/file.rs", "Dockerfile", "plugins/unknown.ts"]) {
    const result = selectTests(root, [path]);
    assert.equal(result.full, true, path);
    assert.equal(result.files.length, 25);
  }
  assert.equal(selectTests(root, []).full, true);
}));

test("40 percent is inclusive; larger selections fall back to all tests", () => fixture((root, write) => {
  write("src/broad.ts");
  // 25 existing + five consumers = 30 tests; five smoke + seven selected = 12 (40%).
  for (let i = 0; i < 5; i++) write(`tests/broad-${i}.test.ts`, 'import "../src/broad.ts";');
  const changed = ["src/broad.ts", "tests/unrelated-0.test.ts", "tests/unrelated-1.test.ts"];
  assert.equal(selectTests(root, changed).full, false);
  const result = selectTests(root, [...changed, "tests/unrelated-2.test.ts"]);
  assert.equal(result.full, true);
  assert.match(result.reason, /40%/);
}));

test("local affected command includes tracked edits, forces process mode and propagates failures", () => fixture((root, write) => {
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  git("init", "-q");
  git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "-qm", "base");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  const path = "tests/unrelated-0.test.ts";
  for (const fail of [false, true]) {
    write(path, `import { test } from "node:test"; import assert from "node:assert/strict"; test("affected process mode", () => { assert.equal(process.env.AGENT_HOSTING, "process"); ${fail ? 'throw new Error("expected fixture failure");' : ''} });`);
    const result = spawnSync(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("test-select.ts", import.meta.url)), "--run"], {
      cwd: root, encoding: "utf8", env: { ...process.env, AGENT_HOSTING: "inline", NODE_TEST_CONTEXT: undefined },
    });
    assert.equal(result.status, fail ? 1 : 0, result.stdout + result.stderr);
    assert.match(result.stdout, /6 files \(process hosting\)/);
    assert.match(result.stdout, /affected process mode/);
  }
}));
