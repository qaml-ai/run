import type { DecisionProvider } from "./decision-policy.ts";
import { openrouterDecisions } from "./decision-providers.ts";
import { HttpError } from "./errors.ts";

export function decisionProvider(options: { provider?: DecisionProvider; testUrl?: string; testMode?: boolean }): DecisionProvider {
  if (options.provider) return options.provider;
  const base = options.testUrl ?? 'https://openrouter.ai/api/alpha';
  const url = new URL(base);
  if (options.testUrl && !(options.testMode && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new HttpError(400, 'A decision fixture must be loopback HTTP');
  return openrouterDecisions({ baseUrl: base, outbound: { async fetch(url, options) {
    const { secrets, timeoutMs, maxBytes = 1024 * 1024, ...init } = options;
    const signal = AbortSignal.any([...(init.signal ? [init.signal] : []), AbortSignal.timeout(timeoutMs ?? 10_000)]);
    const response = await fetch(url, { ...init, signal, redirect: 'manual', headers: { ...Object.fromEntries(new Headers(init.headers)), ...secrets } });
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new HttpError(502, 'Decision endpoint redirects are not allowed'); }
    if (Number(response.headers.get('content-length') ?? 0) > maxBytes) { await response.body?.cancel(); throw new HttpError(502, 'Decision response is too large'); }
    const reader = response.body?.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
    try {
      if (reader) for (;;) { const next = await reader.read(); if (next.done) break; bytes += next.value.byteLength; if (bytes > maxBytes) throw new HttpError(502, 'Decision response is too large'); chunks.push(next.value); }
    } finally { await reader?.cancel().catch(() => {}); }
    const data = new Uint8Array(bytes); let offset = 0; for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
    return new Response(data, { status: response.status, headers: response.headers });
  } } });
}
