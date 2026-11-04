import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {account,retirementScope,registryTarget} from '../scope.mjs';

test('all five checked-in benchmark configs satisfy retirement scope',async()=>{
 for(const file of ['basic/wrangler.jsonc','sdk/wrangler.jsonc','computer/wrangler.jsonc','large/s2.jsonc','large/s4.jsonc']){
  const config=JSON.parse(await readFile(new URL('../'+file,import.meta.url),'utf8'));
  assert.equal(retirementScope(config).classes.length,3);
 }
});
test('retirement rejects unrelated migrations and resource paths',()=>{
 const config={account_id:account,name:'camelrun-proto-bench-test',migrations:[{tag:'camelrun-proto-bench-v1',new_sqlite_classes:['camelrun-proto-bench-machine']}]};
 assert.throws(()=>retirementScope({...config,name:'camelrun-proto-bench-test/../../other'}));
 assert.throws(()=>retirementScope({...config,migrations:[{...config.migrations[0],deleted_classes:['unrelated']}]}));
 assert.throws(()=>retirementScope({...config,migrations:[{...config.migrations[0],renamed_classes:[{from:'unrelated',to:'camelrun-proto-bench-machine'}]}]}));
 assert.throws(()=>retirementScope({...config,containers:[{name:'camelrun-proto-bench-app',class_name:'unrelated',scheduling_policy:'durable_object'}]}));
});
test('registry accepts only direct prefixed repos and valid tags',()=>{
 const repo=`${account}/camelrun-proto-bench-test`;
 assert.equal(registryTarget(repo,'wrangler-test'),`https://registry.cloudflare.com/v2/${repo}/manifests/wrangler-test`);
 for(const invalid of ['..','.','/../../other','tag/../../other'])assert.throws(()=>registryTarget(repo,invalid));
 assert.throws(()=>registryTarget(`${repo}/../../unrelated`,'valid'));
 assert.throws(()=>registryTarget(`${account}/unrelated`,'valid'));
});
