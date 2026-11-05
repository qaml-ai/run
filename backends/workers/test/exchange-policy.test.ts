import test from 'node:test';
import assert from 'node:assert/strict';
import { describe, reasonGiven } from '../src/exchange-policy.ts';
test('exchange errors identify the endpoint without its query or response credentials', () => {
  assert.equal(describe('https://service.test/exchange?key=hidden'), 'https://service.test/exchange');
  assert.equal(reasonGiven(JSON.stringify({ error: 'unknown\ndefinition', token: 'must-not-appear' })), ': unknown definition');
  assert.equal(reasonGiven(JSON.stringify({ token: 'must-not-appear' })), '');
});
