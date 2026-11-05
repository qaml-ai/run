import { sourceUrl } from './tool-sources.ts';
import { PublicAddressPolicy } from './public-address-policy.ts';
import { readCapped, type FetchOptions, type Outbound } from './web-policy-host.ts';
import { HttpError } from './errors.ts';

type Transport = (url: string | URL, options?: RequestInit) => Promise<Response>;
type PublicOutboundOptions = { testMode?: boolean; transport?: Transport; resolve?: (hostname: string) => Promise<string[]> };

/** DNS is checked before every hop. Workers fetch remains the connection transport;
 * unlike the Node guard, this API cannot pin a checked DNS answer to the connection. */
export class PublicOutbound implements Outbound {
  readonly allowHttp: boolean;
  private options: PublicOutboundOptions;
  private addressPolicy = new PublicAddressPolicy();
  constructor(options: PublicOutboundOptions = {}) { this.options = options; this.allowHttp = options.testMode === true; }
  withoutOrigins() { return this; }
  private transport(url: string | URL, options: RequestInit = {}) { return (this.options.transport ?? fetch)(url, options); }
  private async addresses(hostname: string): Promise<string[]> {
    if (this.options.resolve) return this.options.resolve(hostname);
    const records = await Promise.all(['A', 'AAAA'].map(async type => {
      const url = new URL('https://cloudflare-dns.com/dns-query'); url.searchParams.set('name', hostname); url.searchParams.set('type', type);
      const response = await fetch(url, { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(3000), redirect: 'manual' });
      if (!response.ok) throw new HttpError(502, 'Public DNS lookup failed');
      const value = JSON.parse(new TextDecoder().decode(await readCapped(response, 64 * 1024))) as { Status?: number; Answer?: { type: number; data: string }[] };
      if (value.Status !== 0) throw new HttpError(400, 'Public DNS lookup returned no address');
      return (value.Answer ?? []).filter(answer => answer.type === 1 || answer.type === 28).map(answer => answer.data);
    }));
    return records.flat();
  }
  async reachable(value: string | URL): Promise<URL> {
    const url = sourceUrl(String(value), { TEST_MODE: this.allowHttp ? '1' : undefined });
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (this.allowHttp && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(host)) return url;
    if (!host.includes('.') || /(^|\.)(localhost|local|internal|localdomain|home|lan)$/.test(host)) throw new HttpError(400, 'Private host names are not allowed');
    const addresses = await this.addresses(host);
    if (!addresses.length || addresses.some(address => this.addressPolicy.blocked(address))) throw new HttpError(400, 'Host does not resolve exclusively to public addresses');
    return url;
  }
  async fetch(input: string | URL, options: FetchOptions = {}): Promise<Response> {
    const { secrets, timeoutMs = 30_000, maxBytes = 4 * 1024 * 1024, maxRedirects = 0, signal, ...init } = options;
    const timeout = AbortSignal.timeout(timeoutMs), aborted = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let current = await this.reachable(input), method = (init.method ?? 'GET').toUpperCase(), body = init.body;
    const origin = current.origin;
    for (let hops = 0; ; hops++) {
      if (hops) current = await this.reachable(current);
      const headers = new Headers(init.headers);
      if (current.origin === origin) for (const [name, value] of Object.entries(secrets ?? {})) headers.set(name, value);
      let response: Response;
      try { response = await this.transport(current, { ...init, method, body, headers, redirect: 'manual', signal: aborted }); }
      catch (error) { if (timeout.aborted && !signal?.aborted) throw new Error(`No response within ${timeoutMs} ms`); throw error; }
      const location = response.headers.get('location');
      if (response.status >= 300 && response.status < 400 && location) {
        await response.body?.cancel();
        if (hops >= maxRedirects) throw new HttpError(400, 'Too many outbound redirects');
        current = new URL(location, current);
        if (response.status === 303 || ([301, 302].includes(response.status) && method === 'POST')) { method = 'GET'; body = undefined; }
        continue;
      }
      let bytes = 0;
      const limited = response.body?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) {
        bytes += chunk.byteLength;
        if (bytes > maxBytes) throw new HttpError(413, `Response larger than ${maxBytes} bytes`);
        controller.enqueue(chunk);
      } }));
      return Object.defineProperty(new Response(limited, { status: response.status, statusText: response.statusText, headers: response.headers }), 'url', { value: current.href });
    }
  }
}
