import assert from 'node:assert/strict';
import { contractTest, createContractFixture } from '../support.ts';

const manifest = {
  volumes: { project: { name: 'Project' } },
  definitions: { lead: { name: 'Lead', mounts: [{ volumeId: { $ref: 'volumes.project' }, path: '/workspace', mode: 'rw' }] } },
  agents: { lead: { definition: { $ref: 'definitions.lead' }, name: 'Project lead' } },
};
contractTest('apply', 'tests/apply.test.ts:1', 'dry run, creation, and retry use stable keys without partial state', async t => {
  const r = await createContractFixture(t);
  const call = (body: unknown) => r.call('/v1/apply', { body });
  const preview = await call({ ...manifest, dryRun: true });
  assert.equal(preview.status, 200, preview.text);
  assert.deepEqual(preview.json.changes.map((c: any) => c.action), ['create', 'create', 'create']);
  assert.equal((await r.call('/v1/volumes')).json.length, 0);
  assert.equal((await r.call('/v1/definitions')).json.length, 0);
  assert.equal((await r.call('/v1/agents')).json.length, 0);
  const saved = await call(manifest);
  assert.equal(saved.status, 200, saved.text);
  assert.deepEqual(saved.json.volumes, preview.json.volumes);
  assert.deepEqual(saved.json.definitions, preview.json.definitions);
  assert.deepEqual(saved.json.agents, preview.json.agents);
  const retry = await call(manifest);
  assert.equal(retry.status, 200, retry.text);
  assert.deepEqual(retry.json.agents, saved.json.agents);
  assert.equal((await r.call('/v1/agents')).json.length, 1);
  const prompt = await r.call(`/v1/agents/${saved.json.agents.lead}/prompt`, { body: { text: 'hello' } });
  assert.equal(prompt.status, 202, prompt.text);
});
contractTest('apply', 'tests/apply.test.ts:2', 'a failure in the last agent rolls back volumes definitions and earlier agents', async t => {
  const r = await createContractFixture(t);
  const failed = await r.call('/v1/apply', { body: { ...manifest, agents: { ...manifest.agents, invalid: { definition: 'missing' } } } });
  assert.ok(failed.status >= 400, failed.text);
  for (const kind of ['volumes', 'definitions', 'agents']) assert.equal((await r.call(`/v1/${kind}`)).json.length, 0, kind);
  const repaired = await r.call('/v1/apply', { body: manifest });
  assert.equal(repaired.status, 200, repaired.text);
});
contractTest('apply', 'tests/apply.test.ts:3', 'invalid references and unknown fields fail without writes', async t => {
  const r = await createContractFixture(t);
  for (const body of [{ ...manifest, agents: { lead: { definition: { $ref: 'definitions.missing' } } } }, { ...manifest, dryRun: 'yes' }, { ...manifest, unexpected: true }]) {
    const failed = await r.call('/v1/apply', { body });
    assert.equal(failed.status, 400, failed.text);
    assert.equal((await r.call('/v1/volumes')).json.length, 0);
  }
});

contractTest('apply', 'tests/apply.test.ts:4', 'definition updates preview correctly and rejected reconfiguration rolls back new resources', async t => {
  const r = await createContractFixture(t);
  assert.equal((await r.call('/v1/apply', { body: manifest })).status, 200);
  const changed = { definitions: { lead: { ...manifest.definitions.lead, mounts: [], name: 'Changed lead' } } };
  const preview = await r.call('/v1/apply', { body: { ...changed, dryRun: true } });
  assert.equal(preview.status, 200, preview.text);
  assert.equal(preview.json.changes[0].action, 'update');
  assert.equal((await r.call('/v1/definitions')).json[0].revision, 1);
  const refused = await r.call('/v1/apply', { body: { volumes: { extra: { name: 'Must roll back' } }, agents: { lead: { ...manifest.agents.lead, definition: preview.json.definitions.lead, name: 'Changed agent' } } } });
  assert.equal(refused.status, 409, refused.text);
  assert.equal((await r.call('/v1/volumes')).json.length, 1);
  const updated = await r.call('/v1/apply', { body: changed });
  assert.equal(updated.status, 200, updated.text);
  assert.equal(updated.json.changes[0].action, 'update');
});
