/**
 * The WebSocket the streaming speech providers speak over: Node's own (undici's), which takes headers as its second
 * argument's `headers`. Tests give a factory of their own. Only a provider's fixed address (or the operator's override)
 * is dialled, never a tenant's.
 */
export type Socket = {
  send(data: string | Uint8Array): void;
  close(code?: number): void;
  readyState: number;
  binaryType?: string;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event?: { code?: number; reason?: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
};
export type SocketFactory = (url: string, headers: Record<string, string>) => Socket;

export const openSocket: SocketFactory = (url, headers) => {
  const socket = new WebSocket(url, { headers } as never) as unknown as Socket;
  socket.binaryType = "arraybuffer";
  return socket;
};

/** A message's text: a string, or bytes as UTF-8. */
export function messageText(data: unknown): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  return String(data);
}

/** A message parsed as JSON, or undefined. */
export function messageJson(data: unknown): any {
  try { return JSON.parse(messageText(data)); } catch { return undefined; }
}

/** `http(s)://…` as `ws(s)://…`, without a trailing slash. */
export const wsBase = (base: string) => base.replace(/\/+$/, "").replace(/^http/, "ws");
