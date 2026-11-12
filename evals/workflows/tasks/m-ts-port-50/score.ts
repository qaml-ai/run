// Hidden scorer for m-ts-port-50: the judge's behaviour tests against the ported .ts modules (type stripping), and a
// strict typecheck under the judge's own tsconfig; .js left in lib/ or util/ counts as not ported.
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execIn, integrity, REPO, runHiddenNodeTests, walk, type Score } from "../../lib/score.ts";
import type { ScoreContext } from "../../lib/types.ts";

const EXPECTED = 51;

export async function score({ tree, input, judge, sandbox }: ScoreContext): Promise<Score> {
  const files = walk(tree);
  const jsLeft = files.filter(file => /^(lib|util)\/.*\.js$/.test(file));
  const ported = files.filter(file => /^lib\/.*\.ts$/.test(file)).length;
  const tests = runHiddenNodeTests(sandbox, tree, judge, ["port.test.mjs"], { env: { PORT_ROOT: "{work}" }, expected: EXPECTED, stripTypes: true });
  const stage = mkdtempSync(join(tmpdir(), "wf-eval-tsc-"));
  let typeErrors = -1;
  const notes: string[] = [];
  try {
    cpSync(tree, stage, { recursive: true });
    cpSync(join(judge, "tsconfig.json"), join(stage, "tsconfig.json"));
    if (ported) {
      const result = execIn(sandbox, stage, ["node", "{mount:/opt/node_modules}/typescript/bin/tsc", "-p", "tsconfig.json", "--pretty", "false"], { mounts: { "/opt/node_modules": join(REPO, "node_modules") } });
      typeErrors = (result.stdout.match(/error TS\d+/g) ?? []).length;
      if (result.status !== 0 && !typeErrors) { typeErrors = 1; notes.push(`tsc failed: ${(result.stderr || result.stdout).slice(0, 300)}`); }
    }
  } finally { rmSync(stage, { recursive: true, force: true }); }
  if (tests.counts.failures.length) notes.push(`hidden tests failed: ${tests.counts.failures.slice(0, 10).join(", ")}`);
  if (jsLeft.length) notes.push(`.js left: ${jsLeft.slice(0, 10).join(", ")}`);
  const typecheck = typeErrors < 0 || jsLeft.length ? 0 : typeErrors === 0 ? 1 : Math.max(0, 1 - typeErrors / 30);
  const value = 0.8 * (tests.passed / EXPECTED) + 0.2 * typecheck;
  return { value: Math.round(value * 1000) / 1000, passed: tests.passed, failed: tests.failed, expected: EXPECTED,
    checks: { modulesPorted: ported, jsLeft: jsLeft.length, typeErrors },
    integrity: integrity(input, tree, { tests: [], source: ["lib/**/*.{js,ts}", "util/**/*.{js,ts}"], protected: ["tsconfig.json"] }), notes };
}
