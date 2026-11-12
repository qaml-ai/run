// Generates m-ts-port-50 from s-esm-refactor's fixed files: the same 50-module CommonJS package (input), ported to
// TypeScript this time, so the task is a port of 50+ files rather than a 16-file one. The hidden judge reuses
// s-esm-refactor's expected outputs (computed from the CommonJS originals) against the .ts modules, and the
// reference is s-esm-refactor's ES module reference with types added. Deterministic; regenerate only to change the
// task, and bump its version when you do.
//
//   node evals/workflows/tasks/m-ts-port-50/generate.mjs
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)), from = join(here, "..", "s-esm-refactor");
for (const dir of ["input", "hidden", "reference"]) rmSync(join(here, dir), { recursive: true, force: true });

// Input: the CommonJS package as it is, plus the strict tsconfig the port must pass.
cpSync(join(from, "input"), join(here, "input"), { recursive: true });
rmSync(join(here, "input", "MIGRATION.md"));
const tsconfig = { compilerOptions: { target: "ES2024", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true, allowImportingTsExtensions: true, skipLibCheck: true, types: [] }, include: ["lib/**/*.ts", "util/**/*.ts"] };
writeFileSync(join(here, "input", "tsconfig.json"), JSON.stringify(tsconfig) + "\n");

// Hidden: the same expected calls, against the .ts modules.
mkdirSync(join(here, "hidden"), { recursive: true });
const expected = JSON.parse(readFileSync(join(from, "hidden", "expected.json"), "utf8")).map(call => ({ ...call, file: call.file.replace(/\.js$/, ".ts") }));
writeFileSync(join(here, "hidden", "expected.json"), JSON.stringify(expected, null, 1) + "\n");
writeFileSync(join(here, "hidden", "tsconfig.json"), JSON.stringify(tsconfig) + "\n");
writeFileSync(join(here, "hidden", "port.test.mjs"), `// The hidden judge for m-ts-port-50: each ported module, imported from PORT_ROOT with type stripping, returns what
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
      assert.equal(typeof fn, "function", \`\${file} exports \${call.export}\`);
      assert.deepEqual(fn(...call.args), call.result, \`\${file} \${call.export}(\${JSON.stringify(call.args).slice(1, -1)})\`);
    }
  });
}
test("lib/index.ts re-exports every module", async () => {
  const index = await import(pathToFileURL(join(root, "lib/index.ts")).href);
  for (const file of new Set(expected.map((entry) => entry.file))) assert.equal(typeof index[file.slice(4, -3)], "object", file);
});
`);

// Reference: s-esm-refactor's ES modules, typed.
mkdirSync(join(here, "reference", "lib"), { recursive: true });
for (const name of readdirSync(join(from, "reference", "lib"))) {
  const typed = readFileSync(join(from, "reference", "lib", name), "utf8")
    .replace(/from "\.\/(m\d+)\.js"/g, 'from "./$1.ts"')
    .replace(/function (total\d+)\(qty\)/g, "function $1(qty: number): number")
    .replace(/function (describe\d+)\(name, qty\)/g, "function $1(name: unknown, qty: number): string")
    .replace(/function (percent\d+)\(part, whole\)/g, "function $1(part: number, whole: number): string")
    .replace(/function (combined\d+)\(qty\)/g, "function $1(qty: number): string");
  writeFileSync(join(here, "reference", "lib", name.replace(/\.js$/, ".ts")), typed);
}
writeFileSync(join(here, "reference", "package.json"), JSON.stringify({ name: "ledger-labels", version: "3.2.0", private: true, license: "MIT", type: "module", main: "lib/index.ts" }, null, 2) + "\n");
writeFileSync(join(here, "reference", "tsconfig.json"), JSON.stringify(tsconfig) + "\n");
console.log(`${expected.length} expected calls, ${readdirSync(join(here, "reference", "lib")).length} reference files`);
