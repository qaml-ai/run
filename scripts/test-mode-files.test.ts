import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allTestFiles, staticModeFiles, sensitiveFiles } from "./test-mode-files.ts";

test("dependency guard follows imports, re-exports, worker URLs and computed directory prefixes, excluding types", () => {
  const dir = mkdtempSync(join(tmpdir(), "mode-graph-"));
  try {
    mkdirSync(join(dir, "tests")); mkdirSync(join(dir, "src"));
    const write = (name: string, text: string) => writeFileSync(join(dir, name), text);
    write("src/target.ts", "export const value = 1;");
    write("tests/fixture.ts", 'export { value } from "../src/target.ts";');
    write("tests/value.test.ts", 'import { value } from "./fixture.ts";');
    write("tests/type.test.ts", 'import type { value } from "./fixture.ts";');
    write("tests/type-specifier.test.ts", 'import { type value } from "./fixture.ts";');
    write("tests/url.test.ts", 'new URL("../src/target.ts", import.meta.url);');
    write("tests/dynamic.test.ts", 'import("./fixture.ts");');
    write("tests/computed.test.ts", 'new URL(`../src/${name}.ts`, import.meta.url);');
    write("tests/cast.test.ts", 'new URL("../src/target.ts" as string, import.meta.url);');
    write("tests/new.test.ts", 'import "./new-selector.ts";');
    write("tests/new-selector.ts", 'import "../src/new.ts";');
    write("src/new.ts", 'const mode = process.env.AGENT_HOSTING;');
    const files = ["value", "type", "type-specifier", "url", "dynamic", "computed", "cast", "new"].map(name => `${name}.test.ts`);
    assert.deepEqual(staticModeFiles(files, dir, new Set(["src/target.ts"])), files.filter(file => !file.startsWith("type")));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("checked-in selection covers every static dependency and contains only current test files", () => {
  const selected = sensitiveFiles();
  assert.ok(selected.length > 0 && selected.length < allTestFiles.length);
  for (const file of staticModeFiles()) assert.ok(selected.includes(file), file);
});

test("shards partition the full inline suite and the process selection exactly once", async () => {
  const { spawnSync } = await import("node:child_process");
  const planned = spawnSync(process.execPath, ["--experimental-strip-types", "scripts/test-shard.ts", "--plan", "4", "5"], {
    env: { ...process.env, TEST_MODE_SCOPE: "sensitive" }, encoding: "utf8",
  });
  assert.equal(planned.status, 0, planned.stderr);
  for (const mode of ["inline", "process"]) {
    const assigned = planned.stdout.trim().split("\n").filter(line => line.startsWith(mode + " ")).flatMap(line => line.split(/~\d+s /)[1].split(" "));
    assert.equal(new Set(assigned).size, assigned.length);
    assert.deepEqual(assigned.sort(), mode === "inline" ? allTestFiles : sensitiveFiles());
  }
});
