import assert from 'node:assert/strict';
import test from 'node:test';
import {parseStepCall} from '../collect.mjs';

const call=(command,stdout,exitCode=0)=>({source:'agent',request:{op:'exec',argv:['/bin/bash','-lc',command]},result:{stdout,stderr:'',exitCode},wallMs:30000});
const poll="cat /workspace/ripgrep-build.time; cat /workspace/ripgrep-build.rc";

test('recorded return codes override the display shell across agent formats',()=>{
 for(const marker of ['RC=101','RC=\n101','RC FOUND:\n101','RC:\n101','DONE rc=101']){
  const [result]=parseStepCall(call(poll,marker+'\nBENCH_WALL_SECONDS=1.01\n'));
  assert.equal(result.exitCode,101);assert.equal(result.exitCodeSource,'explicit-rc');assert.equal(result.pollShellExitCode,0);
 }
 const [success]=parseStepCall(call(poll,'RC:\n0\nBENCH_WALL_SECONDS=74.90\n'));
 assert.equal(success.exitCode,0);assert.equal(success.wallSeconds,74.9);
});

test('poll shell and echoed process listings do not prove a build result',()=>{
 const [running]=parseStepCall(call(poll,"RUNNING\n42 bash -c echo RC=101; cat /workspace/ripgrep-build.rc\n",1));
 assert.equal(running.exitCode,null);assert.equal(running.pollShellExitCode,1);
 const [timing]=parseStepCall(call(poll,'BENCH_WALL_SECONDS=0.00\n'));
 assert.equal(timing.exitCode,null);assert.equal(timing.wallSeconds,0);
});

test('GNU time proves failures, while status conflicts stay ambiguous',()=>{
 const [failure]=parseStepCall(call(poll,'Command exited with non-zero status 101\nBENCH_WALL_SECONDS=0.13\n'));
 assert.equal(failure.exitCode,101);assert.equal(failure.exitCodeSource,'gnu-time-status');
 const [conflict]=parseStepCall(call(poll,'RC=0\nCommand exited with non-zero status 101\n'));
 assert.equal(conflict.exitCode,null);assert.equal(conflict.ambiguousExitStatus,true);
});

test('foreground wrappers preserve exit status, background launches do not',()=>{
 const foreground="STEP=ripgrep-build; /usr/bin/time -o /workspace/$STEP.time bash -lc 'cargo build'; rc=$?; cat /workspace/$STEP.time; exit $rc";
 const [result]=parseStepCall(call(foreground,'BENCH_WALL_SECONDS=25.25\n'));
 assert.equal(result.exitCode,0);assert.equal(result.exitCodeSource,'foreground-preserved-exit');
 const [background]=parseStepCall(call("STEP=ripgrep-build; nohup bash -c 'cargo build' > /workspace/$STEP.log & echo PID=$!",'PID=10\n'));
 assert.equal(background.exitCode,null);assert.equal(background.observationKind,'background-launch');
});

test('multi-step timing recap is not another trial and recovery keeps its identity',()=>{
 assert.deepEqual(parseStepCall(call('cat /workspace/express-clone.time /workspace/ripgrep-build.time','BENCH_WALL_SECONDS=1\nBENCH_WALL_SECONDS=2\n')),[]);
 const [recovery]=parseStepCall(call('cat /workspace/ripgrep-build-recovery.rc /workspace/ripgrep-build-recovery.time','RC:\n0\nBENCH_WALL_SECONDS=74.90\n'));
 assert.equal(recovery.step,'ripgrep-build');assert.equal(recovery.artifact,'ripgrep-build-recovery');
});
