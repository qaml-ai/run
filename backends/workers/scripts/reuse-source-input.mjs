import { readFile, writeFile } from 'node:fs/promises';
const source = await readFile(new URL('../../../src/tool-sources.ts', import.meta.url), 'utf8');
const start = source.indexOf('const sameOrigin ='), end = source.indexOf('/** What callers see of a server:', start);
const nameStart = source.indexOf('const mcpToolName ='), nameEnd = source.indexOf('\n', nameStart);
if (start < 0 || end < 0 || nameStart < 0) throw new Error('Source input policy extraction boundary changed');
const text = '// Generated from src/tool-sources.ts by scripts/reuse-source-input.mjs.\n' + source.slice(start, end).replaceAll('const ', 'export const ') + source.slice(nameStart, nameEnd).replace('const ', 'export const ') + '\n';
const target = new URL('../src/source-input-policy.ts', import.meta.url);
if (process.argv.includes('--check')) { if (await readFile(target, 'utf8') !== text) throw new Error('Source input policy drifted'); }
else await writeFile(target, text);
