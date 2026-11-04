import assert from 'node:assert/strict';
import test from 'node:test';
import {registryPlan} from '../registry-plan.mjs';
import {account,registryTarget} from '../scope.mjs';
const repo=`${account}/camelrun-proto-bench-test`;
const digest=n=>'sha256:'+String(n).repeat(64);
test('snapshot roots protect their transitive subjects and all aliases',()=>{
 const nodes=[{repo,digest:digest(1),artifactType:'application/vnd.cloudchamber.rootfs-snapshot.v1',dependencies:[digest(2)]},{repo,digest:digest(2),dependencies:[digest(3)]},{repo,digest:digest(3),dependencies:[]},{repo,digest:digest(4),dependencies:[]}];
 const refs=[{repo,ref:'rootfs-snapshot-abcd',digest:digest(1)},{repo,ref:digest(1),digest:digest(1)},{repo,ref:digest(2),digest:digest(2)},{repo,ref:digest(3),digest:digest(3)},{repo,ref:'wrangler-needed',digest:digest(3)},{repo,ref:'wrangler-orphan',digest:digest(4)},{repo,ref:digest(4),digest:digest(4)}];
 const plan=registryPlan({nodes,refs});
 assert.equal(plan.rootCount,1);assert.equal(plan.protectedManifests.length,3);
 assert.deepEqual(plan.remove.map(r=>r.ref),['wrangler-orphan',digest(4)]);
 assert.ok(plan.retained.some(r=>r.ref==='wrangler-needed'&&r.reason==='snapshot-dependency'));
});
test('missing dependency fails closed before deletion can start',()=>{
 assert.throws(()=>registryPlan({refs:[{repo,ref:'rootfs-set-abcd',digest:digest(1)}],nodes:[{repo,digest:digest(1),dependencies:[digest(2)]}]}),/Snapshot dependency missing/);
});
test('missing orphan subjects do not prevent snapshot graph verification',()=>{
 const nodes=[{repo,digest:digest(1),artifactType:'application/vnd.cloudchamber.rootfs-snapshot.v1',dependencies:[digest(2)]},{repo,digest:digest(2),dependencies:[]},{repo,digest:digest(3),dependencies:[digest(4)]}];
 const refs=[{repo,ref:'rootfs-snapshot-abcd',digest:digest(1)},{repo,ref:digest(3),digest:digest(3)},{repo,ref:digest(4),digest:digest(4),missing:true}];
 const plan=registryPlan({nodes,refs});
 assert.equal(plan.protectedManifests.length,2);
 assert.deepEqual(plan.remove.map(x=>x.digest),[digest(3),digest(4)]);
 assert.equal(plan.remove[1].missing,true);
});
test('digest references are valid only in the exact scoped repository',()=>{
 assert.ok(registryTarget(repo,digest(1)).endsWith('/manifests/'+digest(1)));
 assert.throws(()=>registryTarget(repo,'sha256:../other'));assert.throws(()=>registryTarget(`${account}/other`,digest(1)));
});
