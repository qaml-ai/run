import { readFile, writeFile } from 'node:fs/promises';
const source = await readFile(new URL('../../../src/agent-mcp.ts', import.meta.url), 'utf8');
const first = source.indexOf('/** An input as GET'), end = source.indexOf('export function agentMcp('), helpers = source.indexOf("/** The tool's description:");
if ([first, end, helpers].some(index => index < 0)) throw new Error('Agent MCP extraction boundary changed');
let content = source.slice(first, end) + source.slice(helpers);
const followStart = content.indexOf('/**\n * Read the agent\'s event stream'), followEnd = content.indexOf('/** What a call waits on');
if (followStart < 0 || followEnd < followStart) throw new Error('Agent MCP event follower boundary changed');
// MCP's public Streamable HTTP stays unchanged. Only its host-internal watcher
// differs: Workers' agent streams are hibernatable WebSockets, never SSE.
content = content.slice(0, followStart) + content.slice(followEnd);
content = content.replace('interface Call {', 'export interface Call {\n  fetch: typeof fetch;')
  .replace('type Extra =', 'export type Extra =')
  .replace(/^const sha = .*;\n/m, '')
  .replaceAll('network().fetch(', 'call.fetch(')
  .replaceAll('resumeId(current)', 'await resumeId(current)')
  .replace('function describe(', 'export function describe(')
  .replace('async function converse(', 'export async function converse(')
  .replace('async function settle(', 'export async function settle(')
  .replace('(await response.json().catch(() => ({}))).error', '(await response.json().catch(() => ({})) as { error?: string }).error');
const output = "// Generated from src/agent-mcp.ts by scripts/reuse-agent-mcp.mjs. Only host dependencies change.\nimport type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';\nimport { Api, ApiError, summarize, type RunSummary } from './agent-mcp-api.ts';\nimport { digest } from './api-contract.ts';\nimport { followEvents as follow } from './event-follow.ts';\nconst resumeId = async (id: string) => 'resume_' + (await digest(id)).slice(0, 40);\n\n" + content;
const path = new URL('../src/agent-mcp-core.ts', import.meta.url);
if (process.argv.includes('--check')) { if (await readFile(path, 'utf8') !== output) throw new Error('Agent MCP source drifted'); }
else await writeFile(path, output);

const api = await readFile(new URL('../../../packages/cli/src/api.ts', import.meta.url), 'utf8');
const ops = await readFile(new URL('../../../packages/cli/src/ops.ts', import.meta.url), 'utf8');
const version = JSON.parse(await readFile(new URL('../../../packages/cli/package.json', import.meta.url), 'utf8')).version;
const apiText = 'export const VERSION = ' + JSON.stringify(version) + ';\n' + '// Generated from packages/cli/src/{api,ops}.ts by scripts/reuse-agent-mcp.mjs.\n' + api.replaceAll('globalThis.crypto', 'crypto') + ops.slice(ops.indexOf('export interface RunSummary'), ops.indexOf('/** Wait up to'));
const apiPath = new URL('../src/agent-mcp-api.ts', import.meta.url);
if (process.argv.includes('--check')) { if (await readFile(apiPath, 'utf8') !== apiText) throw new Error('Agent MCP REST adapter drifted'); }
else await writeFile(apiPath, apiText);

// The hosted server uses the CLI's full REST operations and manifest parser. Only
// the stdio/local-files wrapper is omitted; these modules read no host resources.
const generated = async (name, text) => {
  const path = new URL('../src/' + name, import.meta.url);
  if (process.argv.includes('--check')) { if (await readFile(path, 'utf8') !== text) throw new Error(name + ' source drifted'); }
  else await writeFile(path, text);
};
const header = '// Generated from packages/cli/src/ by scripts/reuse-agent-mcp.mjs. Host dependencies only.\n';
await generated('hosted-mcp-ops.ts', header + ops.replaceAll('"./api.ts"', '"./agent-mcp-api.ts"').replaceAll('"./manifest.ts"', '"./hosted-mcp-manifest.ts"').replaceAll('globalThis.crypto', 'crypto')
  // Workers' create response names an idempotently reused agent existingAgent.
  .replaceAll('agent.reconfigured ?', 'agent.reconfigured || agent.existingAgent ?')
  .replaceAll('created.reconfigured ?', 'created.reconfigured || created.existingAgent ?'));
await generated('hosted-mcp-manifest.ts', header + await readFile(new URL('../../../packages/cli/src/manifest.ts', import.meta.url), 'utf8'));
const cliTools = await readFile(new URL('../../../packages/cli/src/tools.ts', import.meta.url), 'utf8');
await generated('hosted-mcp-tools.ts', header + cliTools.replaceAll('"./api.ts"', '"./agent-mcp-api.ts"').replaceAll('"./manifest.ts"', '"./hosted-mcp-manifest.ts"').replaceAll('"./ops.ts"', '"./hosted-mcp-ops.ts"'));
const cliServer = await readFile(new URL('../../../packages/cli/src/mcp.ts', import.meta.url), 'utf8');
const capStart = cliServer.indexOf('/** A result\'s most'), capEnd = cliServer.indexOf('/** Serve the CLI');
const serverStart = cliServer.indexOf('export function createServer(');
if ([capStart, capEnd, serverStart].some(index => index < 0)) throw new Error('Hosted MCP extraction boundary changed');
const server = cliServer.slice(serverStart).replace('export function createServer(api: () => Api, options: { cwd?: string } = {}) {\n  const { cwd } = options;', 'export function createServer(api: () => Api) {')
  .replace(/  const local = cwd === undefined[\s\S]*?\n  };\n/, '  const local = undefined;\n');
await generated('hosted-mcp-server.ts', header + 'import { z } from "zod";\nimport { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";\nimport type { Api } from "./agent-mcp-api.ts";\nimport { VERSION } from "./agent-mcp-api.ts";\nimport { errorText, INSTRUCTIONS, resultText, tools } from "./hosted-mcp-tools.ts";\nvoid z;\n\n' + cliServer.slice(capStart, capEnd) + server);
