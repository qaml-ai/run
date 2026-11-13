import worker from "../src/index.ts";
import type { Env } from "../src/agent.ts";
import type { JobHostsEnv } from "../src/jobs/hosts.ts";
import type { JobSpec } from "../src/jobs/job.ts";
export * from "../src/index.ts";

export { CamelfsStub } from "./camelfs-stub.ts";

/** Test-only RPC bridge: run two distinct jobs against the exact same immutable snapshot. */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    if (new URL(request.url).pathname === "/__test/camelfs-job" && env.TEST_MODE === "1") {
      if (request.headers.get("authorization") !== `Bearer ${env.API_TOKEN}`) return new Response(null, { status: 401 });
      const spec = await request.json() as JobSpec;
      return Response.json(await (env as Env & JobHostsEnv).HOST_JOBS!.getByName(spec.id).run(spec));
    }
    if(new URL(request.url).pathname==='/__test/stored-legacy-mount'&&env.TEST_MODE==='1') {
      if(request.headers.get('authorization')!==`Bearer ${env.API_TOKEN}`)return new Response(null,{status:401});
      const {agent,volume:givenVolume}=await request.json() as {agent:string;volume?:string};
      const {Directory}=await import('../src/control.ts');
      const {withSql}=await import('../src/postgres.ts');
      const {digest}=await import('../src/api-contract.ts');
      const {canonical}=await import('../../../shared/durable-json.ts');
      const entry=await new Directory(env,'camelrun-proto-local').get(agent);
      if(!entry)return new Response(null,{status:404});
      const volume=givenVolume??`vol_${(await digest(`workspace:${agent}`)).slice(0,24)}`;
      if(!givenVolume) {
        await withSql(env,sql=>sql.query('insert into volumes(id,tenant,name,created_at) values($1,$2,$3,$4)',[volume,entry.tenantId,'Stored pilot workspace',Date.now()]));
        await env.VOLUMES.getByName(`${entry.tenantId}:${volume}`).initialize(entry.tenantId,volume,'Stored pilot workspace');
      }
      entry.config.mounts=[{volumeId:volume,path:'/workspace',mode:'rw'}];
      entry.revision++;entry.configHash=await digest(canonical(entry.config));
      await withSql(env,sql=>sql.query('update agents set header=$2,revision=$3 where id=$1',[agent,JSON.stringify(entry),entry.revision]));
      return env.AGENTS.getByName(agent).fetch(new Request('https://agent/configuration',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({...entry,runtimeOrigin:new URL(request.url).origin})}));
    }
    if(new URL(request.url).pathname==='/__test/agent-tool-file' &&env.TEST_MODE==='1') {
      if(request.headers.get('authorization')!==`Bearer ${env.API_TOKEN}`)return new Response(null,{status:401});
      const {agent,path,directory}=await request.json() as {agent:string;path:string;directory?:boolean};
      const {Directory}=await import('../src/control.ts');
      const tenant=request.headers.get('x-test-tenant')??'camelrun-proto-local';
      const entry=await new Directory(env,tenant).get(agent);
      if(!entry)return new Response(null,{status:404});
      const {ToolFiles}=await import('../src/tool-files.ts');
      const files=new ToolFiles(env,{tenant,agent,mounts:entry.config.mounts as never,tool:'test',call:'file-call',origin:new URL(request.url).origin,reference:async()=>{throw new Error('unused');},onWrite:async()=>{}});
      return Response.json(await files.send(path,!!directory,{},false));
    }
    return worker.fetch(request, env, ctx);
  },
};
