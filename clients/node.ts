/** Node/Bun convenience entry. The portable SDK itself imports no Node modules. */
import { openAsBlob } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { writeDurableJson } from "../shared/durable-json.ts";
import { AgentRuntime as PortableAgentRuntime, type RuntimeOptions as PortableRuntimeOptions, type Journal, type JournalStore } from "./typescript.ts";
export * from "./typescript.ts";
export interface RuntimeOptions extends PortableRuntimeOptions { stateDirectory?: string }

/**
 * A fetch-style handler (e.g. `serveTools(...)`) as a `node:http` request listener:
 * `createServer(nodeListener(serveTools(tools, { runtime })))`. `origin` is your public URL when the
 * server is behind a proxy (tokens are checked against it); by default the request's Host.
 */
export function nodeListener(handler: (request: Request) => Promise<Response>, options: { origin?: string } = {}) {
  return async (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => {
    try {
      const origin = options.origin ?? `http://${req.headers.host ?? "localhost"}`;
      const controller = new AbortController();
      res.on("close", () => { if (!res.writableFinished) controller.abort(); });
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      const chunks: Buffer[] = [];
      if (req.method !== "GET" && req.method !== "HEAD") for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = chunks.length ? new Uint8Array(Buffer.concat(chunks)) : undefined;
      const response = await handler(new Request(new URL(req.url ?? "/", origin), { method: req.method, headers, body, signal: controller.signal }));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(response.body ? Buffer.from(await response.arrayBuffer()) : undefined);
    } catch (error) {
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(error).slice(0, 500) }));
    }
  };
}
export function fileJournalStore(directory: string): JournalStore {
  const root = resolve(directory);
  const path = (id: string) => {
    if (!/^client_[a-f0-9]{40}$/.test(id)) throw new Error("Invalid journal session id");
    return join(root, `${id}.json`);
  };
  return {
    async load(id) {
      try { return JSON.parse(await readFile(path(id), "utf8")) as Journal; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    },
    async save(id, journal) { writeDurableJson(path(id), journal); },
  };
}
export class AgentRuntime extends PortableAgentRuntime {
  constructor(options: RuntimeOptions = {}) {
    super({ ...options, url: options.url ?? process.env.AGENT_URL, openFile: options.openFile ?? (path => openAsBlob(path)),
      apiKey: options.apiKey ?? process.env.AGENT_RUNTIME_TOKEN,
      journalStore: options.journalStore ?? fileJournalStore(options.stateDirectory ?? process.env.AGENT_CLIENT_STATE_DIR ?? ".agent-runtime/client-sdk"),
    });
  }
}
