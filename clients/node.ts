/** Node/Bun convenience entry. The portable SDK itself imports no Node modules. */
import { once } from "node:events";
import { openAsBlob } from "node:fs";
import { Agents as PortableAgents, AgentRuntime as PortableAgentRuntime, type AgentsOptions, type RuntimeOptions } from "./typescript.ts";
export * from "./typescript.ts";

/** A forwarded header's first value (a proxy chain lists one per hop, the client's first). */
const forwarded = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value)?.split(",")[0].trim() || undefined;

/**
 * A fetch-style handler (e.g. `serveTools(...)`) as a `node:http` request listener:
 * `createServer(nodeListener(serveTools(tools, { runtime, tenant }), { origin: "https://tools.example.com" }))`.
 * Identity tokens are checked against the URL the runtime called. Set `origin` to your public URL; without
 * it the URL is this server's own (its socket's scheme and the Host header). Behind a proxy that ends TLS,
 * set `origin`, or `trustProxy: true` to read X-Forwarded-Proto and X-Forwarded-Host, but only where the
 * proxy overwrites those headers: otherwise any client could choose the URL tokens are checked against.
 */
export function nodeListener(handler: (request: Request) => Promise<Response>, options: { origin?: string; trustProxy?: boolean } = {}) {
  return async (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => {
    try {
      const proxied = (name: string) => options.trustProxy ? forwarded(req.headers[name]) : undefined;
      const protocol = proxied("x-forwarded-proto") ?? ((req.socket as { encrypted?: boolean }).encrypted ? "https" : "http");
      const origin = options.origin ?? `${protocol === "https" ? "https" : "http"}://${proxied("x-forwarded-host") ?? req.headers.host ?? "localhost"}`;
      const controller = new AbortController();
      res.on("close", () => { if (!res.writableFinished) controller.abort(); });
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      const chunks: Buffer[] = [];
      if (req.method !== "GET" && req.method !== "HEAD") for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = chunks.length ? new Uint8Array(Buffer.concat(chunks)) : undefined;
      const response = await handler(new Request(new URL(req.url ?? "/", origin), { method: req.method, headers, body, signal: controller.signal }));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (!response.body) { res.end(); return; }
      // Streamed as it comes, so an event stream reaches its client as it is written.
      res.flushHeaders();
      const reader = response.body.getReader();
      res.on("close", () => { void reader.cancel().catch(() => {}); });
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!res.write(value)) await once(res, "drain");
      }
      res.end();
    } catch (error) {
      // A body that fails partway cannot become an error answer: the connection is cut, so the client sees it failed.
      if (res.headersSent) { res.destroy(); return; }
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(error).slice(0, 500) }));
    }
  };
}
export class AgentRuntime extends PortableAgentRuntime {
  constructor(options: RuntimeOptions = {}) {
    super({ ...options, url: options.url ?? process.env.AGENT_URL, openFile: options.openFile ?? (path => openAsBlob(path)),
      apiKey: options.apiKey ?? process.env.AGENT_RUNTIME_TOKEN,
    });
  }
}

/** `Agents` for Node: local file paths attach as files. */
export class Agents extends PortableAgents {
  constructor(options: AgentsOptions = {}) {
    super({ ...options, openFile: options.openFile ?? (path => openAsBlob(path)) });
  }
}
