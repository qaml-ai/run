import test from 'node:test';
import assert from 'node:assert/strict';
import { toolOutputPolicy } from '../src/tool-output-policy.ts';

test('model tool text is capped while the complete value is saved with source instructions', async () => {
  const saved: string[] = [];
  const policy = toolOutputPolicy({}, async (_call, value) => { saved.push(value); return '/workspace/tool-results/1-big.txt'; });
  const content = await policy.capped('big', [{ type: 'text', text: 'x'.repeat(100_000) }]);
  assert.equal(saved[0].length, 100_000);
  assert.ok(content[0].text.length < 33_000);
  assert.match(content[0].text, /cut at 32,000 of 100,000 characters/);
  assert.match(content[0].text, /\/workspace\/tool-results\/1-big.txt: read it in parts with read/);
  const hidden = await toolOutputPolicy({ fileTools: false }, async () => '/workspace/big.txt').capped('big', [{ type: 'text', text: 'x'.repeat(100_000) }]);
  assert.match(hidden[0].text, /with tools.read \(offset and length\) in codemode/);
});

test('large structured details become a complete JSON file reference', async () => {
  const value = { value: 'é'.repeat(9000) };
  let saved: string | undefined;
  const policy = toolOutputPolicy({}, async (_call, text, extension) => { saved = text; assert.equal(extension, 'json'); return '/workspace/tool-results/1-large.json'; });
  assert.deepEqual(await policy.cappedDetails('large', 'lookup', value), { truncated: true, path: '/workspace/tool-results/1-large.json' });
  assert.deepEqual(JSON.parse(saved!), value);
  assert.deepEqual(await policy.cappedDetails('small', 'lookup', { value: 'kept' }), { value: 'kept' });
});
