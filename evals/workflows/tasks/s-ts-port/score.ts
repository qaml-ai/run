// Hidden scorer for s-ts-port: the judge's own tests against the ported src/index.ts (more cases than the visible
// tests), a strict typecheck under the judge's own tsconfig, and the integrity scan.
import { mkdtempSync, rmSync, cpSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execIn, integrity, REPO, runHiddenNodeTests, walk, read, type Score } from "../../lib/score.ts";
import type { ScoreContext } from "../../lib/types.ts";

const MODULES = ["index", "words", "case", "slugify", "truncate", "wrap", "levenshtein", "pluralize", "escape", "template", "csv", "pad", "table", "bytes", "duration", "ordinal"];
const HIDDEN_TESTS = 22;

export async function score({ tree, input, judge, sandbox }: ScoreContext): Promise<Score> {
  const files = walk(tree);
  const ported = MODULES.filter(name => files.includes(`src/${name}.ts`));
  const jsLeft = files.filter(file => /^src\/.*\.js$/.test(file));
  const check = integrity(input, tree, {
    tests: ["test/**/*.test.{js,ts}"],
    testRenames: path => [path, path.replace(/\.js$/, ".ts")],
    source: ["src/**/*.{js,ts}"],
    protected: ["tsconfig.json"],
  });
  const notes: string[] = [];
  const tests = existsSync(join(tree, "src/index.ts"))
    ? runHiddenNodeTests(sandbox, tree, judge, ["strkit.test.mjs"], { env: { STRKIT_ENTRY: "{work}/src/index.ts" }, expected: HIDDEN_TESTS, stripTypes: true })
    : (notes.push("no src/index.ts"), { passed: 0, failed: HIDDEN_TESTS, counts: undefined, result: undefined });
  if (tests.result && tests.passed < HIDDEN_TESTS) notes.push(...(tests.counts?.failures ?? []).map(name => `hidden test failed: ${name}`), ...(tests.counts?.tests ? [] : [`judge did not run: ${tests.result.stderr.slice(0, 400)}`]));
  // The judge's tsconfig, not the tree's, so an edited one changes nothing.
  const stage = mkdtempSync(join(tmpdir(), "wf-eval-tsc-"));
  let typeErrors = -1;
  try {
    cpSync(tree, stage, { recursive: true });
    cpSync(join(judge, "tsconfig.json"), join(stage, "tsconfig.json"));
    if (ported.length) {
      const result = execIn(sandbox, stage, ["node", "{mount:/opt/node_modules}/typescript/bin/tsc", "-p", "tsconfig.json", "--pretty", "false"], { mounts: { "/opt/node_modules": join(REPO, "node_modules") } });
      typeErrors = (result.stdout.match(/error TS\d+/g) ?? []).length;
      if (result.status !== 0 && !typeErrors) { typeErrors = 1; notes.push(`tsc failed: ${(result.stderr || result.stdout).slice(0, 300)}`); }
    }
  } finally { rmSync(stage, { recursive: true, force: true }); }
  const anys = walk(tree).filter(file => /^src\/.*\.ts$/.test(file)).reduce((sum, file) => sum + ((read(tree, file) ?? "").match(/:\s*any\b|<any>/g) ?? []).length, 0);
  const typecheck = typeErrors < 0 || jsLeft.length ? 0 : typeErrors === 0 ? 1 : Math.max(0, 1 - typeErrors / 30);
  const value = 0.75 * (tests.passed / HIDDEN_TESTS) + 0.25 * typecheck * (ported.length / MODULES.length);
  return { value: Math.round(value * 1000) / 1000, passed: tests.passed, failed: tests.failed, expected: HIDDEN_TESTS,
    checks: { modulesPorted: ported.length, modules: MODULES.length, jsLeft: jsLeft.length, typeErrors, explicitAny: anys }, integrity: check, notes };
}
