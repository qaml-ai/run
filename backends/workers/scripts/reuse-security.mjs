import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const source = name => readFile(resolve(here, "../../../src", name), "utf8");
const outputs = new Map();
const generated = (from, text) => `// Generated from src/${from}; only host imports are replaced.\n// Run node backends/workers/scripts/reuse-security.mjs --check to check source drift.\n${text}`;
for (const name of ["accounts.ts", "tenants.ts", "key-scopes.ts", "model-providers.ts", "browser-tokens.ts", "key-check.ts"]) {
  let text = await source(name);
  text = text.replaceAll('"./db.ts"', '"./postgres.ts"').replaceAll('"./http.ts"', '"./errors.ts"');
  if (name === "accounts.ts") text = text
    .replace('"./anthropic-federation.ts"', '"./security-host.ts"')
    .replace('"./client-sessions/state.ts"', '"./money-host.ts"')
    .replace('"./azure-openai.ts"', '"./security-host.ts"')
    .replace('"./pricing.ts"', '"../../../src/pricing.ts"')
    .replace('"./webhooks.ts"', '"./webhook-policy.ts"');
  if (name === "tenants.ts") text = text
    .replace('"node:fs"', '"./security-host.ts"')
    .replace('"./secrets.ts"', '"./security-host.ts"')
    .replace('"./session-config.ts"', '"./security-types.ts"')
    .replace('"./limits.ts"', '"../../../src/limits.ts"');
  if (name === "key-scopes.ts") text = text
    .replace('"./catalog.ts"', '"./key-catalog.ts"')
    .replace('"./compaction.ts"', '"./security-types.ts"')
    .replace('"./outbound.ts"', '"./security-outbound.ts"');
  if (name === "model-providers.ts") text = text
    .replace('"./catalog.ts"', '"./key-catalog.ts"')
    .replace('"./web-search.ts"', '"./key-catalog.ts"')
    .replace('"./session-config.ts"', '"./security-types.ts"')
    .replace('"./outbound.ts"', '"./security-outbound.ts"');
  if (name === "browser-tokens.ts") text = text.replace('"../shared/client-protocol.ts"', '"../../../shared/client-protocol.ts"');
  outputs.set(name, generated(name, text));
}
const config = await source("session-config.ts");
outputs.set("security-types.ts", generated("session-config.ts + compaction.ts", [
  config.slice(config.indexOf("export type EndpointModel"), config.indexOf("const lookup")),
  config.slice(config.indexOf("export type CustomModel"), config.indexOf("/** What a model replies at most")),
  (await source("compaction.ts")).match(/export const FETCH_APIS = .*?;/)[0],
].join("\n")));
const catalog = await source("catalog.ts");
outputs.set("key-catalog.ts", generated("catalog.ts + web-search.ts", [
  'import { getProviders } from "@earendil-works/pi-ai/compat";',
  'import type { Api, Model } from "@earendil-works/pi-ai";',
  'import { getModels } from "./pi-catalog.ts";',
  'import { deepseekOnOpenRouter } from "./security-deepseek.ts";',
  (await source("web-search.ts")).match(/export const SEARCH_PROVIDERS = .*?;/)[0],
  catalog.slice(catalog.indexOf("/** Page renderers"), catalog.indexOf("export interface ModelInfo")),
  catalog.slice(catalog.indexOf("const models ="), catalog.indexOf("export const modelInfo")),
].join("\n").trimEnd() + "\n"));
outputs.set("security-deepseek.ts", generated("deepseek-replay.ts", await source("deepseek-replay.ts")));
const outbound = await source("outbound.ts");
outputs.set("security-addresses.ts", generated("outbound.ts", [
  'import { isIP } from "node:net";',
  "type Cidr = { bytes: Uint8Array; prefix: number };",
  outbound.slice(outbound.indexOf("const BLOCKED_V4"), outbound.indexOf("export class Outbound {")),
  "export { BUILT_IN, cidr, within, embedded };",
].join("\n")));
const ts = (await import("../node_modules/typescript/lib/typescript.js")).default;
const declarations = async (name, names) => {
  const text = await source(name);
  const file = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  return file.statements.filter(statement =>
    ts.isFunctionDeclaration(statement) && names.includes(statement.name?.text) ||
    ts.isClassDeclaration(statement) && names.includes(statement.name?.text) ||
    ts.isTypeAliasDeclaration(statement) && names.includes(statement.name.text) ||
    ts.isVariableStatement(statement) && statement.declarationList.declarations.some(declaration => names.includes(declaration.name.getText(file)))
  ).map(statement => statement.getText(file)).join("\n\n");
};
const outboundFile = ts.createSourceFile("outbound.ts", outbound, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const outboundClass = outboundFile.statements.find(statement => ts.isClassDeclaration(statement) && statement.name.text === "Outbound");
const fetchMethod = outboundClass.members.find(member => ts.isMethodDeclaration(member) && member.name.getText(outboundFile) === "fetch").getText(outboundFile)
  .replace("async fetch(", 'export async function guardedFetch(this: Pick<Outbound, "check" | "reachable">, ')
  .replace("let response: UndiciResponse;", "let response: Response;")
  .replace('network().guardedFetch(url, { ...request, method, headers, body, redirect: "manual", signal: aborted, dispatcher: this.permits(url) ? this.originDispatcher : this.dispatcher } as unknown as UndiciRequestInit)',
    'fetch(await this.reachable(url), { ...request, method, headers, body, redirect: "manual", signal: aborted })');
outputs.set("security-fetch-policy.ts", generated("outbound.ts", [
  'import type { Outbound } from "./security-outbound.ts";',
  await declarations("outbound.ts", ["OutboundBlocked"]),
  fetchMethod,
  await declarations("outbound.ts", ["capped"]),
].join("\n\n")).replace("only host imports are replaced", "native fetch replaces the Node dispatcher"));
outputs.set("security-policy.ts", generated("identity.ts + end-user-credits.ts + client-sessions/spend.ts", [
  'import { HttpError } from "./errors.ts";',
  await declarations("identity.ts", ["AgentIdentity", "identityInput", "actorInput"]),
  await declarations("end-user-credits.ts", ["BUCKET_NAME", "bucketInput"]),
  await declarations("client-sessions/spend.ts", ["spendInput"]),
].join("\n\n")));
outputs.set("admission-errors.ts", generated("http.ts", [
  'import { databaseRetryable } from "./postgres.ts";',
  await declarations("http.ts", ["errorFields", "errorHeaders"]),
].join("\n\n")));
outputs.set("postgres-policy.ts", generated("db.ts", [
  'import type { Db, Sql } from "./postgres.ts";',
  'import { clock } from "./money-host.ts";',
  '// Host diagnostics and jitter; the transaction and error policy below are from src/.',
  'const random = () => ({ float: Math.random });',
  'const sometimes = (_condition: boolean, _message: string) => {};',
  await declarations("db.ts", ["AUTH_FAILED", "UNAVAILABLE_CODES", "UNAVAILABLE_MESSAGES", "databaseRetryable", "RERUN_CODES", "RETRYABLE_CODES", "TRANSACTION_ATTEMPTS", "databaseUnavailable", "transaction", "transactionOnce"]),
].join("\n\n").replace("    client.release(broken);", "    // Workers close the per-operation socket before releasing the request.\n    if (client.close) await client.close();\n    else client.release(broken);")).replace("only host imports are replaced", "host imports and connection release are adapted"));
const schemas = ts.createSourceFile("schemas.ts", await source("api-schemas.ts"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const names = new Set(["SEND_KEY", "KeyInput", "TenantInput", "TenantLimitsInput"]);
const statements = schemas.statements.filter(s => ts.isVariableStatement(s) && s.declarationList.declarations.some(d => names.has(d.name.getText(schemas))));
const transformed = ts.transform(ts.factory.updateSourceFile(schemas, statements), [context => root => ts.visitNode(root, function visit(node) {
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "openapi") return ts.visitNode(node.expression.expression, visit);
  return ts.visitEachChild(node, visit, context);
})]);
outputs.set("security-inputs.ts", '// Generated request schemas from src/api-schemas.ts; only OpenAPI annotations removed.\nimport { z } from "zod";\n' + ts.createPrinter({ removeComments: true }).printFile(transformed.transformed[0]));
transformed.dispose();
for (const [name, text] of outputs) {
  const path = resolve(here, "../src", name);
  if (process.argv.includes("--check")) {
    if (await readFile(path, "utf8") !== text) throw new Error(`${name} differs from src/`);
  } else await writeFile(path, text);
}
console.log("Accounts, tenants, scopes, providers, browser tokens and encryption match src/");
