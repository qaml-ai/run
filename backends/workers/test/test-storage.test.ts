import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { TestStorage } from '../src/test-storage.ts';

test('stored fault keys cannot affect an agent without the test binding', async () => {
  const storage = {
    get() { throw new Error('production must not read fault injection keys'); },
    put() { throw new Error('production must not write fault injection keys'); },
    delete() { throw new Error('production must not delete fault injection keys'); },
  } as unknown as DurableObjectStorage;
  const hooks = new TestStorage(false, storage);
  for (const key of ['test:crash-host-settlement', 'test:host-stop-owner', 'test:crash-settlement', 'test:crash-owner'] as const) {
    assert.equal(await hooks.get(key), undefined);
    await hooks.put(key, true);
    await hooks.delete(key);
  }
});

test('local fault injection remains available when explicitly enabled', async () => {
  const values = new Map<string, unknown>();
  const storage = {
    get: async (key: string) => values.get(key),
    put: async (key: string, value: unknown) => { values.set(key, value); },
    delete: async (key: string) => values.delete(key),
  } as unknown as DurableObjectStorage;
  const hooks = new TestStorage(true, storage);
  await hooks.put('test:crash-host-settlement', true);
  assert.equal(await hooks.get('test:crash-host-settlement'), true);
  await hooks.delete('test:crash-host-settlement');
  assert.equal(await hooks.get('test:crash-host-settlement'), undefined);
});

test('agent fault keys always pass through the binding gate and deployable configs omit it', () => {
  const source = new URL('../src/', import.meta.url);
  const modules = readdirSync(source).filter(name => /^agent(?:-.*)?\.ts$/.test(name));
  for (const name of modules) {
    const agent = readFileSync(new URL(name, source), 'utf8');
    assert.doesNotMatch(agent, /(?:storage|tx)\.(?:get(?:<[^>]+>)?|put|delete)\(\s*["']test:/, name);
  }
  for (const name of ['wrangler.jsonc', 'wrangler.pilot.jsonc']) {
    const config = readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
    assert.doesNotMatch(config, /"TEST_HOOKS"/);
  }
});
