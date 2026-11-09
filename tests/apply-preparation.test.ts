import assert from 'node:assert/strict';
import test from 'node:test';
import { applyPreparation, ApplyChanged, prepareApply } from '../shared/apply-scope.ts';

test('apply prepares once before locking and clones mutable prepared values', async () => {
  let calls = 0;
  const scope = { values: new Map<string, Promise<unknown>>(), locked: false };
  await applyPreparation.run(scope, async () => {
    const prepare = async () => { calls++; return { model: { id: 'model' } }; };
    const preview = await prepareApply('model', prepare);
    preview.model.id = 'mutated';
    scope.locked = true;
    assert.deepEqual(await prepareApply('model', prepare), { model: { id: 'model' } });
    await assert.rejects(prepareApply('new-model', prepare), ApplyChanged);
    assert.equal(calls, 1);
    scope.locked = false;
    await prepareApply('new-model', prepare);
    assert.equal(calls, 2);
  });
  await prepareApply('model', async () => { calls++; });
  assert.equal(calls, 3, 'ordinary upserts do not share an apply cache');
});
