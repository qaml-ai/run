import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "../node_modules/typescript/lib/typescript.js";

const here = dirname(fileURLToPath(import.meta.url));
const inventory = [];
for (const name of ["webhooks", "usage-webhooks", "end-user-webhooks"]) {
  const source = await readFile(resolve(here, `../../../tests/${name}.test.ts`), "utf8");
  const ast = ts.createSourceFile(`${name}.ts`, source, ts.ScriptTarget.Latest, true);
  const parts = [];
  let included = 0;
  for (const statement of ast.statements) {
    let text = statement.getText(ast);
    if (ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression) && statement.expression.expression.getText(ast) === "test") {
      const title = statement.expression.arguments[0];
      const reason = /\b(?:runtime|cluster)\(/.test(text) ? "ECS runtime/cluster fixture; generated service delivery coverage is in webhook-delivery.test.ts" : undefined;
      inventory.push({ file: `tests/${name}.test.ts`, test: ts.isStringLiteral(title) ? title.text : "unknown", included: !reason, ...(reason ? { reason } : {}) });
      if (reason) continue;
      included++;
    }
    if (ts.isImportDeclaration(statement)) {
      const path = statement.moduleSpecifier.text;
      if (["./runtime-server.ts", "./cluster-helpers.ts", "./provider-fixtures.ts"].includes(path)) continue;
      if (path === "./database.ts") text = 'import { testDatabase } from "./billing-database.ts";';
      if (path === "../src/db.ts") text = text.replace(path, "../src/postgres.ts");
      if (path === "../src/webhooks.ts") text = text.replace(path, "../src/webhook-policy.ts");
    }
    parts.push(text);
  }
  // Do not create empty suites that could be mistaken for the ECS integration coverage.
  if (!included) continue;
  const output = `// Ported from tests/${name}.test.ts. Included assertions and test bodies are unchanged.\n// Only imports and the isolated Postgres fixture differ; see webhook-policy-port.json for ECS exclusions.\n${parts.join("\n\n")}\n`;
  const path = resolve(here, `../test/${name}.test.ts`);
  if (process.argv.includes("--check")) {
    if (await readFile(path, "utf8") !== output) throw new Error(`${name} port drifted`);
  } else await writeFile(path, output);
}
const text = JSON.stringify(inventory, null, 2) + "\n";
const path = resolve(here, "../test/webhook-policy-port.json");
if (process.argv.includes("--check")) {
  if (await readFile(path, "utf8") !== text) throw new Error("webhook test inventory drifted");
} else await writeFile(path, text);
console.log(`Webhook policy assertions: ${inventory.filter(t => t.included).length} included; ${inventory.filter(t => !t.included).length} ECS fixture exclusions`);
