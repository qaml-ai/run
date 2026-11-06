import { ContainerComputer } from '../../src/computers/objects.ts';
export { ContainerComputer };

type Env = { PROBE_TOKEN?: string; COMPUTERS: DurableObjectNamespace<ContainerComputer> };
export default {
  async fetch(request: Request, env: Env) {
    if (!env.PROBE_TOKEN || request.headers.get('authorization') !== `Bearer ${env.PROBE_TOKEN}`)
      return new Response('Unauthorized', { status: 401 });
    if (request.method === 'GET' && new URL(request.url).pathname === '/health') return Response.json({ ok: true });
    if (request.method !== 'POST') return new Response('Not found', { status: 404 });
    const computer = env.COMPUTERS.getByName('single-bounded-probe');
    if (new URL(request.url).pathname === '/stop') {
      await computer.operate({ op: 'sleep' });
      return Response.json({ stopped: true });
    }
    if (new URL(request.url).pathname !== '/run') return new Response('Not found', { status: 404 });
    const started = Date.now();
    const run = async () => {
      try {
        const command = await computer.operate({ op: 'exec', argv: ['node', '-e', 'process.stdout.write("container-probe-ready")'], timeoutMs: 30000 });
        await computer.operate({ op: 'write', path: 'probe.txt', content: 'synthetic-container-file' });
        const read = await computer.operate({ op: 'read', path: 'probe.txt' });
        return Response.json({ command, read, elapsedMs: Date.now() - started });
      } finally { await computer.operate({ op: 'sleep' }); }
    };
    return run().catch(error => Response.json({ error: error instanceof Error ? error.message.slice(0, 500) : 'Native container failed' }, { status: 500 }));
  },
};
