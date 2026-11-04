import assert from 'node:assert/strict';
import test from 'node:test';
import {runWindow} from './run-window.mjs';

const call=(seq,op,startedMs,wallMs,result)=>({seq,request:{op},startedMs,wallMs,result});
test('a stop followed by another failed start does not close the run',()=>{
 const result=runWindow({trace:{calls:[call(1,'start',1000,100),call(2,'stop',2000,100,{stopped:true}),{...call(3,'start',3000,90000),error:'failed'}]}});
 assert.equal(result.closedByObservedStop,false);assert.equal(result.stopFollowedByActivity,true);assert.equal(result.endMs,93000);
});
test('guided recovery and later trace override a stale agent end',()=>{
 const result=runWindow({agentEndedAt:2000,guidedRecovery:{endedAt:6000},trace:{calls:[call(1,'start',1000,100),call(2,'exec',3000,500,{exitCode:0})]}});
 assert.equal(result.endMs,6000);assert.equal(result.endBasis,'guidedRecovery.endedAt');
});
test('stop closes the allocation interval at its observed completion',()=>{
 const result=runWindow({endedAt:5000,trace:{calls:[call(1,'start',1000,100),call(2,'stop',3000,100,{stopped:true})]}});
 assert.equal(result.endMs,3100);assert.equal(result.closedByObservedStop,true);
});
test('pending calls remain visibly open without inventing an end',()=>{
 const result=runWindow({trace:{calls:[call(1,'start',1000,100,{ready:true}),call(2,'exec',2000)]}});
 assert.equal(result.endMs,2000);assert.equal(result.closedByObservedStop,false);assert.deepEqual(result.pendingCallSequences,[2]);
});
