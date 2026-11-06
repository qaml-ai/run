import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "../node_modules/typescript/lib/typescript.js";
const here = dirname(fileURLToPath(import.meta.url));
const source = await readFile(resolve(here, "../../../tests/billing.test.ts"), "utf8");
const ast = ts.createSourceFile("billing.ts", source, ts.ScriptTarget.Latest, true);
const boundary = source.indexOf('test("a self-serve tenant');
if (boundary < 0) throw new Error("Missing core billing selection boundary");
const signatureTest = "Stripe webhooks are verified by signature: a bad or stale signature is refused, and a well-signed replay is harmless";
const isSignatureTest = statement => ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression)
  && statement.expression.expression.getText(ast) === "test" && ts.isStringLiteral(statement.expression.arguments[0])
  && statement.expression.arguments[0].text === signatureTest;
const inventory = [];
for (const statement of ast.statements) {
  if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression) || statement.expression.expression.getText(ast) !== "test") continue;
  const title = statement.expression.arguments[0];
  if (!ts.isStringLiteral(title)) throw new Error("Nonliteral core billing test title");
  const included = statement.getStart(ast) < boundary || isSignatureTest(statement);
  const text = statement.getText(ast);
  const reason = included ? undefined
    : /\bruntime\(/.test(text) ? "Uses the ECS HTTP/runtime fixture; not ported as an unchanged Workers test."
    : /migrate: false/.test(text) ? "Uses a staged legacy-migration fixture; the Workers test database applies all migrations."
    : /\bpostgresTail\(/.test(text) ? "Uses source storage and Postgres log-tail fixtures; the Workers R2 storage-meter integration is not ported."
    : "Outside the selected source service tests; requires a fixture that has not been adapted to Workers.";
  inventory.push({ file: "tests/billing.test.ts", test: title.text, included, ...(reason ? { reason } : {}) });
}
const parts = [];
for (const statement of ast.statements) {
  const sharedSecret = ts.isVariableStatement(statement) && statement.declarationList.declarations.some(declaration => declaration.name.getText(ast) === "WEBHOOK_SECRET");
  if (statement.getStart(ast) >= boundary && !isSignatureTest(statement) && !sharedSecret) continue;
  let text = statement.getText(ast);
  if (ts.isImportDeclaration(statement)) {
    const path = statement.moduleSpecifier.text;
    if (["node:fs", "node:os", "node:path", "node:url", "../src/log-tail.ts"].includes(path)) continue;
    if (path === "../shared/storage.ts") text = 'import type { Storage } from "../src/billing-host.ts";';
    if (path === "../src/db.ts") text = 'import { type Db } from "../src/postgres.ts";';
    if (path === "../src/pricing.ts") text = text.replace(path, "../../../src/pricing.ts");
    if (path === "../src/webhooks.ts") text = text.replace(path, "../src/webhook-policy.ts");
    if (path === "./database.ts") text = 'import { testDatabase } from "./billing-database.ts";';
    if (path === "./runtime-server.ts") text = 'import { until } from "./billing-listen.ts";';
  }
  parts.push(text);
}
const output = '// Ported from the first 12 service tests and standalone Stripe signature test in tests/billing.test.ts; assertions and bodies unchanged.\n' + parts.join("\n\n") + "\n";
const path = resolve(here, "../test/billing-core.test.ts");
if (process.argv.includes("--check")) {
  if (await readFile(path, "utf8") !== output) throw new Error("Billing core tests drifted");
} else await writeFile(path, output);
const manifest = JSON.stringify(inventory, null, 2) + "\n";
const manifestPath = resolve(here, "../test/billing-core-policy-port.json");
if (process.argv.includes("--check")) {
  if (await readFile(manifestPath, "utf8") !== manifest) throw new Error("Core billing test inventory drifted");
} else await writeFile(manifestPath, manifest);
console.log(`Core billing tests match src: ${inventory.filter(test => test.included).length} included; ${inventory.filter(test => !test.included).length} excluded`);
