import assert from 'node:assert/strict';
import test from 'node:test';
import { selectFileTools } from '../src/file-tool-selection.ts';

const names = new Set(['read', 'write', 'ls', 'present_file']);
const files = ['read', 'write', 'ls', 'present_file'].map(name => ({ name }));
const visible = (tools: { name: string }[]) => tools.map(tool => tool.name);

test('fileTools:false hides file operations from the model but keeps them callable by code', () => {
  const tools = [...files, { name: 'exec', callers: ['model'] as const }];
  const selection = selectFileTools(tools, names, { fileTools: false });
  assert.deepEqual(selection.tools, tools);
  assert.deepEqual(visible(selection.modelTools), ['present_file', 'exec']);
  assert.deepEqual(tools[0], { name: 'read' }, 'selecting tools must not mutate the registry');
  assert.deepEqual(selectFileTools(tools, names, {}).modelTools, tools, 'turning file tools back on restores model exposure');
});

test('a tool-using agent without code keeps present_file and drops disabled file operations', () => {
  const selection = selectFileTools([...files, { name: 'web_fetch' }], names, { codeMode: false, fileTools: false });
  assert.deepEqual(visible(selection.tools), ['present_file', 'web_fetch']);
  assert.deepEqual(selection.modelTools, selection.tools);
});

test('an entirely bare agent has no present_file, including explicit decide or internal output tools', () => {
  const internal = [{ name: 'final_output' }, { name: 'decide' }, { name: 'host_execute' }];
  const selection = selectFileTools([...files, ...internal], names, { codeMode: false, fileTools: false });
  assert.deepEqual(selection.tools, internal);
  assert.deepEqual(selectFileTools(files, names, { codeMode: false, fileTools: false }).tools, []);
});

test('non-file tools retain their declared caller policy', () => {
  const lookup = { name: 'lookup', callers: ['tools'] as const };
  const selection = selectFileTools([...files, lookup], names, {});
  assert.ok(selection.tools.includes(lookup));
  assert.ok(!selection.modelTools.includes(lookup));
  assert.deepEqual(visible(selection.modelTools), [...names]);
});
