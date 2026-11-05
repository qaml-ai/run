import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { startFixture } from './fixture.ts';
import { pngBytes } from '../../../tests/file-fixtures.ts';

test('media resolves shared encrypted keys, scoped gateways and source billing ownership', {timeout:90000}, async t => {
  const calls:{authorization?:string;customer?:string}[]=[];
  const server=createServer(async (request,response)=>{
    for await (const _ of request) { /* Drain only synthetic input. */ }
    calls.push({authorization:request.headers.authorization,customer:request.headers['x-customer'] as string|undefined});
    response.setHeader('content-type','application/json');
    response.end(JSON.stringify({data:[{b64_json:pngBytes(10,10).toString('base64')}],usage:{input_tokens:0,output_tokens:1000}}));
  }).listen(0,'127.0.0.1');
  await once(server,'listening');t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const token='local-integration-only-token-with-at-least-32-characters';
  const settings={platformKeys:{openai:'fake-platform-key'},tenants:{'camelrun-proto-local':{
    tokenSha256:createHash('sha256').update(token).digest('hex'),apiKeys:{openai:'fake-admin-key'},billing:'prepaid',
  },'media-disabled':{tokenSha256:createHash('sha256').update('disabled-token').digest('hex'),apiKeys:{},platformKeys:false}}};
  const f=await startFixture({tenants:[{id:'camelrun-proto-local',token},{id:'media-plain',token:'art_plain-fixture'},{id:'media-disabled',token:'disabled-token'}],vars:{
    AGENT_TENANTS_JSON:JSON.stringify(settings),MEDIA_BASE_URL:base,AGENT_PRICE_IMAGE_OUTPUT_USD:'20',
  }});t.after(()=>f.stop());
  const request=async(path:string,method:string,body?:unknown,apiKey=f.token)=>{
    const response=await fetch(f.url+path,{method,headers:{authorization:`Bearer ${apiKey}`,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:response.status,body:await response.json() as any};
  };
  const balance=async(tenant='camelrun-proto-local')=>Number((await f.db.query('select balance from credit_accounts where tenant=$1',[tenant])).rows[0].balance);
  const image=async(keyScope?:string,apiKey=f.token)=>{
    const result=await request('/v1/images','POST',{prompt:'Synthetic key resolution',...(keyScope?{keyScope}:{})},apiKey);
    assert.equal(result.status,200,`${result.body.code ?? ''}: ${result.body.error ?? ''}`);
    assert.equal(result.body.costUsd,.02,'media reads shared configured pricing');
    assert.ok(!JSON.stringify(result.body).includes('fake-'),'credentials stay out of media responses');
  };

  const initial=await balance();
  await image();assert.ok(calls.at(-1)?.authorization==='Bearer fake-admin-key');
  assert.equal(await balance(),initial-20000,'admin key is platform usage under source media rules');
  assert.equal((await request('/v1/providers/openai/key','PUT',{apiKey:'fake-stored-key',verify:false})).status,200);
  const storedBalance=await balance();
  await image();assert.ok(calls.at(-1)?.authorization==='Bearer fake-stored-key');
  assert.equal(await balance(),storedBalance,'tenant-owned key is not charged to platform credit');
  const sealed=(await f.db.query('select sealed from provider_keys where tenant=$1',['camelrun-proto-local'])).rows[0].sealed;
  assert.deepEqual(Object.keys(sealed).sort(),['ciphertext','iv','tag']);
  assert.ok(!JSON.stringify(sealed).includes('fake-stored-key'));

  assert.equal((await request('/v1/key-scopes/customer/providers/openai','PUT',{apiKey:'fake-scoped-key',baseUrl:base,headers:{'x-customer':'synthetic'}})).status,200);
  await image('customer');assert.ok(calls.at(-1)?.authorization==='Bearer fake-scoped-key');assert.equal(calls.at(-1)?.customer,'synthetic');
  assert.equal((await request('/v1/key-scopes/gateway/providers/openai','PUT',{baseUrl:base,headers:{'x-customer':'gateway'}})).status,200);
  await image('gateway');assert.equal(calls.at(-1)?.authorization,undefined);assert.equal(calls.at(-1)?.customer,'gateway');
  await image('missing');assert.ok(calls.at(-1)?.authorization==='Bearer fake-stored-key','missing scope falls back to tenant key');
  await image(undefined,'art_plain-fixture');assert.ok(calls.at(-1)?.authorization==='Bearer fake-platform-key');
  const count=calls.length;
  assert.equal((await request('/v1/images','POST',{prompt:'Denied'},'disabled-token')).status,400);
  assert.equal(calls.length,count,'disabled platform keys never reach the provider');
  const usage=(await f.db.query("select responses,platform_responses from usage where tenant=$1 and model='image:openai/gpt-image-2.5-flare'",['camelrun-proto-local'])).rows[0];
  assert.equal(Number(usage.responses),5);assert.equal(Number(usage.platform_responses),1);
});
