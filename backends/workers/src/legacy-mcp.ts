type RpcMessage = { jsonrpc: string; id?: string; method: string; params?: unknown };
type Fetch = (url: string, init: RequestInit) => Promise<Response>;
/** Older SSE servers get an isolated session per operation, closed after the reply. */
export async function legacyMcpRequest(url: string, message: RpcMessage, headers: Record<string, string>, fetcher: Fetch, signal: AbortSignal, notification: boolean, onMessage: (message: any) => void) {
  const closed = new AbortController(), aborted = AbortSignal.any([closed.signal, signal]);
  const pending = new Map<string, { resolve(value: any): void; reject(error: unknown): void }>();
  let endpointResolve!: (endpoint: string) => void, endpointReject!: (error: unknown) => void;
  const endpoint = new Promise<string>((resolve, reject) => { endpointResolve = resolve; endpointReject = reject; });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const fail = (error: unknown) => { endpointReject(error); for (const waiter of pending.values()) waiter.reject(error); pending.clear(); };
  const cancel = () => fail(aborted.reason ?? new Error('MCP stream closed'));
  aborted.addEventListener('abort', cancel, { once: true });
  try {
    const response = await fetcher(url, { method: 'GET', headers: { ...headers, Accept: 'text/event-stream' }, signal: aborted });
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(`Legacy MCP source answered HTTP ${response.status}`); }
    reader = response.body.getReader();
    const input = reader;
    void (async () => {
      let buffer = ''; const decoder = new TextDecoder();
      try {
        for (;;) {
          const next = await input.read(); if (next.done) throw new Error('Legacy MCP stream ended before its reply');
          buffer += decoder.decode(next.value, { stream: true });
          if (buffer.length > 1024 * 1024) throw new Error('Legacy MCP frame exceeds its byte limit');
          for (;;) {
            const match = /\r?\n\r?\n/.exec(buffer); if (!match) break;
            const frame = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length);
            const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
            const event = frame.split(/\r?\n/).find(line => line.startsWith('event:'))?.slice(6).trim();
            if (event === 'endpoint') {
              const target = new URL(data, url); if (target.origin !== new URL(url).origin) throw new Error('MCP SSE endpoint may not change origin');
              endpointResolve(target.href);
            } else if (data) {
              const value = JSON.parse(data); onMessage(value);
              if (value.id !== undefined) { pending.get(String(value.id))?.resolve(value); pending.delete(String(value.id)); }
            }
          }
        }
      } catch (error) { if (!closed.signal.aborted) fail(error); }
    })();
    const target = await endpoint;
    const send = async (request: RpcMessage, notify = false) => {
      const answer = notify ? undefined : new Promise<any>((resolve, reject) => pending.set(String(request.id), { resolve, reject }));
      void answer?.catch(() => {});
      try {
        const sent = await fetcher(target, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal: aborted });
        await sent.body?.cancel(); if (!sent.ok) throw new Error(`Legacy MCP source answered HTTP ${sent.status}`);
        return await answer;
      } catch (error) { pending.delete(String(request.id)); throw error; }
    };
    if (message.method !== 'initialize') {
      const init = await send({ jsonrpc: '2.0', id: crypto.randomUUID(), method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'agent-runtime', version: '1.0.0' } } });
      if (init.error) throw new Error(init.error.message ?? 'MCP initialization failed');
      await send({ jsonrpc: '2.0', method: 'notifications/initialized' }, true);
    }
    return await send(message, notification);
  } finally {
    closed.abort(); aborted.removeEventListener('abort', cancel);
    await reader?.cancel().catch(() => {});
  }
}
