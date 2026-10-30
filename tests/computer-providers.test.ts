import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { boundedCommand, driver } from '../src/computers/providers.ts';
import { Outbound } from '../src/outbound.ts';
import { ClientError, Status } from 'nice-grpc';
import { DaytonaAuthenticationError, DaytonaForbiddenError, DaytonaNotFoundError } from '@daytona/sdk';
import { AuthenticationError, SandboxError } from 'e2b';
import Browserbase from '@browserbasehq/sdk';
import { listen } from './runtime-server.ts';

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

test('Sprites uses HTTP create, bounded exec and idempotent deletion', async t => {
  const calls: {path:string; method:string; body:string}[] = [];
  let deleted = false, status = 200, incomplete = false;
  const url = await listen(t, async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const path = new URL(req.url!, 'http://localhost');
    calls.push({path:path.pathname, method:req.method!, body});
    assert.equal(req.headers.authorization, 'Bearer test-org/test-id/test-token/fake');
    if (status !== 200) { res.writeHead(status).end('private provider error'); return; }
    if (req.method === 'DELETE') { res.writeHead(deleted ? 404 : 204).end(); deleted = true; return; }
    if (path.pathname.endsWith('/exec')) {
      assert.equal(path.searchParams.get('stdin'), 'true');
      assert.equal(req.headers['content-type'], 'application/octet-stream');
      const [file, ...args] = path.searchParams.getAll('cmd');
      assert.equal(file, 'python3');
      const stdout = execFileSync(file, args, {input:body});
      // Coalesced frames, including an extra stdout frame within the JSON payload.
      res.end(Buffer.concat([Buffer.from([1]), stdout.subarray(0, 7), Buffer.from([1]), stdout.subarray(7), incomplete ? Buffer.alloc(0) : Buffer.from([3, 0])]));
      return;
    }
    res.writeHead(201, {'Content-Type':'application/json'}).end(JSON.stringify({id:'opaque-provider-id',name:JSON.parse(body).name}));
  });
  const transport = new Outbound({allowHttp:true, allow:['127.0.0.1/32']});
  t.after(() => transport.dispatcher.close());
  const outbound = {fetch: (input: string, options: any) => {
    const target = new URL(input);
    assert.equal(target.origin, 'https://api.sprites.dev');
    assert.equal(options.maxRedirects, 0);
    assert.equal(options.maxBytes, 2 * 1024 * 1024);
    assert.equal(options.timeoutMs, target.pathname.endsWith('/exec') ? 135000 : 30000);
    return transport.fetch(url + target.pathname + target.search, options);
  }} as Outbound;
  const provider = await driver('sprites', {apiKey:'test-org/test-id/test-token/fake'}, outbound);
  let allocated: unknown;
  const ref = await provider.create('_CMP_Test/Name_', 60, async value => { allocated = value; });
  assert.deepEqual(ref, {id:'cmp-test-name'});
  assert.deepEqual(allocated, ref);
  assert.deepEqual(calls[0], {path:'/v1/sprites', method:'POST', body:'{"name":"cmp-test-name"}'});
  const command = `printf '%s' "quote's value ☃"; printf '\\001error\\003' >&2; exit 7`;
  assert.deepEqual(await provider.call(ref, 'computer_exec', {command, timeoutSeconds:12}), {exitCode:7, stdout:"quote's value ☃", stderr:'\x01error\x03', truncated:false});
  assert.equal(calls[1].body, boundedCommand(command));
  const long: any = await provider.call(ref, 'computer_exec', {command:"printf '%030000d' 1; printf '%030000d' 1 >&2"});
  assert.deepEqual(long, {exitCode:0, stdout:'0'.repeat(24000), stderr:'0'.repeat(24000), truncated:true});
  const timed: any = await provider.call(ref, 'computer_exec', {command:'sleep 5', timeoutSeconds:1});
  assert.equal(timed.exitCode, 124);
  incomplete = true;
  await assert.rejects(provider.call(ref, 'computer_exec', {command:'true'}), /response incomplete/);
  await provider.close(ref);
  await provider.close(ref);
  assert.deepEqual(calls.slice(-2).map(c => [c.method, c.path]), [['DELETE','/v1/sprites/cmp-test-name'], ['DELETE','/v1/sprites/cmp-test-name']]);
  status = 503;
  await assert.rejects(provider.create('error', 60), {message:'Computer provider HTTP 503'});
  await assert.rejects(provider.close(ref), {message:'Computer provider HTTP 503'});
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

test('each driver knows a credentials refusal from other failures', async () => {
  for (const provider of ['sprites', 'boat', 'tunnel', 'browser-use'] as const) {
    let status = 401;
    const outbound = { async fetch() { return new Response('', { status }); } } as unknown as Outbound;
    const value = await driver(provider, { apiKey: 'fake', url: 'https://runner.example' }, outbound);
    for (const [code, refused] of [[401, true], [403, true], [404, false], [429, false], [500, false], [503, false]] as const) {
      status = code;
      const error = await value.create('cmp_x', 60).then(() => undefined, failure => failure);
      assert.ok(error, `${provider} ${code}`);
      assert.equal(error.message, code === 404 && provider === 'browser-use' ? 'Browser creation did not return an ID' : `Computer provider HTTP ${code}`);
      assert.equal(value.refused!(error), refused, `${provider} ${code}`);
    }
    assert.equal(value.refused!(new Error('Computer provider HTTP 401')), false, 'a message alone is not a status');
  }
  const none = {} as Outbound;
  const daytona = await driver('daytona', { apiKey: 'fake' }, none);
  assert.equal(daytona.refused!(new DaytonaAuthenticationError('no')), true);
  assert.equal(daytona.refused!(new DaytonaForbiddenError('no')), true);
  assert.equal(daytona.refused!(new DaytonaNotFoundError('no')), false);
  assert.equal(daytona.refused!(new Error('401')), false);
  const e2b = await driver('e2b', { apiKey: 'fake' }, none);
  assert.equal(e2b.refused!(new AuthenticationError('no')), true);
  assert.equal(e2b.refused!(Object.assign(new SandboxError('403: no'), { statusCode: 403 })), true);
  assert.equal(e2b.refused!(Object.assign(new SandboxError('500: no'), { statusCode: 500 })), false);
  const modal = await driver('modal', { tokenId: 'fake', tokenSecret: 'fake' }, none);
  assert.equal(modal.refused!(new ClientError('/x', Status.UNAUTHENTICATED, 'no')), true);
  assert.equal(modal.refused!(new ClientError('/x', Status.PERMISSION_DENIED, 'no')), true);
  assert.equal(modal.refused!(new ClientError('/x', Status.UNAVAILABLE, 'no')), false);
  await modal.dispose?.();
  const browserbase = await driver('browserbase', { apiKey: 'fake' }, none);
  assert.equal(browserbase.refused!(new Browserbase.AuthenticationError(401, undefined, 'no', new Headers() as any)), true);
  assert.equal(browserbase.refused!(new Browserbase.PermissionDeniedError(403, undefined, 'no', new Headers() as any)), true);
  assert.equal(browserbase.refused!(new Browserbase.InternalServerError(500, undefined, 'no', new Headers() as any)), false);
});
