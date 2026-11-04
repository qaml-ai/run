/** Bearer-protected clone/build experiment on the actual prototype PiHarness. */
import { defineTool, type ToolRegistration } from '@earendil-works/pi-durable';
import { arr, int, obj, oneOf, opt, str } from '@earendil-works/pi-schema';
import { CamelAgent, json, type Env } from '../../src/agent.ts';
import { AgentDirectory } from '../../src/directory.ts';
import worker from '../../src/index.ts';
import { authorized } from '../../src/validation.ts';
import type { DurableObject } from 'cloudflare:workers';

type Operation = { op: string; argv?: string[]; path?: string; content?: string; name?: string; timeoutMs?: number; idleMs?: number };
type Machine = DurableObject & { operate(request: Operation): Promise<unknown> };
type BenchEnv = Env & { DIRECTORY: DurableObjectNamespace<AgentDirectory>; MACHINE: DurableObjectNamespace<Machine> };
const parameters = obj({
  op: oneOf(['start', 'exec', 'read', 'write', 'sleep', 'status', 'snapshot', 'restore', 'stop']),
  argv: opt(arr(str({maxLength:16384}), {maxItems:100, minItems:1})),
  path: opt(str({maxLength:1024})), content: opt(str({maxLength:65536})),
  name: opt(str({pattern:'^[a-zA-Z0-9_-]{1,80}$'})),
  timeoutMs: opt(int({minimum:1, maximum:1200000})), idleMs: opt(int({minimum:1000, maximum:3600000})),
});

export class CloneBuildAgent extends CamelAgent {
  constructor(ctx: DurableObjectState, env: BenchEnv) {
    // Reserve paid dispatches durably, including failures. Never expose credentials.
    const ai = new Proxy(env.AI, {get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === 'run') return async (...args: unknown[]) => {
        await ctx.storage.transaction(async tx => {
          const count = await tx.get<number>('bench:modelCalls') ?? 0;
          if (count >= 100) throw new Error('Clone/build benchmark model dispatch ceiling (100)');
          await tx.put('bench:modelCalls', count + 1);
        });
        return Reflect.apply(value, target, [args[0], {...args[1] as object, max_tokens:4096}, ...args.slice(2)]);
      };
      return typeof value === 'function' ? value.bind(target) : value;
    }});
    super(ctx, {...env, AI: ai});
  }
  protected override linuxTools(): ToolRegistration[] {
    return [defineTool({
      name:'computer', parameters, replay:'unsafe',
      description:'Provision and use your Linux computer. First call op=start, then exec with argv. Internet is enabled. Working directory /workspace. Shell syntax needs ["/bin/bash","-lc",command]. Set timeoutMs up to 1200000 for a long build. read/write are files on this same machine. snapshot/restore save the entire disk. sleep sets idleMs; status does not wake; stop destroys the running machine. Do not stop before snapshot verification.',
      execute: async request => {
        const result = await this.runComputer(request, 'agent');
        return {output:[{type:'text',text:JSON.stringify(result)}]};
      },
    })];
  }
  private async runComputer(request: Operation, source: string) {
    const seq = (await this.ctx.storage.get<number>('bench:seq') ?? 0) + 1;
    await this.ctx.storage.put('bench:seq', seq);
    const start = Date.now();
    const trace = {seq, source, request, startedAt: new Date(start).toISOString(), startedMs:start};
    await this.ctx.storage.put(`bench:call:${String(seq).padStart(5,'0')}`, trace);
    try {
      const result = await (this.env as BenchEnv).MACHINE.getByName(this.ctx.id.toString()).operate(request);
      await this.ctx.storage.put(`bench:call:${String(seq).padStart(5,'0')}`, {...trace, wallMs:Date.now()-start, result});
      return result;
    } catch(error) {
      const message = String(error instanceof Error ? error.message : error);
      await this.ctx.storage.put(`bench:call:${String(seq).padStart(5,'0')}`, {...trace, wallMs:Date.now()-start, error:message});
      throw error;
    }
  }
  override async fetch(request: Request) {
    const url = new URL(request.url);
    if (url.pathname === '/bench/trace') return json({
      modelCalls: await this.ctx.storage.get('bench:modelCalls') ?? 0,
      calls:[...(await this.ctx.storage.list({prefix:'bench:call:'})).values()],
    });
    if (url.pathname === '/bench/operate' && request.method === 'POST') {
      try { return json(await this.runComputer(await request.json() as Operation, 'operator')); }
      catch(error) { return json({error:String(error instanceof Error ? error.message : error)}, 500); }
    }
    return super.fetch(request);
  }
}
export class CloneBuildDirectory extends AgentDirectory {}
export default {
  async fetch(request: Request, env: BenchEnv) {
    if (!await authorized(request, env.API_TOKEN)) return json({error:'Unauthorized'},401);
    const url = new URL(request.url);
    const match = /^\/bench\/agents\/([A-Za-z0-9_-]+)\/(trace|operate)$/.exec(url.pathname);
    if (match) return env.AGENTS.getByName(match[1]).fetch(new Request(`https://agent/bench/${match[2]}`, request));
    return worker.fetch(request, env);
  },
} satisfies ExportedHandler<BenchEnv>;
