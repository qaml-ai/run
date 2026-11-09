import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cronInput,nextCron} from '../src/core/cron.ts';
import {scheduleInput} from '../src/scheduler.ts';
test('cron validates five numeric fields and IANA zones',()=>{
 for(const expression of ['* * * *','60 * * * *','*/0 * * * *','0 0 30 2 *','0 0 * 13 *','0 0 * * MON']) assert.throws(()=>cronInput({expression,timeZone:'UTC'}));
 assert.throws(()=>cronInput({expression:'* * * * *',timeZone:'Mars/Olympus'}));
 assert.throws(()=>scheduleInput({text:'hi',cron:{expression:'* * * * *',timeZone:'UTC'},inSeconds:30}));
 assert.throws(()=>scheduleInput({text:'hi',inSeconds:30,spendLimit:{usd:-1}}));
});
test('cron skips missing DST minutes and runs both repeated minutes',()=>{
 const cron=cronInput({expression:'30 2 * * *',timeZone:'America/Chicago'});
 assert.equal(new Date(nextCron(cron,Date.parse('2026-03-08T06:00Z'))).toISOString(),'2026-03-09T07:30:00.000Z');
 const repeated=cronInput({expression:'30 1 * * *',timeZone:'America/Chicago'});
 const first=nextCron(repeated,Date.parse('2026-11-01T05:00Z'));
 assert.equal(new Date(first).toISOString(),'2026-11-01T06:30:00.000Z');
 assert.equal(new Date(nextCron(repeated,first)).toISOString(),'2026-11-01T07:30:00.000Z');
});
test('cron lists, steps, weekday aliases and leap days',()=>{
 const next=(expression:string,after:string)=>new Date(nextCron(cronInput({expression,timeZone:'UTC'}),Date.parse(after))).toISOString();
 assert.equal(next('*/15 9-10 * * 1-5','2026-11-09T09:01Z'),'2026-11-09T09:15:00.000Z');
 assert.equal(next('0 0 29 2 *','2026-01-01Z'),'2028-02-29T00:00:00.000Z');
 assert.equal(next('0 0 * * 7','2026-11-07T00:00Z'),'2026-11-08T00:00:00.000Z');
});
