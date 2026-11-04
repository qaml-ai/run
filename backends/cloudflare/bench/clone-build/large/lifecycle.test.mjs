import assert from 'node:assert/strict';
import test from 'node:test';
import {lifecycleVerification} from '../runner.mjs';

const hash='a'.repeat(64);
const proof={exitCode:0,stdout:`camelrun-clone-build-persist\n${hash}  /workspace/ripgrep/target/release/rg\n100\t/workspace/ripgrep\n80\t/workspace/ripgrep/target\n`};
const state=()=>({beforeSnapshot:{value:proof},afterRestore:{value:proof},restore:{value:{restored:true}},sleepState:{value:{running:false}},wake:{value:proof}});
test('successful restore requires both API success and verified files',()=>{
 const result=lifecycleVerification(state(),{id:'snapshot'});
 assert.equal(result.builtBinaryRestored,true);assert.equal(result.markerRestored,true);assert.equal(result.checkoutSizeRestored,true);assert.equal(result.targetSizeRestored,true);
 const failed=state();failed.restore={error:'restore failed'};
 const result2=lifecycleVerification(failed,{id:'snapshot'});
 assert.equal(result2.builtBinaryRestored,false);assert.equal(result2.markerRestored,false);assert.equal(result2.targetSizeRestored,false);
 assert.equal(lifecycleVerification(state(),null).builtBinaryRestored,false);
});
test('unsuccessful verification and unobserved sleep cannot imply persistence',()=>{
 const failed=state();failed.afterRestore={value:{...proof,exitCode:1}};failed.sleepState={value:{running:true}};
 const result=lifecycleVerification(failed,{id:'snapshot'});
 assert.equal(result.builtBinaryRestored,false);assert.equal(result.markerRestored,false);assert.equal(result.markerSurvivedSleep,false);
});
test('changed binary or target size is reported independently',()=>{
 const changed=state();changed.afterRestore={value:{...proof,stdout:proof.stdout.replace(hash,'b'.repeat(64)).replace('80\t','81\t')}};
 const result=lifecycleVerification(changed,{id:'snapshot'});
 assert.equal(result.builtBinaryRestored,false);assert.equal(result.targetSizeRestored,false);assert.equal(result.checkoutSizeRestored,true);assert.equal(result.markerRestored,true);
});
