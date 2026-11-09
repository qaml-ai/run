import test from 'node:test';
import assert from 'node:assert/strict';
import { testDatabase } from './database.ts';
import { transaction } from '../src/db.ts';
import { recordScheduleRun, readScheduleRuns, reserveFreshScheduleRun, pruneScheduleRuns, FRESH_CAP_ERROR } from '../src/core/schedule-runs.ts';

test('scheduled outcomes persist cost and state, without agent reads or stale overwrites',async()=>{
 const {db}=await testDatabase(), source={tenant:'t',agent:'parent',schedule:'s',createdAt:Date.now()};
 await recordScheduleRun(db,source,'child',{id:'run',state:'completed',endedAt:Date.now(),outcome:{result:{stopped:'budget_reached',usage:{costUsd:.5,subagentCostUsd:.25}}}});
 await recordScheduleRun(db,source,'child',{id:'run',state:'queued'});
 const [row]=await readScheduleRuns(db,'t','parent');
 assert.equal(row.state,'failed'); assert.equal(row.error,'budget_reached'); assert.equal(row.cost,.75); assert.equal(row.runId,'run');
 assert.equal(row.agent,'child'); assert.ok(row.endedAt); assert.equal(row.emailState,null);
 assert.deepEqual(await readScheduleRuns(db,'other','parent'),[]);
});
test('fresh reservations serialize the 200-agent cap; expired reservations release capacity',async()=>{
 const {db}=await testDatabase(), now=Date.now(), source={tenant:'t',agent:'p',schedule:'s',createdAt:now};
 await db.query("insert into schedule_runs(id,tenant,agent,schedule,created_at,expires_at) select 'run-'||i,'t','p','s',$1,$2 from generate_series(1,199) i",[now,now+60000]);
 const results=await Promise.allSettled(['a','b'].map(id=>transaction(db,sql=>reserveFreshScheduleRun(sql,source,id,now))));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.match(String((results.find(r=>r.status==='rejected') as PromiseRejectedResult).reason),new RegExp(FRESH_CAP_ERROR));
 await db.query('update schedule_runs set expires_at=$1',[now-1]);
 await transaction(db,sql=>reserveFreshScheduleRun(sql,source,'c',now));
});
test('retention deletes at most 500 old rows per batch, skips locks, and retains recent rows',async()=>{
 const {db}=await testDatabase(),now=Date.now();
 await db.query("insert into schedule_runs(id,tenant,agent,schedule,created_at) select 'old-'||i,'t','p','s',$1 from generate_series(1,501) i",[now-31*86400000]);
 await db.query("insert into schedule_runs(id,tenant,agent,schedule,created_at) values('new','t','p','s',$1)",[now]);
 const connection=await db.connect();
 try {
  await connection.query('begin'); await connection.query("select id from schedule_runs where id='old-1' for update");
  assert.equal((await pruneScheduleRuns(db,now)).rowCount,500);
  assert.equal((await pruneScheduleRuns(db,now)).rowCount,0);
 } finally {await connection.query('rollback');connection.release();}
 assert.equal((await pruneScheduleRuns(db,now)).rowCount,1);
 assert.equal((await db.query('select count(*)::int n from schedule_runs')).rows[0].n,1);
});
