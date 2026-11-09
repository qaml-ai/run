import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { startFixture } from './fixture.ts';

test('a trigger scan outage does not skip ordinary maintenance or money maintenance', {timeout:120000}, async t => {
 const runtime=await startFixture();
 t.after(()=>runtime.stop());
 await runtime.db.query("insert into account_email_links(sha256,purpose,email,tenant,created_at,expires_at) values('expired-test','reset','test@example.test','local',0,0)");
 await runtime.db.query("insert into rate_limits(key,window_start,count,expires_at) values('expired-trigger-test',0,1,0)");
 await runtime.db.query('alter table trigger_run_agents rename to unavailable_trigger_run_agents');
 try {
  await runtime.worker.scheduled();
  assert.equal(Number((await runtime.db.query("select count(*) as n from account_email_links where sha256='expired-test'")).rows[0].n),0,'ordinary maintenance ran');
  assert.equal(Number((await runtime.db.query("select count(*) as n from rate_limits where key='expired-trigger-test'")).rows[0].n),0,'money maintenance ran');
  // Console output travels through the Wrangler child after the HTTP response.
  const deadline=Date.now()+5000;
  while(!runtime.worker.logs().includes('trigger_scan_failed')&&Date.now()<deadline)await delay(20);
  assert.ok(runtime.worker.logs().includes('trigger_scan_failed'),'the scan failure was reported');
 } finally { await runtime.db.query('alter table unavailable_trigger_run_agents rename to trigger_run_agents'); }
});
