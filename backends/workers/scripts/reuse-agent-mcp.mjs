import { readFile, writeFile } from 'node:fs/promises';
const source = await readFile(new URL('../../../src/agent-mcp.ts', import.meta.url), 'utf8');
const first = source.indexOf('/** An input as GET'), end = source.indexOf('export function agentMcp('), helpers = source.indexOf("/** The tool's description:");
if ([first, end, helpers].some(index => index < 0)) throw new Error('Agent MCP extraction boundary changed');
let content = source.slice(first, end) + source.slice(helpers);
content = content.replace('interface Call {', 'export interface Call {\n  fetch: typeof fetch;')
  .replace('type Extra =', 'export type Extra =')
  .replace(/^const sha = .*;\n/m, '')
  .replaceAll('network().fetch(', 'call.fetch(')
  .replaceAll('resumeId(current)', 'await resumeId(current)')
  .replace('function describe(', 'export function describe(')
  .replace('async function converse(', 'export async function converse(')
  .replace('async function settle(', 'export async function settle(')
  .replace('(await response.json().catch(() => ({}))).error', '(await response.json().catch(() => ({})) as { error?: string }).error');
const output = "// Generated from src/agent-mcp.ts by scripts/reuse-agent-mcp.mjs. Only host dependencies change.\nimport type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';\nimport { Api, ApiError, summarize, type RunSummary } from './agent-mcp-api.ts';\nimport { digest } from './api-contract.ts';\nconst resumeId = async (id: string) => 'resume_' + (await digest(id)).slice(0, 40);\n\n" + content;
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
