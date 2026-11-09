import {test} from 'node:test';
import assert from 'node:assert/strict';
import {tenantDreamSecrets,removeDreamSecrets} from '../shared/dreaming-secrets.ts';

test('known secrets include providers, scoped keys, MCP headers, model headers and computer credentials',async()=>{
  const rows=[
    [{provider:'p',sealed:'provider'}], [{scope:'s',provider:'p',sealed:'scope'}],
    [{scope:'s',name:'m',sealed:'model'}], [{id:'c',credentials:'computer'}],
    [{id:'d',spec:{mcpServers:[{name:'mcp',sealed:'mcp'}],openApi:[{name:'api',sealed:'api'}],computer:{secrets:{password:'computer-setting'}}}}],
    [{header:{definition:{id:'old'},config:{modelHeaders:{'X-Credential':'model-header'}},sources:{mcpServers:[{name:'mcp',sealed:'old-mcp'}]}}}],
  ];
  let i=0;const aads:string[]=[];
  const values=await tenantDreamSecrets(async()=>({rows:rows[i++]}),{
    tenants:{providers:()=>['p'],apiKey:()=> 'admin-key'},
    unseal:(aad,sealed)=>{aads.push(aad);return sealed==='provider'?'provider-key':JSON.stringify({token:`secret-${sealed}`});},
  },'tenant');
  for(const secret of ['admin-key','provider-key','secret-scope','secret-model','secret-computer','secret-mcp','secret-api','computer-setting','model-header','secret-old-mcp']) assert.ok(values.includes(secret),secret);
  assert.ok(aads.includes('definition:old:mcp:mcp'));assert.ok(aads.includes('model-provider:tenant:scope:s:m'));
  const result=removeDreamSecrets({summary:'Key short pass and short%20pass',files:{'projects/customer-onboarding-flow.md':'short pass'}},['short pass']);
  assert.equal(result.files['projects/customer-onboarding-flow.md'],'[redacted]');
  assert.ok(!JSON.stringify(result).includes('short pass'));assert.ok(!JSON.stringify(result).includes('short%20pass'));
});
