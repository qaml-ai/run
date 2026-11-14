import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "../node_modules/typescript/lib/typescript.js";
import { diverge } from "./repo-divergence.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const read = name => readFile(resolve(here, "../../../src", name), "utf8");
const header = name => `// Generated from src/${name}; only infrastructure imports are adapted.\n// Run node backends/workers/scripts/reuse-http.mjs --check to reject source drift.\n`;
const outputs = new Map();
outputs.set("idempotency.ts", header("idempotency.ts") + (await read("idempotency.ts")).replace('"./db.ts"', '"./postgres.ts"').replace('"./http.ts"', '"./errors.ts"'));
outputs.set("runtime-identity.ts", diverge("runtime-identity.ts", header("identity.ts") + (await read("identity.ts")).replace('"./db.ts"', '"./postgres.ts"').replace('"./http.ts"', '"./errors.ts"')));

const api = ts.createSourceFile("api.ts", await read("api.ts"), ts.ScriptTarget.Latest, true);
let options;
function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText(api) === "idempotency") options = node.arguments[0];
  ts.forEachChild(node, visit);
}
visit(api);
if (!options || !ts.isObjectLiteralExpression(options)) throw new Error("Source idempotency route policy missing");
const policy = name => {
  const property = options.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText(api) === name);
  if (!property) throw new Error(`Source idempotency ${name} missing`);
  return property.initializer.getText(api);
};
outputs.set("idempotency-routes.ts", header("api.ts") + `export const skipMoneyIdempotency: (path: string) => boolean = ${policy("skip")};\nexport const secretMoneyIdempotency: (path: string) => boolean = ${policy("secret").replace("|volumes\\/[^/]+\\/links", "")};\n`);

const http = ts.createSourceFile("http.ts", await read("http.ts"), ts.ScriptTarget.Latest, true);
const names = new Set(["errorFields", "errorCode", "errorHeaders", "errorStatus"]);
const statements = http.statements.filter(s => ts.isFunctionDeclaration(s) && names.has(s.name?.text) || ts.isVariableStatement(s) && s.declarationList.declarations.some(d => d.name.getText(http) === "STATUS_CODES"));
if (statements.length !== 5) throw new Error("Source HTTP error policy changed");
outputs.set("http-error-policy.ts", header("http.ts") + 'import { databaseRetryable, databaseUnavailable } from "./postgres-policy.ts";\n\n' + statements.map(s => s.getText(http)).join("\n\n") + "\n");

for (const [name, text] of outputs) {
  const path = resolve(here, "../src", name);
  if (process.argv.includes("--check")) {
    if (await readFile(path, "utf8") !== text) throw new Error(`${name} differs from source`);
  } else await writeFile(path, text);
}
console.log("HTTP idempotency, route patterns and error policy match src/");
