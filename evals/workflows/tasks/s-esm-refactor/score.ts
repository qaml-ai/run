// Hidden scorer for s-esm-refactor: each module counts when its hidden behaviour test passes and the file is clean
// ES module code with no legacy formatter; then the package-level requirements.
import { integrity, read, runHiddenNodeTests, walk, type Score } from "../../lib/score.ts";
import type { ScoreContext } from "../../lib/types.ts";

const LEGACY = /\brequire\s*\(|\bmodule\.exports\b|(?:^|[^.\w])exports\.\w+\s*=|\blegacyFormat\b|^\s*['"]use strict['"]/m;

export async function score({ tree, input, judge, sandbox }: ScoreContext): Promise<Score> {
  const modules = walk(input).filter(file => /^lib\/m\d+\.js$/.test(file));
  const expected = modules.length + 1;
  const tests = runHiddenNodeTests(sandbox, tree, judge, ["esm.test.mjs"], { env: { ESM_ROOT: "{work}" }, expected });
  const okNames = new Set([...tests.result.stdout.matchAll(/^ok \d+ - (.+)$/gm)].map(match => match[1]!.trim()));
  const unclean = modules.filter(file => { const text = read(tree, file); return text === undefined || LEGACY.test(text); });
  const counted = modules.filter(file => okNames.has(file) && !unclean.includes(file)).length + (okNames.has("lib/index.js re-exports every module") && !LEGACY.test(read(tree, "lib/index.js") ?? "require(") ? 1 : 0);
  let typeModule = false;
  try { typeModule = JSON.parse(read(tree, "package.json") ?? "{}").type === "module"; } catch { /* not JSON */ }
  const legacyDeleted = !walk(tree).includes("util/legacy-format.js");
  const value = (counted / expected) * (typeModule ? 1 : 0.9) * (legacyDeleted ? 1 : 0.95);
  const notes = [...(tests.counts.failures.length ? [`hidden tests failed: ${tests.counts.failures.slice(0, 10).join(", ")}`] : []), ...(unclean.length ? [`still CommonJS or legacyFormat: ${unclean.slice(0, 10).join(", ")}`] : [])];
  return { value: Math.round(value * 1000) / 1000, passed: counted, failed: expected - counted, expected,
    checks: { behaviourPassed: tests.passed, uncleanModules: unclean.length, typeModule, legacyDeleted },
    integrity: integrity(input, tree, { tests: [], source: ["lib/**/*.js"] }), notes };
}
