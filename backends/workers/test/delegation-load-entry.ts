/** Local-only instrumentation; no deployment config references this entrypoint. */
import application from '../src/index.ts';
import { CamelAgent as RuntimeAgent } from '../src/agent.ts';
import { testAgentRuntimes } from '../src/agent-internals.ts';
import type { Env } from '../src/agent.ts';
export * from '../src/index.ts';
export class CamelAgent extends RuntimeAgent {
  counts = { childFetches: 0, activeFetches: 0, maxActiveFetches: 0, eventStreams: 0, alarmFires: 0 };
  private rpcCounts: { total: number; active: number; peak: number; methods: Record<string, number> };
  constructor(ctx: DurableObjectState, env: Env) {
    const counts = { total: 0, active: 0, peak: 0, methods: {} as Record<string, number> };
    const agents = new Proxy(env.AGENTS, { get(target, name) {
      if (name !== 'getByName') { const value = Reflect.get(target, name); return typeof value === 'function' ? value.bind(target) : value; }
      return (id: string) => {
        const stub = target.getByName(id);
        return new Proxy(stub, { get(target, name) {
          const value = Reflect.get(target, name);
          if (typeof value !== 'function') return value;
          return async (...args: any[]) => {
            const method = name === 'fetch' && args[0] instanceof Request ? `${args[0].method} ${new URL(args[0].url).pathname.replace(/\/requests\/.*/, '/requests/:id')}` : String(name);
            counts.methods[method] = (counts.methods[method] ?? 0) + 1;
            counts.total++; counts.peak = Math.max(counts.peak, ++counts.active);
            try { return await Reflect.apply(value, target, args); } finally { counts.active--; }
          };
        } });
      };
    } });
    super(ctx, { ...env, AGENTS: agents });
    this.rpcCounts = counts;
  }
  private instrumented = false;
  async fetch(request: Request) {
    if (!this.instrumented) {
      this.instrumented = true;
      const runtime = testAgentRuntimes.get(this)!;
      const host = (runtime.delegation as any).host;
      const fetch = host.fetch.bind(host);
      host.fetch = async (id: string, request: Request) => {
        this.counts.childFetches++;
        if (new URL(request.url).pathname.includes('/events')) this.counts.eventStreams++;
        this.counts.maxActiveFetches = Math.max(this.counts.maxActiveFetches, ++this.counts.activeFetches);
        try { return await fetch(id, request); } finally { this.counts.activeFetches--; }
      };
      const alarm = this.alarm?.bind(this);
      if (alarm) Object.defineProperty(this, "alarm", { configurable: true, value: async (...args: Parameters<typeof alarm>) => { this.counts.alarmFires++; return alarm(...args); } });

    }
    return super.fetch(request);
  }
  async loadProfile() {
    const runtime = testAgentRuntimes.get(this)!;
    const children = await runtime.delegation.children();
    return { childStateBytes: new TextEncoder().encode(JSON.stringify(children)).byteLength, childPayloadBytes: children.reduce((sum, child) => sum + (child.payloadBytes ?? 0), 0), ...this.counts, rpc: this.rpcCounts, nextAlarm: await this.ctx.storage.getAlarm(), ...runtime.delegation.measurements, children: children.map(child => child.status) };
  }
}
export default {
  ...application,
  async fetch(request: Request, env: Env, context: ExecutionContext) {
    const match = /^\/__test\/delegation\/([^/]+)$/.exec(new URL(request.url).pathname);
    if (env.TEST_MODE === '1' && match) return Response.json(await (env.AGENTS.getByName(match[1]) as any).loadProfile());
    return application.fetch(request, env, context);
  },
};
