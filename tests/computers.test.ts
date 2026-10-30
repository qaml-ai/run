import { test } from "node:test";
import assert from "node:assert/strict";
import { Computers } from "../src/computers/service.ts";
import { Accounts } from "../src/accounts.ts";
import { Tenants } from "../src/tenants.ts";
import { Outbound } from "../src/outbound.ts";
import { testDatabase } from "./database.ts";
import { Workspaces } from "../src/workspaces.ts";

async function fixture(provider: 'e2b' | 'sprites' = 'e2b') {
  const { db } = await testDatabase();
  await db.query("insert into agents(id,tenant,header,revision,name,type,model) values ('a','alice','{}',1,'A','test','x'),('b','bob','{}',1,'B','test','x')");
  const accounts = new Accounts({ db, tenants: new Tenants({ read: async () => '{"tenants":{}}' }), secretsKey: 'ab'.repeat(32) });
  let now = Date.now(), creates = 0, closes = 0, executions = 0, failing = false, closeFails = false;
  const options = { db, accounts, outbound: new Outbound(), now: () => now, driver: () => ({
    async create(id: string) { creates++; return { id }; },
    async call() { executions++; if (failing) throw new Error('credential-must-not-leak'); return { exitCode: 0, stdout: 'done' }; },
    async close() { closes++; if (closeFails) throw new Error('provider unavailable'); },
  }) };
  const service = new Computers(options);
  const connection = await service.create('alice', { agent: 'a', provider, credentials: { apiKey: 'private-secret' }, leaseSeconds: 60, dailySeconds: 120 });
  return { db, service, connection, restart: () => new Computers(options), advance: (ms: number) => now += ms,
    counts: () => ({ creates, closes, executions }), fail: () => failing = true, closeFail: (value: boolean) => closeFails = value };
}

test('computer ownership, sealed credentials, durable command retries and lifecycle retries', async () => {
  const f = await fixture();
  assert.doesNotMatch(JSON.stringify(await f.service.list('alice')), /private-secret/);
  assert.doesNotMatch(JSON.stringify((await f.db.query('select credentials from computer_connections')).rows), /private-secret/);
  assert.deepEqual(await f.service.list('bob'), []);
  await assert.rejects(f.service.call('bob', 'a', 'computer_start', {}, 'start'), /No computer/);
  await f.service.call('alice', 'a', 'computer_start', {}, 'start');
  const result = await f.service.call('alice', 'a', 'computer_exec', { command: 'echo hi' }, 'execute');
  assert.deepEqual(await f.restart().call('alice', 'a', 'computer_exec', { command: 'echo hi' }, 'execute'), result);
  assert.equal(f.counts().executions, 1);
  await assert.rejects(f.service.call('alice', 'a', 'computer_exec', { command: 'changed' }, 'execute'), /changed/);
  await f.service.call('alice', 'a', 'computer_stop', {}, 'stop');
  await f.service.call('alice', 'a', 'computer_start', {}, 'new-start');
  await f.restart().call('alice', 'a', 'computer_stop', {}, 'stop');
  assert.equal((await f.service.status('alice','a')).session!.state, 'active');
  assert.equal(f.counts().closes, 1);
  await f.service.call('alice', 'a', 'computer_start', {}, 'start');
  assert.equal(f.counts().creates, 2);
});

test('Browser Use exposes browser actions without host shell tools', async () => {
  const f=await fixture();
  await f.db.query("update computer_connections set provider='browser-use'");
  const names=(await f.service.tools('alice','a')).map(t=>t.name);
  assert.ok(names.includes('browser_evaluate'));
  assert.ok(!names.includes('computer_exec'));
  assert.ok(!names.includes('computer_upload'));
  assert.ok(!names.includes('computer_download'));
  await f.service.call('alice','a','computer_start',{},'start');
  await f.service.call('alice','a','browser_evaluate',{expression:'1+1'},'evaluate');
  assert.equal(f.counts().executions,1);
  await assert.rejects(f.service.call('alice','a','computer_exec',{command:'true'},'shell'),/not supported/);
  await assert.rejects(f.service.call('alice','a','computer_upload',{from:'source',to:'dest'},'upload'),/not supported/);
  await f.service.call('alice','a','computer_stop',{},'stop');
});

test('ambiguous commands do not replay after restarting the service', async () => {
  const f = await fixture();
  await f.service.call('alice', 'a', 'computer_start', {}, 'start');
  f.fail();
  await assert.rejects(f.service.call('alice', 'a', 'computer_exec', { command: 'mutate' }, 'call'), error => !String(error).includes('credential-must-not-leak'));
  await assert.rejects(f.restart().call('alice', 'a', 'computer_exec', { command: 'mutate' }, 'call'), /uncertain/);
  assert.equal(f.counts().executions, 1);
});

for (const provider of ['e2b', 'sprites'] as const) test(`${provider} expiry cleanup retries, time budgets and original workspace attribution`, async () => {
  const f = await fixture(provider), groups = new Workspaces(f.db);
  const workspace = await groups.create('alice','First'), later = await groups.create('alice','Later');
  await groups.assign('alice','agent','a',workspace.id);
  await f.service.call('alice','a','computer_start',{},'first');
  await groups.assign('alice','agent','a',later.id);
  f.advance(61000); f.closeFail(true);
  await f.service.sweep();
  assert.equal((await f.service.status('alice','a')).session!.state,'closing');
  f.closeFail(false); await f.restart().sweep();
  assert.equal((await f.service.status('alice','a')).session!.state,'closed');
  const usage = await f.service.usage('alice');
  assert.equal(usage[0].workspace,workspace.id);
  assert.equal(Number(usage[0].seconds),60);
  await f.service.call('alice','a','computer_start',{},'second'); f.advance(61000); await f.service.sweep();
  await assert.rejects(f.service.call('alice','a','computer_start',{},'third'),/budget/);
});

test('disconnect removes tools and credentials only after successful provider cleanup', async () => {
  const f = await fixture();
  assert.ok((await f.service.tools('alice','a')).some(t=>t.name==='computer_exec'));
  await f.service.call('alice','a','computer_start',{},'start');
  await assert.rejects(f.service.remove('bob',f.connection.id),/Unknown/);
  f.closeFail(true); await assert.rejects(f.service.remove('alice',f.connection.id),/cleanup/);
  assert.equal((await f.service.list('alice')).length,1);
  f.closeFail(false); await f.service.remove('alice',f.connection.id);
  assert.deepEqual(await f.service.list('alice'),[]);
  assert.deepEqual(await f.service.tools('alice','a'),[]);
});

test('an allocated machine is retained for cleanup when startup fails', async () => {
  const f = await fixture();
  let removed = false;
  const service = new Computers({ ...f.service.options, driver: () => ({
    async create(id, _seconds, allocated) { await allocated?.({ id }); throw new Error('Startup failed'); },
    async call() { throw new Error('unused'); },
    async close() { removed = true; },
  }) });
  await assert.rejects(service.call('alice','a','computer_start',{},'failed-start'), /may have made a machine/);
  assert.equal((await service.status('alice','a')).session!.state,'uncertain');
  await service.sweep();
  assert.equal(removed,true);
  assert.equal((await service.status('alice','a')).session!.state,'closed');
  assert.equal((await f.db.query('select reference from computer_leases')).rows[0].reference,null);
});

test('an unknown allocation blocks replacement until the account confirms provider cleanup', async () => {
  const f = await fixture();
  const service = new Computers({ ...f.service.options, driver: () => ({
    async create() { throw new Error('Reply lost'); }, async call() {}, async close() {},
  }) });
  await assert.rejects(service.call('alice','a','computer_start',{},'failed-start'),/may have made a machine/);
  await assert.rejects(service.call('alice','a','computer_start',{},'replacement'),/earlier operation/);
  await assert.rejects(service.confirmCleanup('bob','a'),/No computer/);
  await service.confirmCleanup('alice','a');
  assert.equal((await service.status('alice','a')).session!.state,'closed');
  await assert.rejects(service.confirmCleanup('alice','a'),/Only a failed/);
});

test('concurrent starts create a single machine and closed history stays detached', async () => {
  const f = await fixture();
  await Promise.all([f.service.call('alice','a','computer_start',{},'one'),f.restart().call('alice','a','computer_start',{},'two')]);
  assert.equal(f.counts().creates,1);
  await f.service.removeTenant('alice');
  assert.equal(f.counts().closes,1);
  assert.equal((await f.service.usage('alice'))[0].sessions,1);
  assert.deepEqual(await f.service.list('alice'),[]);
});

test('arbitrary command output remains storable in Postgres and replayable', async () => {
  const f = await fixture();
  const service = new Computers({ ...f.service.options, driver: () => ({
    async create(id) { return {id}; }, async call() { return {stdout:'a\u0000\ud800b'}; }, async close() {},
  }) });
  await service.call('alice','a','computer_start',{},'start');
  const value = await service.call('alice','a','computer_exec',{command:'binary-output'},'exec');
  assert.deepEqual(value,{stdout:'a\ufffd\ufffdb'});
  assert.deepEqual(await f.restart().call('alice','a','computer_exec',{command:'binary-output'},'exec'),value);
});
