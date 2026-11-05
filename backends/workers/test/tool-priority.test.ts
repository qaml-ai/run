import test from 'node:test';
import assert from 'node:assert/strict';
import { prioritizedTools } from '../src/tool-priority.ts';
test('application then file then builtins then remote tools win duplicate names', () => {
  const entries = [ ['camel.web', 'fetch'], ['camel.sources', 'read'], ['camel.sources', 'custom'], ['camel.files', 'read'], ['camel.application', 'fetch'] ].map(([name, tool]) => ({ extension: { name }, tool: { name: tool, description: name, parameters: {}, execute: async () => ({ output: [] }) } }));
  assert.deepEqual(prioritizedTools(entries).map(tool => [tool.name, tool.description]), [['fetch', 'camel.application'], ['read', 'camel.files'], ['custom', 'camel.sources']]);
});
