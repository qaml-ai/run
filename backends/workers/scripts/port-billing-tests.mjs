import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "../node_modules/typescript/lib/typescript.js";
const here = dirname(fileURLToPath(import.meta.url));
const excluded = new Map([
  ["billing REST routes bind portal ownership to authentication and reject caller-supplied redirects", "Uses the ECS HTTP runtime fixture; not ported as an unchanged Workers test."],
  ["the mail worker sends payment receipts and drops a resolved no-card warning", "Uses the source process mail worker; Workers uses a bounded scheduled Email Sending pump."],
  ["auto top-up REST requires the exact quote version and explicit consent", "Uses the ECS HTTP runtime fixture; not ported as an unchanged Workers test."],
  ["registered billing webhooks are delivered by the existing worker with valid signatures", "Uses the ECS HTTP runtime and process webhook worker fixtures; not ported as an unchanged Workers test."],
]);
const inventory = [];
for (const name of ["billing-refunds", "billing-disputes", "billing-payments", "auto-topup", "billing-alerts"]) {
  const source = await readFile(resolve(here, `../../../tests/${name}.test.ts`), "utf8");
  const ast = ts.createSourceFile(`${name}.ts`, source, ts.ScriptTarget.Latest, true);
  const parts = [];
  for (const statement of ast.statements) {
    if (ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression) && statement.expression.expression.getText(ast) === "test") {
      const title = statement.expression.arguments[0];
      if (!ts.isStringLiteral(title)) throw new Error(`Nonliteral test title in ${name}`);
      const reason = excluded.get(title.text);
      inventory.push({ file: `tests/${name}.test.ts`, test: title.text, included: !reason, ...(reason ? { reason } : {}) });
      if (reason) continue;
    }
    let text = statement.getText(ast);
    if (ts.isImportDeclaration(statement)) {
      const path = statement.moduleSpecifier.text;
      if (name !== "billing-alerts" && ["../src/accounts.ts", "../src/billing-alerts.ts", "../src/billing-mailer.ts"].includes(path)) continue;
      if (path === "./runtime-server.ts") text = 'import { listen } from "./billing-listen.ts";';
      if (path === "../src/db.ts") text = text.replace(path, "../src/postgres.ts");
      if (path === "../src/webhooks.ts") text = text.replace(path, "../src/webhook-policy.ts");
      if (path === "./database.ts") text = 'import { testDatabase } from "./billing-database.ts";';
      if (path === "../src/pricing.ts" || path === "../src/billing-emails.ts") text = text.replace(path, `../../../src/${path.split("/").at(-1)}`);
    }
    parts.push(text);
  }
  const output = `// Ported from tests/${name}.test.ts. Assertions and test bodies unchanged.\n// ECS HTTP and mail worker cases are exercised by Workers integration tests instead.\n${parts.join("\n\n")}\n`;
  const path = resolve(here, `../test/${name}.test.ts`);
  if (process.argv.includes("--check")) {
    if (await readFile(path, "utf8") !== output) throw new Error(`${name} port drifted`);
  } else await writeFile(path, output);
}
const manifest = JSON.stringify(inventory, null, 2) + "\n";
const manifestPath = resolve(here, "../test/billing-policy-port.json");
if (process.argv.includes("--check")) {
  if (await readFile(manifestPath, "utf8") !== manifest) throw new Error("Billing test inventory drifted");
} else await writeFile(manifestPath, manifest);
console.log(`Billing test bodies match src tests: ${inventory.filter(test => test.included).length} included; ${inventory.filter(test => !test.included).length} excluded`);
