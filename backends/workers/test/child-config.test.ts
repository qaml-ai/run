import assert from 'node:assert/strict';
import test from 'node:test';
import { childConfig } from '../src/child-config.ts';
import { SUBAGENT_PROMPT } from '../src/multi-agent-policy.ts';

test('inline children share parent files, web builtins and end-user scope', () => {
  const config = childConfig({ model: 'custom/model', systemPrompt: 'Parent secret instructions', builtins: ['agents', 'delegate', 'web_search', 'web_fetch', 'generate_image'],
    mcp: { tools: [{ name: 'private' }] }, delegate: { instructions: true }, spendLimit: { usd: 20 }, subject: 'user', context: { project: 'p' }, keyScope: 'scope', bucket: 'default',
    mounts: [{ volumeId: 'private-parent', path: '/workspace', mode: 'rw', notify: true }, { volumeId: 'shared', path: '/data', subpath: 'safe', mode: 'ro' }] }, undefined, { bucket: 'run' });
  assert.deepEqual(config, { model: 'custom/model', systemPrompt: SUBAGENT_PROMPT, builtins: ['web_search', 'web_fetch'],
    mounts: [{ volumeId: 'private-parent', path: '/workspace', mode: 'rw' }, { volumeId: 'shared', path: '/data', mode: 'ro', subpath: 'safe' }, { workspace: false }],
    subject: 'user', context: { project: 'p' }, keyScope: 'scope', bucket: 'run' });
});

test('definition children retain the resolved definition configuration', () => {
  const target = { definition: 'def_example', definitionRevision: 2, systemPrompt: 'Target', builtins: ['ask_user'], model: 'target/model', mounts: [{ workspace: true }] };
  assert.deepEqual(childConfig({ model: 'parent/model', subject: 'end-user' }, target), { ...target, subject: 'end-user' });
});

test('child tool identity stays the owner when the run has another payer', () => {
  assert.equal(childConfig({ subject: 'owner' }, undefined, { endUser: 'guest', bucket: 'bot:7' }).subject, 'owner');
});

test('inline and forked children cannot widen network policy or acquire another vault credential',async()=>{
  const {childSecurity}=await import('../src/child-config.ts');
  const {PublicOutbound}=await import('../src/public-outbound.ts');
  const {forwardEgress}=await import('../src/computers/egress.ts');
  const parent={networking:{type:'limited',allowedHosts:['api.stripe.com'],allowPackageManagers:false,allowMcpServers:false},computer:{secrets:[{type:'vault',name:'TOKEN'}]}};
  const wider={networking:{type:'unrestricted'},computer:{secrets:[{type:'vault',name:'OTHER'}]},mcpServers:[{name:'steal',url:'https://api.stripe.com',auth:{type:'vault',name:'OTHER'}}]};
  for(const config of [childConfig(parent),{...wider,...childSecurity(parent,wider)}]) {
    let sent=0;
    const policy=new PublicOutbound({networking:config.networking as any,transport:async()=>{sent++;return new Response('bad');}});
    await assert.rejects(policy.fetch('https://evil.com'),/Network destination is not allowed/);
    const {agentBuiltins}=await import('../src/agent-builtins.ts');
    const tools=await agentBuiltins({} as never,async()=>({tenant:'t',agent:'child',builtins:['web_fetch'],networking:config.networking as any}),{outbound:policy,key:async()=>undefined});
    const fetched=await tools[0].execute({url:'https://evil.com'},{callId:'c'} as any,{abortSignal:new AbortController().signal} as any);
    assert.equal(fetched.isError,true);assert.match(JSON.stringify(fetched.output),/Network destination is not allowed/);
    const result=await forwardEgress(new Request('https://evil.com'),{host:'*'},{networking:config.networking as any,credential:async()=>{throw Error('unused');},send:async()=>{sent++;return new Response('bad');}});
    assert.equal(result.status,403);assert.equal(sent,0);
    assert.ok(!JSON.stringify(config.computer).includes('OTHER'));
    assert.ok(!JSON.stringify(config.mcpServers??[]).includes('OTHER'));
  }
});

test('existing delegation targets cannot bypass a parent boundary',async()=>{
  const {assertChildSecurity}=await import('../src/child-config.ts');
  const parent={networking:{type:'limited',allowedHosts:['*.example.com'],allowPackageManagers:false,allowMcpServers:false}};
  assert.throws(()=>assertChildSecurity(parent,{}),/exceeds/);
  assert.throws(()=>assertChildSecurity(parent,{networking:{...parent.networking,allowedHosts:['evil.com']}}),/exceeds/);
  assert.throws(()=>assertChildSecurity(parent,{...parent,computer:{secrets:[{type:'vault',name:'OTHER'}]}}),/exceeds/);
  assert.doesNotThrow(()=>assertChildSecurity(parent,{networking:{...parent.networking,allowedHosts:['api.example.com']}}));
});


test('runtime and vault auth cannot smuggle a target definition’s static credentials into a child',async()=>{
  const {childSecurity}=await import('../src/child-config.ts');
  const parent={computer:{secrets:[{type:'vault',name:'TOKEN'}]}};
  const target={mcpServers:[
    {name:'runtime',url:'https://example.com',auth:{type:'runtime'},sealed:{ciphertext:'other'}},
    {name:'vault',url:'https://example.com',auth:{type:'vault',name:'TOKEN'},headers:{'x-api-key':'other-secret'}},
    {name:'identity',url:'https://example.com',auth:{type:'runtime'}},
  ]};
  assert.deepEqual(childSecurity(parent,target).mcpServers,[target.mcpServers[2]]);
});
