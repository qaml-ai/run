import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("test-shard.ts", import.meta.url));
function plan(selected: string[]) {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", script, "--plan", "5"], {
    encoding: "utf8", env: { ...process.env, TEST_FILES: JSON.stringify(selected) },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trimEnd().split("\n");
}

test("Both hosting modes run every selected file once", () => {
  const selected = ["tests/agent-host.test.ts", "tests/config.test.ts"];
  const planLines = plan(selected);
  for (const mode of ["process", "inline"]) {
    const lines = planLines.filter(line => line.startsWith(mode + " "));
    assert.equal(lines.length, 5);
    const files = lines.flatMap(line => line.split(/~\d+s/)[1].trim().split(" ").filter(Boolean));
    assert.deepEqual(files.sort(), selected.map(file => file.slice(6)).sort());
    assert.ok(lines.some(line => /~0s\s*$/.test(line)), "unused shards have no files");
  }
});

test("an empty selected shard exits without invoking the test runner", () => {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", script, "1/5"], {
    encoding: "utf8", env: { ...process.env, TEST_FILES: "[]" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /empty shard/);
});

test("the failures reporter names each failing file once, and writes * for a top-level failure no file is named for", async () => {
  const { default: failures } = await import("./test-failures-reporter.ts");
  const events = async function* () {
    yield { type: "test:fail", data: { file: "/x/tests/a.test.ts", nesting: 0 } };
    yield { type: "test:fail", data: { file: "/x/tests/a.test.ts", nesting: 1 } };
    yield { type: "test:fail", data: { file: "/x/tests/a.test.ts", nesting: 0 } };
    yield { type: "test:pass", data: { file: "/x/tests/b.test.ts", nesting: 0 } };
    yield { type: "test:fail", data: { file: "/x/tests/c.test.ts", nesting: 0 } };
    yield { type: "test:fail", data: { nesting: 0 } };
  };
  let written = "";
  for await (const chunk of failures(events())) written += chunk;
  assert.equal(written, "a.test.ts\nc.test.ts\n*\n");
});
