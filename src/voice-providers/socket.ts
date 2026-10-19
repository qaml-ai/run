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

/**
 * A provider socket's close as a failure's detail: the code, and the provider's reason (Gemini puts its error there:
 * "API key not valid", a model not found), shortened, with anything shaped like a key or token taken out.
 */
export function closeDetail(event?: { code?: number; reason?: string }): string {
  const reason = typeof event?.reason === "string" ? redactDetail(event.reason) : "";
  return `The realtime connection closed${event?.code ? ` (${event.code}${reason ? `: ${reason}` : ""})` : reason ? ` (${reason})` : ""}`;
}

/** Provider diagnostics share the socket-close redaction, including signed URLs with short signatures. */
export function redactDetail(detail: string, limit = 200, secrets: readonly string[] = []): string {
  let safe = detail.replace(/(?:https?|wss?):\/\/[^\s<>"']+/gi, "[redacted]")
    .replace(/\b(?:AIza[\w-]{8,}|sk[-_][\w-]{8,}|xai-[\w-]{8,}|ya29\.[\w.-]{8,}|[A-Za-z0-9_-]{32,})/g, "[redacted]")
    .replace(/\s+/g, " ").trim();
  for (const secret of secrets) if (secret) safe = safe.replaceAll(secret, "[redacted]");
  return safe.slice(0, limit);
}
