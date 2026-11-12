// The hidden judge for m-ts-port-50: each ported module, imported from PORT_ROOT with type stripping, returns what
// the CommonJS original returned for every call in expected.json. One test per module, and one for lib/index.ts.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const root = process.env.PORT_ROOT;
const expected = JSON.parse(readFileSync(new URL("./expected.json", import.meta.url), "utf8"));
for (const [file, calls] of Map.groupBy(expected, (entry) => entry.file)) {
  test(file, async () => {
    const loaded = await import(pathToFileURL(join(root, file)).href);
    for (const call of calls) {
      const fn = loaded[call.export];
      assert.equal(typeof fn, "function", `${file} exports ${call.export}`);
      assert.deepEqual(fn(...call.args), call.result, `${file} ${call.export}(${JSON.stringify(call.args).slice(1, -1)})`);
    }
  });
}
test("lib/index.ts re-exports every module", async () => {
  const index = await import(pathToFileURL(join(root, "lib/index.ts")).href);
  for (const file of new Set(expected.map((entry) => entry.file))) assert.equal(typeof index[file.slice(4, -3)], "object", file);
});
