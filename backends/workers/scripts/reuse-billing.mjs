import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const files = ["billing", "billing-payments", "auto-topup", "card-credit", "billing-alerts", "stripe"];
for (const name of files) {
  let source = await readFile(resolve(here, `../../../src/${name}.ts`), "utf8");
  source = source.replaceAll('"./db.ts"', '"./postgres.ts"').replaceAll('"./http.ts"', '"./errors.ts"');
  source = source.replaceAll('"./pricing.ts"', '"../../../src/pricing.ts"').replaceAll('"./limits.ts"', '"../../../src/limits.ts"');
  source = source.replaceAll('"./tenants.ts"', '"./billing-host.ts"').replaceAll('"./busy-agents.ts"', '"./billing-host.ts"').replaceAll('"./metrics.ts"', '"./billing-host.ts"');
  source = source.replaceAll('"./journey.ts"', '"./billing-host.ts"').replaceAll('"../shared/storage.ts"', '"./billing-host.ts"').replaceAll('"./storage-usage.ts"', '"./billing-host.ts"');
  source = source.replaceAll('import { network } from "./node-context.ts";', 'import { network } from "./account-network.ts";');
  source = source.replaceAll('"./core/no-redirect.ts"', '"../../../src/core/no-redirect.ts"');
  source = source.replaceAll('import type { Accounts } from "./accounts.ts";', 'import type { Accounts } from "./billing-host.ts";');
  const output = `// Generated from src/${name}.ts; only host imports/types are adapted.\n// Regenerate with scripts/reuse-billing.mjs; --check rejects policy drift.\n${source}`;
  const path = resolve(here, `../src/${name}.ts`);
  if (process.argv.includes("--check")) {
    if (await readFile(path, "utf8") !== output) throw new Error(`${name}.ts differs from src; regenerate`);
  } else await writeFile(path, output);
}
console.log("Workers billing policy matches src/");
// Public request validation is reused too; OpenAPI annotations do not run on Workers.
const ts = (await import("../node_modules/typescript/lib/typescript.js")).default;
const schemaNames = new Set(["BillingAlertChoices", "BillingRecipientInput", "BillingAlertThreshold", "BillingConfirmationInput", "AdjustmentInput", "StartingCreditGrantInput", "BillingPortalInput", "CheckoutInput", "CardCheckConfirmInput", "AutoTopupTerms", "AutoTopupConsent", "AutoTopupRetry"]);
const schemaSource = ts.createSourceFile("schemas.ts", await readFile(resolve(here, "../../../src/api-schemas.ts"), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const statements = schemaSource.statements.filter(s => ts.isVariableStatement(s) && s.declarationList.declarations.some(d => schemaNames.has(d.name.getText(schemaSource))));
const transform = context => root => ts.visitNode(root, function visit(node) {
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "openapi") return ts.visitNode(node.expression.expression, visit);
  return ts.visitEachChild(node, visit, context);
});
const transformed = ts.transform(ts.factory.updateSourceFile(schemaSource, statements), [transform]);
const schemaOutput = '// Generated request schemas from src/api-schemas.ts; only OpenAPI annotations removed.\nimport { z } from "zod";\n' + ts.createPrinter({ removeComments: true }).printFile(transformed.transformed[0]);
transformed.dispose();
const schemaPath = resolve(here, "../src/billing-inputs.ts");
if (process.argv.includes("--check")) {
  if (await readFile(schemaPath, "utf8") !== schemaOutput) throw new Error("billing-inputs.ts differs from src; regenerate");
} else await writeFile(schemaPath, schemaOutput);
