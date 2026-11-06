// Channel request schemas, generated from src/api-schemas.ts with only OpenAPI annotations removed.
// The channel logic itself is not copied: Workers imports src/core/channels directly.
// Run with --check to fail when src/ drifted.
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const text = await readFile(resolve(here, "../../../src/api-schemas.ts"), "utf8");
const schemas = ts.createSourceFile("schemas.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const names = new Set(["ChannelAccess", "ChannelLimits", "ChannelFilter", "channelFields", "ChannelInput", "ChannelUpdate", "ChannelEventsQuery"]);
const statements = schemas.statements.filter(s => ts.isVariableStatement(s) && s.declarationList.declarations.some(d => names.has(d.name.getText(schemas))));
if (statements.length !== names.size) throw new Error("src/api-schemas.ts no longer declares every channel schema");
const transformed = ts.transform(ts.factory.updateSourceFile(schemas, statements), [context => root => ts.visitNode(root, function visit(node) {
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "openapi") return ts.visitNode(node.expression.expression, visit);
  return ts.visitEachChild(node, visit, context);
})]);
const output = "// Generated request schemas from src/api-schemas.ts; only OpenAPI annotations removed.\n// Run node backends/workers/scripts/reuse-channels.mjs --check to check source drift.\nimport { z } from \"zod\";\n" + ts.createPrinter({ removeComments: true }).printFile(transformed.transformed[0]);
transformed.dispose();
const path = resolve(here, "../src/channel-inputs.ts");
if (process.argv.includes("--check")) {
  if (await readFile(path, "utf8") !== output) throw new Error("channel-inputs.ts differs from src/api-schemas.ts; run node backends/workers/scripts/reuse-channels.mjs");
} else await writeFile(path, output);
console.log("Channel request schemas match src/api-schemas.ts");
