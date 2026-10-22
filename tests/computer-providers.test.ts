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
