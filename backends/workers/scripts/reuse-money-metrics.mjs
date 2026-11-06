import { readFile, writeFile } from "node:fs/promises";
import ts from "../node_modules/typescript/lib/typescript.js";

const root = new URL("../../../", import.meta.url);
const output = new URL("../src/", import.meta.url);
const metricSource = await readFile(new URL("src/metrics.ts", root), "utf8");
const ast = ts.createSourceFile("metrics.ts", metricSource, ts.ScriptTarget.Latest, true);
const selected = ["recordEventMetrics", "deliveryLine"].map(name => {
  const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  if (!declaration) throw new Error(`Missing source metric: ${name}`);
  return declaration.getText(ast);
});
const files = new Map([
  ["money-event-metrics.ts", [
    "// Generated from src/metrics.ts; source function bodies are unchanged.",
    "// Run node backends/workers/scripts/reuse-money-metrics.mjs --check to check source drift.",
    'import type { WebhookEvent } from "./webhook-policy.ts";',
    'import { errorClass, metricLine } from "./metrics-policy.ts";',
    'import { emitSourceMetric as emit } from "./money-metrics.ts";',
    'const metricService = "workers";',
    ...selected,
    "",
  ].join("\n\n")],
  ["money-limit-metrics.ts", [
    "// Generated from src/limit-hits.ts; only host imports and the log sink are replaced.",
    "// Run node backends/workers/scripts/reuse-money-metrics.mjs --check to check source drift.",
    'import { writeMetricLine } from "./money-metrics.ts";',
    "const console = { log: writeMetricLine };",
    (await readFile(new URL("src/limit-hits.ts", root), "utf8")).replace('"./http.ts"', '"./errors.ts"'),
  ].join("\n\n")],
]);
for (const [name, source] of files) {
  const target = new URL(name, output);
  if (process.argv.includes("--check")) {
    if (await readFile(target, "utf8") !== source) throw new Error(`${name} differs from source`);
  } else await writeFile(target, source);
}
console.log("Money event and limit metrics match src/");
