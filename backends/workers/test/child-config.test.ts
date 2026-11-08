import assert from 'node:assert/strict';
import test from 'node:test';
import { childConfig } from '../src/child-config.ts';
import { SUBAGENT_PROMPT } from '../src/multi-agent-policy.ts';

test('inline children share parent files, web builtins and end-user scope', () => {
  const config = childConfig({ model: 'custom/model', systemPrompt: 'Parent secret instructions', builtins: ['agents', 'delegate', 'web_search', 'web_fetch', 'generate_image'],
    mcp: { tools: [{ name: 'private' }] }, delegate: { instructions: true }, spendLimit: { usd: 20 }, subject: 'user', context: { project: 'p' }, keyScope: 'scope', bucket: 'default',
    mounts: [{ volumeId: 'private-parent', path: '/workspace', mode: 'rw', notify: true }, { volumeId: 'shared', path: '/data', subpath: 'safe', mode: 'ro' }] }, undefined, { bucket: 'run' });
  assert.deepEqual(config, { model: 'custom/model', systemPrompt: SUBAGENT_PROMPT, builtins: ['web_search', 'web_fetch'],
    mounts: [{ volumeId: 'private-parent', path: '/workspace', mode: 'rw' }, { volumeId: 'shared', path: '/data', mode: 'ro', subpath: 'safe' }, { workspace: false }],
    subject: 'user', context: { project: 'p' }, keyScope: 'scope', bucket: 'run' });
});

test('definition children retain the resolved definition configuration', () => {
  const target = { definition: 'def_example', definitionRevision: 2, systemPrompt: 'Target', builtins: ['ask_user'], model: 'target/model', mounts: [{ workspace: true }] };
  assert.deepEqual(childConfig({ model: 'parent/model', subject: 'end-user' }, target), { ...target, subject: 'end-user' });
});

test('child tool identity stays the owner when the run has another payer', () => {
  assert.equal(childConfig({ subject: 'owner' }, undefined, { endUser: 'guest', bucket: 'bot:7' }).subject, 'owner');
});
