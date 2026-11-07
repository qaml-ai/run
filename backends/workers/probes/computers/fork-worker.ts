import { ContainerComputer } from '../../src/computers/objects.ts';
export { ContainerComputer };

// A throwaway probe of computer fork on real Cloudflare Containers (durable_object scheduling policy), through the
// runtime's own ContainerComputer and its fork RPCs (src/computers/native-fork.ts): a parent computer gets a ~1 GB
// workspace, one forkSnapshot serves a batch, and five child computers are seeded from it and start from it at once.
type Env = { PROBE_TOKEN?: string; COMPUTER_CONTAINERS: DurableObjectNamespace<ContainerComputer> };
const CHILDREN = ['child-1', 'child-2', 'child-3', 'child-4', 'child-5'];
const BATCH = 'probe:m1';
const sh = (command: string, timeoutMs = 300_000) => ({ op: 'exec' as const, argv: ['bash', '-lc', command], timeoutMs });
// 1 GiB of incompressible data in 1,024 files, plus 20,000 small files (the shape of node_modules).
const WORKSPACE = [
  'set -e; mkdir -p /workspace/data /workspace/small',
  'for i in $(seq 1 1024); do head -c 1048576 /dev/urandom > /workspace/data/f$i; done',
  'for d in $(seq 1 200); do mkdir -p /workspace/small/d$d; for f in $(seq 1 100); do echo "module $d/$f" > /workspace/small/d$d/m$f.js; done; done',
  'echo parent-marker > /workspace/marker',
  'sha256sum /workspace/data/f512 | cut -d" " -f1 > /workspace/f512.sha',
  'du -sb /workspace | cut -f1; find /workspace -type f | wc -l; cat /workspace/f512.sha',
].join('; ');
const timed = async <T>(run: () => Promise<T>) => { const at = Date.now(); const value = await run(); return { ms: Date.now() - at, value }; };
const pct = (values: number[], p: number) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]; };

export default {
  async fetch(request: Request, env: Env) {
    if (!env.PROBE_TOKEN || request.headers.get('authorization') !== `Bearer ${env.PROBE_TOKEN}`) return new Response('Unauthorized', { status: 401 });
    const path = new URL(request.url).pathname;
    if (request.method === 'GET' && path === '/health') return Response.json({ ok: true });
    if (request.method !== 'POST') return new Response('Not found', { status: 404 });
    const parent = env.COMPUTER_CONTAINERS.getByName('parent');
    const children = CHILDREN.map(name => ({ name, computer: env.COMPUTER_CONTAINERS.getByName(name) }));
    try {
      if (path === '/stop') {
        await Promise.all([parent, ...children.map(child => child.computer)].map(computer => computer.purge()));
        return Response.json({ stopped: true });
      }
      if (path === '/prepare') {
        const start = await timed(() => parent.operate(sh('true', 60_000)));
        const workspace = await timed(() => parent.operate(sh(WORKSPACE)));
        return Response.json({ startMs: start.ms, workspaceMs: workspace.ms, workspace: workspace.value });
      }
      if (path === '/fork') {
        // One snapshot for the batch; asking again (a second child of the same call) reuses it.
        const snapshot = await timed(() => parent.forkSnapshot(BATCH));
        if (!snapshot.value.ok) return Response.json({ error: snapshot.value }, { status: 409 });
        const reused = await timed(() => parent.forkSnapshot(BATCH));
        const handle = snapshot.value.snapshot, at = Date.now();
        const seeded = await timed(() => Promise.all(children.map(child => child.computer.seed(handle, { parent: parent.id.toString(), agent: 'probe-parent', batch: BATCH, at }))));
        // Restore to first command, each child at once: the fork call's visible latency.
        const firsts = await timed(() => Promise.all(children.map(async child => {
          const first = await timed(() => child.computer.operate(sh('cat /workspace/marker; sha256sum /workspace/data/f512 | cut -d" " -f1; df -T / | tail -1', 120_000)));
          return { name: child.name, firstCommandMs: first.ms, result: first.value as Record<string, any> };
        })));
        // Writes stay in their own machine: each child writes its own file; nobody else sees it.
        await Promise.all(children.map(child => child.computer.operate(sh(`echo ${child.name} > /workspace/${child.name}.txt; echo changed > /workspace/marker`))));
        const seen = await Promise.all([{ name: 'parent', computer: parent }, ...children].map(async each => ({ name: each.name, value: await each.computer.operate(sh('cat /workspace/marker; ls /workspace | grep -c "^child-" || true')) as Record<string, any> })));
        const ms = firsts.value.map(each => each.firstCommandMs);
        return Response.json({
          snapshotMs: snapshot.ms, snapshot: handle, reusedMs: reused.ms, reusedSame: reused.value.ok && reused.value.snapshot.id === handle.id,
          seedAllMs: seeded.ms, firstCommandAllMs: firsts.ms, firstCommandP50Ms: pct(ms, 0.5), firstCommandP95Ms: pct(ms, 0.95), children: firsts.value, seen,
          forkedFrom: await children[0].computer.forkedFrom(),
        });
      }
      return new Response('Not found', { status: 404 });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message.slice(0, 800) : 'Probe failed' }, { status: 500 });
    }
  },
};
