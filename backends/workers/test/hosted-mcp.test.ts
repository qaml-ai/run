import assert from 'node:assert/strict';
import test from 'node:test';
import { tools } from '../src/hosted-mcp-tools.ts';
import { parseManifests } from '../src/hosted-mcp-manifest.ts';
import { serveHostedMcp } from '../src/hosted-mcp.ts';

test('hosted MCP reuses CLI tools without access to host files or environment', async () => {
  const list = tools(() => ({ me: async () => ({ tenant: 'alice' }), url: 'https://runtime.example' }) as any);
  assert.equal((await list.find(tool => tool.name === 'whoami')!.run({}) as any).tenant, 'alice');
  assert.deepEqual(Object.keys(list.find(tool => tool.name === 'deploy')!.input).sort(), ['apply', 'dryRun', 'manifest']);
  assert.throws(() => parseManifests('key: sample\nsystemPromptFile: secret.txt', 'manifest'), /hosted deploy reads no files/);
  await assert.rejects(list.find(tool => tool.name === 'deploy')!.run({ manifest: 'key: sample\nsystemPrompt: ${HOSTED_SECRET}' }), /reads no environment variables/);
  for (const tool of list) for (const key of ['readOnlyHint', 'destructiveHint', 'openWorldHint'] as const) assert.equal(typeof tool.annotations[key], 'boolean');
});

test('hosted MCP bounds request bodies before reading a declared oversized body', async () => {
  const request = new Request('https://runtime.example/mcp', { method: 'POST', headers: { 'Content-Length': String(9 * 1024 * 1024) }, body: '{' });
  const response = await serveHostedMcp(request, { publicOrigin: 'https://runtime.example', fetch: async () => { throw new Error('Must not dispatch'); } });
  assert.equal(response.status, 413);
});
