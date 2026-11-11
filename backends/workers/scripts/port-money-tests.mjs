import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "../node_modules/typescript/lib/typescript.js";
const here = dirname(fileURLToPath(import.meta.url));
const names = ["shared-allowances", "credit-holds", "end-user-holds", "end-user-lots", "end-user-credits", "end-user-written-off", "end-user-settings-concurrency", "end-user-balance-events", "end-user-history", "end-user-usage", "model-attempts", "oauth-clients"];
const inventory = [];
for (const name of names) {
  const source = await readFile(resolve(here, `../../../tests/${name}.test.ts`), "utf8");
  const ast = ts.createSourceFile(`${name}.ts`, source, ts.ScriptTarget.Latest, true);
  const parts = [];
  for (const statement of ast.statements) {
    let text = statement.getText(ast);
    if (ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression) && statement.expression.expression.getText(ast) === "test") {
      const title = statement.expression.arguments[0];
      const label = ts.isStringLiteral(title) ? title.text : "unknown";
      const reason = /\bruntime\(/.test(text) ? "ECS HTTP fixture" : name === "model-attempts" && /\bfixture\(/.test(text) ? "ECS client-session fixture" : /import\("\.\.\/src\/compaction\.ts"\)/.test(text) ? "ECS model stream seam" : undefined;
      inventory.push({ file: `tests/${name}.test.ts`, test: label, included: !reason, ...(reason ? { reason } : {}) });
      if (reason) continue;
    }
    if (ts.isImportDeclaration(statement)) {
      const path = statement.moduleSpecifier.text;
      if (["./runtime-server.ts", "./client-fixture.ts", "../clients/node.ts"].includes(path)) continue;
      if (path === "./database.ts") text = 'import { testDatabase } from "./billing-database.ts";';
      if (path === "../src/db.ts") text = text.replace(path, "../src/postgres.ts");
      if (path === "../src/pi-catalog.ts") text = text.replace(path, "../src/model-catalog.ts");
      if (path === "../src/pricing.ts") text = text.replace(path, "../../../src/pricing.ts");
      if (path === "../src/oauth.ts") text = text.replace(path, "../src/account-oauth.ts");
      if (path === "../src/origins.ts") text = text.replace(path, "../src/account-origins.ts");
    }
    parts.push(text);
  }
  const output = `// Ported from tests/${name}.test.ts. Included assertions and test bodies are unchanged.\n// Only service imports and the isolated Postgres fixture differ; see money-policy-port.json for excluded ECS fixtures.\n${parts.join("\n\n")}\n`;
  const path = resolve(here, `../test/${name}.test.ts`);
  if (process.argv.includes("--check")) {
    if (await readFile(path, "utf8") !== output) throw new Error(`${name} port drifted`);
  } else await writeFile(path, output);
}
const inventoryText = JSON.stringify(inventory, null, 2) + "\n";
const path = resolve(here, "../test/money-policy-port.json");
if (process.argv.includes("--check")) {
  if (await readFile(path, "utf8") !== inventoryText) throw new Error("money policy test inventory drifted");
} else await writeFile(path, inventoryText);
console.log(`Money policy assertions: ${inventory.filter(t => t.included).length} included; ${inventory.filter(t => !t.included).length} ECS fixture exclusions`);
