import { networkAllows, type Networking } from "../../../src/core/vault.ts";
import { Outbound as AddressGuard } from './security-outbound.ts';
import type { FetchOptions, Outbound } from './web-policy-host.ts';
import { HttpError } from './errors.ts';

type Transport = (url: string | URL, options?: RequestInit) => Promise<Response>;
type PublicOutboundOptions = { networking?: Networking; mcpHosts?: string[]; testMode?: boolean; allowHttp?: boolean; allow?: string[]; block?: string[]; transport?: Transport; resolve?: (hostname: string) => Promise<string[]> };

/** DNS is checked before every hop. Workers fetch remains the connection transport;
 * unlike the Node guard, this API cannot pin a checked DNS answer to the connection. */
export class PublicOutbound implements Outbound {
  readonly allowHttp: boolean;
  private options: PublicOutboundOptions;
  private addressPolicy: AddressGuard;
  constructor(options: PublicOutboundOptions = {}) {
    this.options = options;
    this.allowHttp = options.allowHttp ?? options.testMode === true;
    this.addressPolicy = new AddressGuard({ allowHttp: this.allowHttp,
      allow: options.allow ?? (options.testMode ? ['127.0.0.1/32', '::1/128'] : []), block: options.block,
      ...(options.resolve ? { resolve: async hostname => (await options.resolve!(hostname)).map(address => ({ address, family: address.includes(':') ? 6 : 4 })) } : {}),
    });
  }
  withoutOrigins() { return this; }
  private transport(url: string | URL, options: RequestInit = {}) { return (this.options.transport ?? fetch)(url, options); }
  async reachable(value: string | URL): Promise<URL> {
    const url = this.addressPolicy.check(value);
    if (this.options.networking && !networkAllows(this.options.networking, url, this.options.mcpHosts)) throw new HttpError(403, "Network destination is not allowed");
    // Workers DNS does not read /etc/hosts. Check localhost's loopback meaning
    // through the same address policy before handing it to the transport.
    if (/^(?:.*\.)?localhost\.?$/i.test(url.hostname)) {
      const reason = this.addressPolicy.blocked('127.0.0.1');
      if (reason) throw new HttpError(400, `${url.hostname} resolves to 127.0.0.1, ${reason}`);
      return url;
    }
    return this.addressPolicy.reachable(url);
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
