import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { verifyPilot, auditCommand } from '../scripts/verify-egress.mjs';

const values = {pilot:'https://pilot.example.com',agent:'parent','vault-name':'TOKEN','vault-url':'https://echo.example.com/headers','blocked-host':'example.com'};
const parent = {networking:{type:'limited',allowedHosts:['github.com','echo.example.com']},computer:{secrets:[{type:'vault',name:'TOKEN'}],egress:[{host:'github.com',auth:{type:'github-app',app:'pilot'}}]},builtins:['agents'],delegate:{instructions:true}};

test('pilot verification refuses production before any request',async()=>{
  for (const host of ['run.camelai.com','api.run.camelai.com']) await assert.rejects(verifyPilot({...values,pilot:`https://${host}`},{key:'test',transport:async()=>{throw Error('must not request');}}),/Production is refused/);
});

test('pilot verification audits the parent, fork and real inline child and cleans up',async()=>{
  const audits:string[]=[], deleted:string[]=[], prompts:string[]=[];
  const transport=async(input:any,init:any)=>{
    const path=new URL(input).pathname;
    if(init.method==='DELETE'){deleted.push(path);return new Response(null,{status:204});}
    if(path.endsWith('/configuration')) return Response.json(path.includes('/inline/')?{...parent,definition:undefined}:parent);
    if(path.endsWith('/computer')){const body=JSON.parse(init.body);audits.push(path);assert.match(body.argv[2],/git clone/);assert.match(body.argv[2],/git.*push/);assert.match(body.argv[2],/403/);assert.match(body.argv[2],/\[hidden\]/);return Response.json({exitCode:0,stdout:'vault-egress-ok\n'});}
    if(path.endsWith('/fork'))return Response.json({id:'fork'});
    if(path.endsWith('/prompt')){prompts.push(JSON.parse(init.body).text);return Response.json({id:'request'});}
    if(path.endsWith('/children'))return Response.json({children:[{agentId:'inline',name:prompts[0].match(/name "([^"]+)"/)![1]}]});
    throw Error(`Unexpected request: ${path}`);
  };
  const result=await verifyPilot(values,{key:'test',transport});
  assert.deepEqual(result.checks.map((r:any)=>r.role),['parent','fork','inline']);
  assert.equal(audits.length,3);assert.equal(deleted.length,2);
  assert.match(prompts[0],/computer "fresh"/);
  const command=auditCommand({branch:'vault-egress-test',vaultName:'TOKEN',vaultUrl:values['vault-url'],blocked:'https://example.com/'});
  assert.equal(spawnSync('bash',['-n'],{input:command}).status,0);
});

test('pilot verification stops when a fork widens the policy',async()=>{
  let audited=0,deleted=false;
  const transport=async(input:any,init:any)=>{
    const path=new URL(input).pathname;
    if(init.method==='DELETE'){deleted=true;return new Response(null,{status:204});}
    if(path.endsWith('/fork')) return Response.json({id:'fork'});
    if(path.endsWith('/computer')){audited++;return Response.json({exitCode:0,stdout:'vault-egress-ok'});}
    return Response.json(path.includes('/fork/')?{...parent,networking:{type:'unrestricted'}}:parent);
  };
  await assert.rejects(verifyPilot(values,{key:'test',transport}),/limited networking/);
  assert.equal(audited,1);assert.equal(deleted,true);
});
