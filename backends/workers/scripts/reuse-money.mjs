import { readFile, writeFile } from 'node:fs/promises';
import ts from '../node_modules/typescript/lib/typescript.js';
const root = new URL('../../../', import.meta.url);
const out = new URL('../src/', import.meta.url);
const modules = ['credit-holds', 'workspaces', 'model-attempts', 'model-attempt', 'model-attempt-stream', 'platform-pricing', 'webhooks', 'money-tokens'];
for (const name of modules) {
  const source = name === 'money-tokens' ? 'pi-harness/tokens' : name;
  let text = await readFile(new URL(`src/${source}.ts`, root), 'utf8');
  // src/pi-catalog.ts is model-catalog.ts on Workers (scripts/reuse-model-policy.mjs): one copy, never a second.
  text = text.replaceAll('"../shared/usage-details.ts"', '"../../../shared/usage-details.ts"')
    .replaceAll('"./pi-catalog.ts"', '"./model-catalog.ts"')
    .replaceAll('"./db.ts"', '"./postgres.ts"')
    .replaceAll('"./http.ts"', '"./errors.ts"')
    .replaceAll('"./node-context.ts"', '"./money-host.ts"')
    .replaceAll('"./limit-hits.ts"', '"./money-host.ts"')
    .replaceAll('"./metrics.ts"', '"./money-host.ts"')
    .replaceAll('"./protocol.ts"', '"./money-host.ts"')
    .replaceAll('"./outbound.ts"', '"./money-host.ts"')
    .replaceAll('"./client-sessions/state.ts"', '"./money-host.ts"')
    .replaceAll('"./webhooks.ts"', '"./webhook-policy.ts"')
    .replaceAll('"@earendil-works/pi-agent-core"', '"./money-host.ts"');
  text = '// Generated from src/' + source + '.ts; infrastructure imports only.\n' + text;
  const target = new URL(`${name === 'webhooks' ? 'webhook-policy' : name}.ts`, out);
  if (process.argv.includes('--check')) {
    if (await readFile(target, 'utf8') !== text) throw new Error(`${name} differs from src/`);
  } else await writeFile(target, text);
}
// Keep the provider usage observer and the request estimate unchanged without
// bringing ECS's model-host, AWS SDK or process-level networking into Workers.
const compaction = ts.createSourceFile('compaction.ts', await readFile(new URL('src/compaction.ts', root), 'utf8'), ts.ScriptTarget.Latest, true);
const callFetch = compaction.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'callFetch');
if (!callFetch) throw new Error('Missing source callFetch');
const fetchApis = compaction.statements.find(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => declaration.name.getText(compaction) === 'FETCH_APIS'));
if (!fetchApis) throw new Error('Missing source FETCH_APIS');
const stream = compaction.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'explicitKeyStream');
const source = stream?.getText(compaction);
const first = source?.indexOf('    const input = () =>');
const last = source?.indexOf("\n    // A provider's stream that goes quiet", first);
if (first === undefined || first < 0 || last === undefined || last < 0) throw new Error('Missing source request estimate');
const extracted = [
  ['model-call-fetch', 'import type { UsageSink } from "./model-attempt-stream.ts";\nimport { network } from "./account-network.ts";\n' + fetchApis.getText(compaction) + '\n' + callFetch.getText(compaction)],
  ['model-estimate', 'import type { Api, Model, TranscriptContext } from "@earendil-works/pi-ai";\nimport { estimateTokens } from "./money-tokens.ts";\nexport function estimateModelAttempt(model: Model<Api>, context: TranscriptContext, options: { maxTokens?: number }) {\n' + source.slice(first, last) + '\n    return estimate;\n}'],
];
for (const [name, body] of extracted) {
  const text = '// Generated from src/compaction.ts; source function/body unchanged.\n' + body + '\n';
  const target = new URL(`${name}.ts`, out);
  if (process.argv.includes('--check')) {
    if (await readFile(target, 'utf8') !== text) throw new Error(`${name} differs from src/`);
  } else await writeFile(target, text);
}
const protocol = ts.createSourceFile('protocol.ts', await readFile(new URL('src/protocol.ts', root), 'utf8'), ts.ScriptTarget.Latest, true);
const persistenceFailed = protocol.statements.find(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => declaration.name.getText(protocol) === 'PERSISTENCE_FAILED'));
if (!persistenceFailed || !(await readFile(new URL('money-host.ts', out), 'utf8')).includes(persistenceFailed.getText(protocol))) throw new Error('money-host PERSISTENCE_FAILED differs from src/');
console.log('Money policy modules match src/');
await import('./reuse-money-metrics.mjs');
