import { ContainerComputer } from '../../src/computers/objects.ts';
export { ContainerComputer };

// A throwaway probe of the native computer under the durable_object scheduling policy: one computer starts, runs a
// command, writes a file and snapshots; three other computer DOs then start from that snapshot at once.
type Env = { PROBE_TOKEN?: string; COMPUTERS: DurableObjectNamespace<ContainerComputer> };
const FORKS = ['fork-1', 'fork-2', 'fork-3'];
const inspect = ['sh', '-c', 'mount | grep -E " on / | on /workspace " ; echo ---; df -T / /workspace'];
export default {
  async fetch(request: Request, env: Env) {
    if (!env.PROBE_TOKEN || request.headers.get('authorization') !== `Bearer ${env.PROBE_TOKEN}`)
      return new Response('Unauthorized', { status: 401 });
    const path = new URL(request.url).pathname;
    if (request.method === 'GET' && path === '/health') return Response.json({ ok: true });
    if (request.method !== 'POST') return new Response('Not found', { status: 404 });
    const origin = env.COMPUTERS.getByName('origin');
    const all = [origin, ...FORKS.map(name => env.COMPUTERS.getByName(name))];
    if (path === '/stop') {
      await Promise.all(all.map(computer => computer.purge()));
      return Response.json({ stopped: true });
    }
    if (path !== '/run') return new Response('Not found', { status: 404 });
    const timed = async <T>(run: () => Promise<T>) => { const at = Date.now(); const value = await run(); return { ms: Date.now() - at, value }; };
    try {
      // Start: the first command includes start() and the readiness check (exec waits for a starting container).
      const start = await timed(() => origin.operate({ op: 'exec', argv: ['node', '-e', 'process.stdout.write("container-probe-ready")'], timeoutMs: 30000 }));
      await origin.operate({ op: 'write', path: 'probe.txt', content: 'synthetic-container-file' });
      const originMounts = await origin.operate({ op: 'exec', argv: inspect });
      const snapshot = await timed(() => origin.takeSnapshot('base'));
      const handle = snapshot.value;
      const forks = await timed(() => Promise.all(FORKS.map(async name => {
        const computer = env.COMPUTERS.getByName(name);
        const restore = await timed(() => computer.startFromSnapshot(handle));
        // The first command after a restore waits for the restored container: restore-to-ready.
        const read = await timed(() => computer.operate({ op: 'read', path: 'probe.txt' }));
        const mounts = await computer.operate({ op: 'exec', argv: inspect });
        return { name, startFromSnapshotMs: restore.ms, firstReadMs: read.ms, restoreToReadyMs: restore.ms + read.ms, read: read.value, mounts };
      })));
      return Response.json({ startMs: start.ms, command: start.value, originMounts, snapshotMs: snapshot.ms, snapshot: handle, forksWallMs: forks.ms, forks: forks.value });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message.slice(0, 500) : 'Native container failed' }, { status: 500 });
    } finally {
      await Promise.all(all.map(computer => computer.purge().catch(() => {})));
    }
  },
};
