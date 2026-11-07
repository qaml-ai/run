import { HttpError } from '../errors.ts';
import { PROVIDERS, boundedCommand, output, type ComputerDriver, type Credentials, type Provider } from './policy.ts';
import { boundedResponse, microvmDriver, testEndpoint, type Fetcher, type MicrovmBindings } from './microvm.ts';
import type { ComputerBindings } from './tool.ts';
import { payerSetup } from './meter.ts';
import { snapshotHandle, type ComputerSnapshot } from './provider.ts';
import type { SnapshotRef } from '../../../../src/core/computer-fork.ts';

export const BOAT_API = 'https://boat.dev/api/v1';
/** How long a Boat saved snapshot may take to be ready (9.6 s measured for a 1.7 GB workspace). */
const SAVED_SNAPSHOT_MS = 180_000;
/**
 * Boat's saved snapshots, as src/computers/providers.ts' `boatSnapshots`: an exact snapshot of a running machine (it
 * keeps running), which new machines are made from. Boat's `/fork` copies a background snapshot up to a minute stale.
 */
export function boatSnapshots(request: (path: string, body?: unknown, method?: string, allowMissing?: boolean) => Promise<any>) {
  return {
    async snapshot(sandbox: string, name: string): Promise<SnapshotRef> {
      await request('/saved-snapshots', { sandboxId: sandbox, name });
      for (const until = Date.now() + SAVED_SNAPSHOT_MS; ; await new Promise(resolve => setTimeout(resolve, 1000))) {
        const value = await request(`/saved-snapshots/${encodeURIComponent(name)}`, undefined, 'GET', true);
        const saved = value?.savedSnapshot ?? value?.snapshot ?? value;
        if (saved?.status === 'ready') return { provider: 'boat', id: name, createdAt: Date.now(), ...Number.isSafeInteger(saved.sizeBytes) ? { sizeBytes: saved.sizeBytes } : {} };
        if (saved?.status === 'failed' || saved?.status === 'error') throw new Error('Computer snapshot failed');
        if (Date.now() > until) throw new Error('Computer snapshot did not finish in time');
      }
    },
    async drop(snapshot: SnapshotRef) { await request(`/saved-snapshots/${encodeURIComponent(snapshot.id)}`, undefined, 'DELETE', true); },
  };
}
/** A container snapshot as a computer DO starts from it. */
const containerHandle = (ref: SnapshotRef): ComputerSnapshot => snapshotHandle({ id: ref.id, name: 'fork', size: ref.sizeBytes ?? 0, image: ref.image, createdAt: ref.createdAt, expiresAt: ref.expiresAt ?? ref.createdAt + 30 * 86_400_000 });

export type RemoteBindings = ComputerBindings & MicrovmBindings & {
  TEST_COMPUTER_ENDPOINT?: string;
  COMPUTER_TUNNEL_HOSTS?: string;
  /** A Worker service that hosts an optional provider SDK which cannot run in workerd. */
  COMPUTER_PROVIDER_GATEWAY?: FetcherService;
};
type FetcherService = { fetch(request: Request): Promise<Response> };
class ProviderHttpError extends Error {
  readonly status: number;
  constructor(status: number) { super(`Computer provider HTTP ${status}`); this.status = status; }
}
export function remoteDriver(env: RemoteBindings, tenant: string, agent: string, provider: Provider | 'container', credentials: Credentials, send: Fetcher = request => fetch(request)): ComputerDriver {
  if (provider !== 'container' && !PROVIDERS.includes(provider)) throw new HttpError(400, 'Unsupported computer provider');
  if (provider === 'lambda') return microvmDriver(env, tenant, send);
  if (provider === 'container') {
    const namespace = env.COMPUTER_CONTAINERS;
    if (!namespace) throw new HttpError(503, 'Cloudflare Containers are not configured');
    return {
      async create(id, _seconds, _allocated, options) {
        const computer = namespace.getByName(id), setup = payerSetup({ tenant, agent });
        // A fork's session starts from the snapshot: the handle is plain data any computer DO can start from.
        if (options?.from) await computer.startFromSnapshot(containerHandle(options.from), setup);
        else await computer.operate({ op: 'exec', argv: ['true'] }, setup);
        return { id };
      },
      call: (ref, _op, args) => namespace.getByName(ref.id).operate({ op: 'exec', argv: ['bash', '-lc', args.command], timeoutMs: Math.min(args.timeoutSeconds * 1000, 120_000) }, payerSetup({ tenant, agent })),
      async snapshot(ref, label) {
        const taken = await namespace.getByName(ref.id).takeSnapshot(label.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80), payerSetup({ tenant, agent }));
        return { provider: 'container', id: taken.id, image: taken.image, sizeBytes: taken.size, createdAt: taken.createdAt, expiresAt: taken.expiresAt };
      },
      // Cloudflare has no Worker API to delete a snapshot; it expires 30 days after its latest restore.
      async dropSnapshot() {},
      async close(ref) { await namespace.getByName(ref.id).purge(); },
    };
  }
  const fake = testEndpoint(env.TEST_COMPUTER_ENDPOINT, env);
  if (provider === 'tunnel' && !fake && !(env.COMPUTER_TUNNEL_HOSTS ?? '').split(',').map(value => value.trim().toLowerCase()).includes(new URL(credentials.url).hostname.toLowerCase()))
    throw new HttpError(503, 'Tunnel host is not approved by the runtime');
  const request = async (url: string, method: string, body?: unknown, raw = false, extra: Record<string, string> = {}, allowMissing = false) => {
    const target = new URL(url);
    if (fake) { target.protocol = fake.protocol; target.host = fake.host; }
    const response = await send(new Request(target, { method, headers: { Authorization: `Bearer ${credentials.apiKey}`,
      'Content-Type': raw ? 'application/octet-stream' : 'application/json', ...extra },
      ...(body === undefined ? {} : { body: raw ? String(body) : JSON.stringify(body) }), redirect: 'manual', signal: AbortSignal.timeout(raw ? 135_000 : 30_000) }));
    const text = await boundedResponse(response);
    if (response.status === 404 && (method === 'DELETE' || allowMissing)) return null;
    if (!response.ok) throw new ProviderHttpError(response.status);
    return raw ? text : text ? JSON.parse(text) : {};
  };
  const common = { refused: (error: unknown) => error instanceof ProviderHttpError && [401, 403].includes(error.status) };
  if (provider === 'e2b') {
    const options = { apiKey: credentials.apiKey, ...(fake ? { apiUrl: fake.origin, sandboxUrl: fake.origin } : {}) };
    return {
      refused: error => (error as Error)?.name === 'AuthenticationError' || Number((error as { statusCode?: number })?.statusCode) === 403,
      async create(id, seconds, allocated) {
        const { Sandbox } = await import('e2b');
        const sandbox = await Sandbox.create({ ...options, timeoutMs: seconds * 1000, secure: true, metadata: { camelrun: id } });
        const ref = { id: sandbox.sandboxId }; await allocated?.(ref); return ref;
      },
      async call(ref, _op, args) {
        const { Sandbox, CommandExitError } = await import('e2b');
        const seconds = Number(args.timeoutSeconds);
        const sandbox = await Sandbox.connect(ref.id, { ...options, timeoutMs: Math.max(1, Number(args.remainingSeconds ?? seconds)) * 1000 });
        try { const value = await sandbox.commands.run(boundedCommand(String(args.command)), { timeoutMs: seconds * 1000 }); return output(value.exitCode, value.stdout, value.stderr); }
        catch (error) { if (error instanceof CommandExitError) return output(error.exitCode, error.stdout, error.stderr); throw error; }
      },
      async close(ref) {
        const { Sandbox, NotFoundError } = await import('e2b');
        try { await Sandbox.kill(ref.id, options); } catch (error) { if (!(error instanceof NotFoundError)) throw error; }
      },
    };
  }

  if (provider === 'sprites') {
    const base = 'https://api.sprites.dev/v1/sprites';
    return { ...common,
      async create(id, _seconds, allocated) {
        const name = id.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 63).replace(/^-+|-+$/g, '') || 'camelrun';
        const value = await request(base, 'POST', { name });
        if (value.name !== name) throw new Error('Computer creation did not return its name');
        const ref = { id: name }; await allocated?.(ref); return ref;
      },
      async call(ref, _op, args) {
        const seconds = Number(args.timeoutSeconds), command = boundedCommand(String(args.command));
        const script = `import json,subprocess,sys; r=subprocess.run(["timeout","-k","1","${seconds}s","bash","-lc",sys.stdin.read()],capture_output=True); print(json.dumps({"code":r.returncode,"stdout":r.stdout.decode("utf-8","replace"),"stderr":r.stderr.decode("utf-8","replace")}))`;
        const query = new URLSearchParams([['cmd','python3'],['cmd','-c'],['cmd',script],['stdin','true']]);
        const text = await request(`${base}/${encodeURIComponent(ref.id)}/exec?${query}`, 'POST', command, true);
        if (text.charCodeAt(0) !== 1 || text.charCodeAt(text.length - 2) !== 3 || text.charCodeAt(text.length - 1) !== 0) throw new Error('Computer exec response incomplete');
        const result = JSON.parse(text.slice(1, -2).replaceAll('\x01', ''));
        if (!Number.isInteger(result.code) || typeof result.stdout !== 'string' || typeof result.stderr !== 'string') throw new Error('Invalid computer exec response');
        return output(result.code, result.stdout, result.stderr);
      },
      async close(ref) { await request(`${base}/${encodeURIComponent(ref.id)}`, 'DELETE'); },
    };
  }
  if (provider === 'tunnel') return { ...common,
    async create(id, _seconds, allocated) { const value = await request(`${credentials.url.replace(/\/$/, '')}/claim`, 'POST', { claim: id }); if (typeof value.id !== 'string') throw new Error('Invalid computer reference'); const ref = { id: value.id, claim: id }; await allocated?.(ref); return ref; },
    async call(ref, _op, args) { const value = await request(`${credentials.url.replace(/\/$/, '')}/exec`, 'POST', { claim: ref.claim, key: args.requestKey, command: boundedCommand(String(args.command)), timeout: args.timeoutSeconds }); if (value.error) throw new Error('Remote command outcome uncertain'); return output(value.exit_code, value.stdout, value.stderr); },
    async close(ref) { await request(`${credentials.url.replace(/\/$/, '')}/close`, 'POST', { claim: ref.claim }); },
  };
  if (provider === 'daytona') return { ...common,
    async create(id, seconds, allocated) {
      let value = await request('https://app.daytona.io/api/sandbox', 'POST', { name: id, language: 'python', ephemeral: true, autoStopInterval: Math.ceil(seconds / 60) });
      if (typeof value.id !== 'string') throw new Error('Invalid computer reference');
      const ref = { id: value.id }; await allocated?.(ref);
      for (let attempt = 0; attempt < 60; attempt++) {
        if (value.state === 'started') return ref;
        if (['error','build_failed','destroyed'].includes(value.state)) throw new Error('Computer did not start');
        await new Promise(resolve => setTimeout(resolve, 1000));
        value = await request(`https://app.daytona.io/api/sandbox/${encodeURIComponent(ref.id)}`, 'GET');
      }
      throw new Error('Computer startup timed out');
    },
    async call(ref, _op, args) { const value = await request(`https://proxy.app.daytona.io/toolbox/${encodeURIComponent(ref.id)}/process/execute`, 'POST', { command: boundedCommand(String(args.command)), timeout: args.timeoutSeconds }); return output(value.exitCode, value.result); },
    async close(ref) {
      const url = `https://app.daytona.io/api/sandbox/${encodeURIComponent(ref.id)}`;
      await request(url, 'DELETE');
      for (let attempt = 0; attempt < 60; attempt++) {
        const value = await request(url, 'GET', undefined, false, {}, true);
        if (!value || value.state === 'destroyed') return;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      throw new Error('Computer cleanup not confirmed');
    },
  };
  if (provider === 'boat') {
    // Boat's API (src/computers/providers.ts' driver, the same calls): saved snapshots make exact forks.
    const boat = async (path: string, body?: unknown, method = 'POST', allowMissing = false) =>
      request(`${BOAT_API}${path}`, method, body, false, method === 'DELETE' && path.startsWith('/sandboxes/') ? { 'X-ASCII-Confirm-Delete': path.split('/').at(-1)! } : {}, allowMissing);
    const saved = boatSnapshots(boat);
    return { ...common,
      async create(_id, seconds, allocated, options) {
        const value = await boat('/sandboxes', { type: 'small', ttlSeconds: seconds, noEnv: true, snapshots: true, monitoring: false, ...options?.from ? { from: options.from.id } : {} });
        const ref = { id: value.sandbox.id as string };
        await allocated?.(ref);
        for (const until = Date.now() + 60_000; Date.now() < until; await new Promise(resolve => setTimeout(resolve, 1000))) {
          const info = await boat(`/sandboxes/${ref.id}`, undefined, 'GET');
          if (['ready', 'idle', 'running'].includes(info.sandbox?.state)) return ref;
        }
        await boat(`/sandboxes/${ref.id}`, undefined, 'DELETE');
        throw new Error('Computer startup timed out');
      },
      async call(ref, _op, args) {
        const value = await boat(`/sandboxes/${ref.id}/commands`, { command: boundedCommand(String(args.command)), timeoutSeconds: Number(args.timeoutSeconds ?? 60) });
        return output(value.exitCode, value.stdout ?? '', value.stderr ?? '');
      },
      snapshot: (ref, label) => saved.snapshot(ref.id, label),
      dropSnapshot: snapshot => saved.drop(snapshot),
      async close(ref) {
        await boat(`/sandboxes/${ref.id}`, undefined, 'DELETE');
        for (const until = Date.now() + 30_000; Date.now() < until; await new Promise(resolve => setTimeout(resolve, 1000)))
          if (await boat(`/sandboxes/${ref.id}`, undefined, 'GET', true) === null) return;
        throw new Error('Computer cleanup not confirmed');
      },
    };
  }
  // A service binding keeps optional provider SDKs out of the agent isolate; no public URL can
  // turn the gateway into an arbitrary credential-forwarding proxy.
  const gateway = env.COMPUTER_PROVIDER_GATEWAY;
  if (!gateway) throw new HttpError(503, `${provider} provider transport is not configured`);
  const invoke = async (op: string, args: unknown) => {
    const response = await gateway.fetch(new Request('https://computer-provider.internal/operation', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider, credentials, tenant, agent, op, args }) }));
    const text = await boundedResponse(response);
    if (!response.ok) throw new ProviderHttpError(response.status);
    return JSON.parse(text);
  };
  return { ...common,
    async create(id, seconds, allocated) { const ref = await invoke('create', { id, seconds }); if (typeof ref.id !== 'string') throw new Error('Invalid computer reference'); await allocated?.(ref); return ref; },
    call: (ref, operation, args) => invoke('call', { ref, operation, args }),
    async close(ref) { await invoke('close', { ref }); },
  };
}
