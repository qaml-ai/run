import assert from 'node:assert/strict';
import { contractTest, createContractFixture, freshWindow } from '../support.ts';

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
  const volume = await r.call(`/v1/volumes/${saved.json.volumes.project}`);
  assert.equal(volume.status, 200, volume.text);
  assert.equal(volume.json.id, saved.json.volumes.project);
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

contractTest('apply', 'tests/apply.test.ts:5', 'references and volume ids cannot cross tenants', async t => {
  const r = await createContractFixture(t);
  const other = await r.seedTenant('other-apply');
  const foreign = await r.call('/v1/apply', { body: manifest, token: other.token });
  assert.equal(foreign.status, 200, foreign.text);
  for (const agents of [
    { lead: { definition: { $ref: 'definitions.lead' } } },
    { lead: { definition: foreign.json.definitions.lead } },
    { lead: { mounts: [{ volumeId: foreign.json.volumes.project, path: '/foreign', mode: 'rw' }] } },
  ]) {
    const refused = await r.call('/v1/apply', { body: { volumes: { new: { name: 'Rollback' } }, agents } });
    assert.ok(refused.status >= 400 && refused.status < 500, refused.text);
    for (const kind of ['volumes', 'definitions', 'agents']) assert.equal((await r.call(`/v1/${kind}`)).json.length, 0, kind);
  }
});

contractTest('apply', 'tests/apply.test.ts:6', 'accepts 100 resources and refuses 101 before writing', async t => {
  const r = await createContractFixture(t);
  const volumes = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`v${i}`, { name: `Volume ${i}` }]));
  const preview = await r.call('/v1/apply', { body: { volumes, dryRun: true } });
  assert.equal(preview.status, 200, preview.text);
  assert.equal(preview.json.changes.length, 100);
  const refused = await r.call('/v1/apply', { body: { volumes, definitions: { excess: { name: 'Excess' } } } });
  assert.equal(refused.status, 400, refused.text);
  assert.equal((await r.call('/v1/volumes')).json.length, 0);
});

contractTest('apply', 'tests/apply.test.ts:7', 'refuses prompts history and automatic definition application without writes', async t => {
  const r = await createContractFixture(t);
  for (const extra of [
    { agents: { lead: { prompt: 'start' } } },
    { agents: { lead: { importMessages: [] } } },
    { agents: { lead: { initialMessages: [] } } },
    { definitions: { lead: { name: 'Lead', applyOnUpdate: true } } },
    { definitions: { lead: { name: 'Lead', apply: 'all' } } },
  ]) {
    const refused = await r.call('/v1/apply', { body: { ...manifest, ...extra } });
    assert.equal(refused.status, 400, refused.text);
    for (const kind of ['volumes', 'definitions', 'agents']) assert.equal((await r.call(`/v1/${kind}`)).json.length, 0, kind);
  }
});

contractTest('apply', 'tests/apply.test.ts:8', 'concurrent applies share ids and preserve a stored subject when omitted', async t => {
  const r = await createContractFixture(t);
  const subject = { agents: { lead: { subject: 'user-1', name: 'Lead' } } };
  const made = await r.call('/v1/apply', { body: subject });
  assert.equal(made.status, 200, made.text);
  const before = await r.call(`/v1/agents/${made.json.agents.lead}/credentials`);
  const together = await Promise.all(Array.from({ length: 3 }, () => r.call('/v1/apply', { body: { agents: { lead: { name: 'Lead' } } } })));
  for (const result of together) {
    assert.equal(result.status, 200, result.text);
    assert.deepEqual(result.json.agents, made.json.agents);
    assert.equal(result.json.changes[0].action, 'unchanged');
  }
  assert.equal((await r.call(`/v1/agents/${made.json.agents.lead}/credentials`)).json.configHash, before.json.configHash);
  const fresh = await Promise.all(Array.from({ length: 2 }, () => r.call('/v1/apply', { body: manifest })));
  for (const result of fresh) assert.equal(result.status, 200, result.text);
  assert.deepEqual(fresh[0].json.agents, fresh[1].json.agents);
  assert.equal((await r.call('/v1/definitions')).json.length, 1);
  assert.equal((await r.call('/v1/volumes')).json.length, 1);
  assert.equal((await r.call('/v1/agents')).json.length, 2);
});

contractTest('apply', 'tests/apply.test.ts:9', 'a last-agent rate refusal rolls back every resource and its admission count', async t => {
  const r = await createContractFixture(t, { env: { AGENT_USAGE_TIERS: JSON.stringify([{ name: 'Free', paidUsd: 0, busyAgents: 20, agentCreatesPerMinute: 1 }]) } });
  const { token } = await r.seedTenant('limited-apply', { operator: false, credits: 1_000_000 });
  await freshWindow(60, 20_000);
  const refused = await r.call('/v1/apply', { token, body: { ...manifest, agents: { ...manifest.agents, last: { name: 'Last' } } } });
  assert.equal(refused.status, 429, refused.text);
  for (const kind of ['volumes', 'definitions', 'agents']) assert.equal((await r.call(`/v1/${kind}`, { token })).json.length, 0, kind);
  const saved = await r.call('/v1/apply', { token, body: manifest });
  assert.equal(saved.status, 200, saved.text);
});
