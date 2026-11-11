// The hidden judge for s-esm-refactor. Never uploaded. Imports each migrated module from ESM_ROOT as an ES module
// and checks every exported function returns what the CommonJS original returned (expected.json, generated from
// the originals). One test per module.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const root = process.env.ESM_ROOT;
const expected = JSON.parse(readFileSync(new URL("./expected.json", import.meta.url), "utf8"));
const byFile = Map.groupBy(expected, (entry) => entry.file);
for (const [file, calls] of byFile) {
  test(file, async () => {
    const loaded = await import(pathToFileURL(join(root, file)).href);
    for (const call of calls) {
      const fn = loaded[call.export];
      assert.equal(typeof fn, "function", `${file} exports ${call.export}`);
      assert.deepEqual(fn(...call.args), call.result, `${file} ${call.export}(${JSON.stringify(call.args).slice(1, -1)})`);
    }
  });
}
test("lib/index.js re-exports every module", async () => {
  const index = await import(pathToFileURL(join(root, "lib/index.js")).href);
  for (const file of byFile.keys()) {
    const key = file.slice(4, -3);
    assert.equal(typeof index[key], "object", `index exports ${key}`);
  }
});
