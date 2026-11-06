import { HttpError } from '../errors.ts';
import { PROVIDERS, boundedCommand, output, type ComputerDriver, type Credentials, type Provider } from './policy.ts';
import { boundedResponse, microvmDriver, testEndpoint, type Fetcher, type MicrovmBindings } from './microvm.ts';
import type { ComputerBindings } from './tool.ts';

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
      async create(id) { await namespace.getByName(id).operate({ op: 'exec', argv: ['true'] }); return { id }; },
      call: (ref, _op, args) => namespace.getByName(ref.id).operate({ op: 'exec', argv: ['bash', '-lc', args.command], timeoutMs: Math.min(args.timeoutSeconds * 1000, 30_000) }),
      async close(ref) { await namespace.getByName(ref.id).operate({ op: 'sleep' }); },
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
