import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { serveFakeCamelfsd } from './fake-camelfsd.ts';
import { fileURLToPath } from 'node:url';
import { startFixture } from './fixture.ts';

async function fixture(t: TestContext, vars: Record<string, string> = {}) {
  const token = 'local-apply-integration-token-at-least-32-characters';
  const daemon=await serveFakeCamelfsd('apply-repos');
  t.after(()=>daemon.close());
  const f = await startFixture({ camelfsStub:true,entrypoint:fileURLToPath(new URL('./camelfs-worker.ts',import.meta.url)),token, tenant: 'apply-test', tenants: [{ id: 'apply-test', token, billing: 'prepaid' }], vars:{...vars,TEST_CAMELFS_URL:daemon.url,CAMELFS_API_TOKEN:'apply-repos'} });
  t.after(() => f.stop());
  const apply = async (body: unknown) => {
    const response = await fetch(`${f.url}/v1/apply`, { method: 'POST', headers: { authorization: `Bearer ${f.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, json: await response.json() as any };
  };
  return { ...f, apply };
}

test('apply reserves all creation capacity before committing and releases refused reservations', { timeout: 90_000 }, async t => {
  const f = await fixture(t, { AGENT_USAGE_TIERS: JSON.stringify([{ name: 'Free', paidUsd: 0, busyAgents: 1 }]) });
  const manifest = { volumes: { project: { name: 'Project' } }, definitions: { lead: { name: 'Lead' } }, agents: { first: {}, last: {} } };
  const refused = await f.apply(manifest);
  assert.equal(refused.status, 429, JSON.stringify(refused));
  for (const table of ['volumes', 'definitions', 'agents'])
    assert.equal((await f.db.query(`select count(*)::int n from ${table} where tenant=$1`, ['apply-test'])).rows[0].n, 0, table);
  const saved = await f.apply({ ...manifest, agents: { first: {} } });
  assert.equal(saved.status, 200, JSON.stringify(saved));
});

test('apply retries preserve the committed revision and refuse resolved-model changes before commit', { timeout: 90_000 }, async t => {
  const f = await fixture(t);
  const made = await f.apply({ agents: { lead: { name: 'Lead', subject: 'user-1' } } });
  assert.equal(made.status, 200, JSON.stringify(made));
  const id = made.json.agents.lead;
  const snapshot = async () => (await f.db.query('select header,revision from agents where id=$1', [id])).rows[0];
  const original = await snapshot();
  assert.equal(original.header.initialized, true);
  const retry = await f.apply({ agents: { lead: { name: 'Lead' } } });
  assert.equal(retry.status, 200, JSON.stringify(retry));
  assert.deepEqual(await snapshot(), original);
  // Simulate an old persisted resolution that no longer matches the model selected by the current runtime.
  await f.db.query("update agents set header=jsonb_set(header::jsonb,'{resolvedModel}',$2::jsonb)::json where id=$1", [id, JSON.stringify({ id: 'old-resolution' })]);
  const old = await snapshot();
  const refused = await f.apply({ volumes: { extra: {} }, agents: { lead: { name: 'Lead' } } });
  assert.equal(refused.status, 409, JSON.stringify(refused));
  assert.deepEqual(await snapshot(), old);
  assert.equal((await f.db.query("select count(*)::int n from volumes where tenant=$1 and name='volume'", ['apply-test'])).rows[0].n, 0);
});

test('apply mounts provision repos and its preview creates none', {timeout:90_000}, async t=>{
  const f=await fixture(t);
  const manifest={volumes:{shared:{name:'Shared'}},agents:{writer:{mounts:[{repo:{$ref:'volumes.shared'},path:'/shared',mode:'rw'}]}}};
  const preview=await f.apply({...manifest,dryRun:true});
  assert.equal(preview.status,200,JSON.stringify(preview));
  const list=async()=>{const r=await fetch(f.url+'/v1/repos',{headers:{authorization:`Bearer ${f.token}`}});return await r.json() as any;};
  assert.deepEqual((await list()).repos,[]);
  const saved=await f.apply(manifest);
  assert.equal(saved.status,200,JSON.stringify(saved));
  assert.match(saved.json.volumes.shared,/^repo_/);
  assert.equal((await list()).repos.length,2);
  const retry=await f.apply(manifest);
  assert.equal(retry.status,200,JSON.stringify(retry));
  assert.deepEqual(retry.json.agents,saved.json.agents);
});
