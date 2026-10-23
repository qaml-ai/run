import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { boundedCommand, driver } from '../src/computers/providers.ts';
import type { Outbound } from '../src/outbound.ts';

test('shell capture bounds both streams and preserves quoted commands and exit status', () => {
  const command = boundedCommand(`printf '%s' "quote's value"; printf '%030000d' 1 >&2; exit 7`);
  try { execFileSync('bash',['-lc',command],{encoding:'utf8'}); assert.fail('expected exit 7'); }
  catch (error: any) {
    assert.equal(error.status,7);
    assert.equal(error.stdout,"quote's value");
    assert.equal(error.stderr.length,24001);
  }
});

test('Boat uses isolated provisioning options, camelCase API fields and confirmed deletion', async () => {
  const calls: {path:string; method:string; body:any}[] = [];
  let deleted = false;
  const outbound = { async fetch(url: string, options: any) {
    const path = new URL(url).pathname, method = options.method;
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({path,method,body});
    if (method === 'DELETE') { deleted=true; return Response.json({ok:true}); }
    if (method === 'GET' && deleted) return new Response('',{status:404});
    if (path.endsWith('/commands')) return Response.json({exitCode:7,stdout:'output',stderr:'error'});
    return Response.json({sandbox:{id:'test-id',state:'ready'}});
  } } as unknown as Outbound;
  const provider=await driver('boat',{apiKey:'fake'},outbound);
  const ref=await provider.create('test',60);
  assert.deepEqual(calls[0].body,{type:'small',ttlSeconds:60,noEnv:true,snapshots:false,monitoring:false});
  const result:any=await provider.call(ref,'computer_exec',{command:'exit 7',timeoutSeconds:12});
  assert.equal(result.exitCode,7);
  assert.equal(calls[2].body.timeoutSeconds,12);
  assert.ok(calls[2].body.command.includes('exit 7'));
  await provider.close(ref);
  assert.equal(calls.at(-1)!.method,'GET');
});

test('Browser Use records allocation, limits the session and confirms stop through its browser API', async () => {
  const calls: any[] = [];
  let stopped = false;
  const outbound = { async fetch(url: string, options: any) {
    calls.push({url, ...options});
    assert.equal(options.secrets['X-Browser-Use-API-Key'], 'test-key');
    assert.equal(options.maxRedirects, 0);
    if (options.method === 'POST') return Response.json({id:'browser-id',cdpUrl:'https://example.com/cdp',status:'active'});
    if (options.method === 'PATCH') { stopped=true; return Response.json({status:'stopped'}); }
    return Response.json({status:stopped ? 'stopped' : 'active'});
  } } as unknown as Outbound;
  const provider = await driver('browser-use', {apiKey:'test-key'}, outbound);
  let allocated: unknown;
  const ref = await provider.create('camelrun-id',61, async value => { allocated=value; });
  assert.deepEqual(allocated,ref);
  assert.deepEqual(JSON.parse(calls[0].body),{timeout:2,metadata:{camelrun:'camelrun-id'},proxyCountryCode:null,enableRecording:false});
  await provider.close(ref);
  await provider.close(ref);
  assert.equal(calls.filter(c=>c.method==='PATCH').length,1);
  assert.equal(calls[2].url,'https://api.browser-use.com/api/v4/browsers/browser-id');
  assert.deepEqual(JSON.parse(calls[2].body),{action:'stop'});
});

test('Browser Use retains a created ID for cleanup even when the CDP URL is missing', async () => {
  const outbound = {fetch:async()=>Response.json({id:'allocated'})} as unknown as Outbound;
  const provider=await driver('browser-use',{apiKey:'test-key'},outbound);
  let allocated: any;
  await assert.rejects(provider.create('test',60,async ref=>{allocated=ref;}),/connection unavailable/);
  assert.equal(allocated.id,'allocated');
});


test('Browserbase uses guarded requests without SDK length headers and confirms cleanup', async () => {
  const calls: any[] = [];
  let stopped = false;
  const outbound = { async fetch(url: string, options: any) {
    calls.push({url, ...options});
    assert.equal(new Headers(options.headers).get('content-length'), null);
    assert.equal(new Headers(options.headers).get('x-bb-api-key'), null);
    assert.equal(options.secrets['X-BB-API-Key'], 'test-key');
    assert.equal(options.maxRedirects, 0);
    if (options.method === 'POST' && url.endsWith('/v1/sessions')) return Response.json({id:'session',connectUrl:'wss://example.com/cdp',status:'RUNNING'});
    if (options.method === 'POST') { stopped = true; return Response.json({id:'session',status:'COMPLETED'}); }
    return Response.json({id:'session',status:stopped ? 'COMPLETED' : 'RUNNING'});
  } } as unknown as Outbound;
  const provider = await driver('browserbase', {apiKey:'test-key'}, outbound);
  let allocated: unknown;
  const ref = await provider.create('camelrun-id', 180, async value => { allocated=value; });
  assert.deepEqual(allocated,ref);
  assert.deepEqual(JSON.parse(calls[0].body), {timeout:180,keepAlive:true,userMetadata:{camelrun:'camelrun-id'}});
  await provider.close(ref);
  assert.equal(stopped,true);
  assert.equal(calls.at(-1).method,'GET');
});
