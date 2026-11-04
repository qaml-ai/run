import test from "node:test";
import assert from "node:assert/strict";
import { isolatedSandboxRemote } from "../codemode/routing.ts";
import { RemoteCodemodeSandbox, type CodemodeRemote } from "@earendil-works/pi-codemode/portable";

test("execution routing pins one remote through callbacks and releases admission on failure", async () => {
  const keys:string[]=[]; const ends: (()=>void)[]=[]; let id=0;
  const route=isolatedSandboxRemote({agentKey:"agent",maxConcurrent:2,executionId:()=>String(++id),getByName:key=>{
    keys.push(key);
    return {execute:async(_request,exchange)=>{
      await exchange([]); await new Promise<void>(resolve=>ends.push(resolve));
      if(key.endsWith(":2"))throw Error("remote failed");
      await exchange([]);
    }};
  }});
  const request={} as Parameters<CodemodeRemote["execute"]>[0];let callbacks=0;
  const exchange=async()=>{callbacks++;return null;};
  const first=route().execute(request,exchange),second=route().execute(request,exchange);
  await assert.rejects(route().execute(request,exchange),/concurrency limit/);
  assert.deepEqual(keys,["agent:execution:1","agent:execution:2"]);
  assert.equal(callbacks,2); await Promise.resolve();
  ends.shift()!();ends.shift()!(); await first;await assert.rejects(second,/remote failed/);
  const third=route().execute(request,exchange);await Promise.resolve();ends.shift()!();await third;
  assert.equal(callbacks,5);assert.deepEqual(keys,["agent:execution:1","agent:execution:2","agent:execution:3"]);
});

test("caller timeout keeps admission until the remote actually settles", async () => {
  let release!:()=>void;
  const stopped=new Promise<void>(resolve=>release=resolve);
  let launches=0;
  const route=isolatedSandboxRemote({agentKey:"agent",maxConcurrent:1,getByName:()=>({
    execute:async()=>{ launches++;if(launches===1)await stopped; },
  })});
  const sandbox=new RemoteCodemodeSandbox({remote:route,timeoutMs:10});
  const result=await sandbox.execute("return 1;");
  assert.equal(result.ok,false);
  if(!result.ok)assert.equal(result.error.kind,"timeout");
  await sandbox.close();
  const request={} as Parameters<CodemodeRemote["execute"]>[0];
  await assert.rejects(route().execute(request,async()=>null),/concurrency limit/);
  release();await new Promise(resolve=>setImmediate(resolve));
  await route().execute(request,async()=>null);
  assert.equal(launches,2);
});
