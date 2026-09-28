/** Node/Bun convenience entry. The portable SDK itself imports no Node modules. */
import { openAsBlob } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { writeDurableJson } from "../shared/durable-json.ts";
import { Agents as PortableAgents, AgentRuntime as PortableAgentRuntime, memoryJournalStore, type AgentsOptions, type RuntimeOptions as PortableRuntimeOptions, type Journal, type JournalStore } from "./typescript.ts";
export * from "./typescript.ts";
export interface RuntimeOptions extends PortableRuntimeOptions { stateDirectory?: string }

/** A forwarded header's first value (a proxy chain lists one per hop, the client's first). */
const forwarded = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value)?.split(",")[0].trim() || undefined;

/**
 * A fetch-style handler (e.g. `serveTools(...)`) as a `node:http` request listener:
 * `createServer(nodeListener(serveTools(tools, { runtime })))`. Identity tokens are checked against
 * the URL the runtime called, which this rebuilds from the request: behind a proxy or load balancer
 * that ends TLS, from its X-Forwarded-Proto and X-Forwarded-Host. `origin` pins it to your public URL instead.
 */
export function nodeListener(handler: (request: Request) => Promise<Response>, options: { origin?: string } = {}) {
  return async (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => {
    try {
      const protocol = forwarded(req.headers["x-forwarded-proto"]) ?? ((req.socket as { encrypted?: boolean }).encrypted ? "https" : "http");
      const origin = options.origin ?? `${protocol === "https" ? "https" : "http"}://${forwarded(req.headers["x-forwarded-host"]) ?? req.headers.host ?? "localhost"}`;
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
/** Errors that say the directory cannot be written here (a read-only serverless filesystem, say). */
const UNWRITABLE = new Set(["EROFS", "EACCES", "EPERM"]);
/**
 * Keep each agent's event cursor in a file under `directory`, so a restarted process resumes its stream.
 * Where the directory cannot be written (read-only serverless filesystems), it keeps them in memory
 * instead, with one warning: the cursor only spares a restarted client a snapshot.
 */
export function fileJournalStore(directory: string): JournalStore {
  const root = resolve(directory);
  const path = (id: string) => {
    if (!/^client_[a-f0-9]{40}$/.test(id)) throw new Error("Invalid journal session id");
    return join(root, `${id}.json`);
  };
  let memory: JournalStore | undefined;
  const unwritable = (error: unknown) => {
    if (!UNWRITABLE.has((error as NodeJS.ErrnoException).code ?? "")) return false;
    if (!memory) process.emitWarning(`Cannot write the agent SDK's state to ${root} (${(error as NodeJS.ErrnoException).code}); keeping it in memory. Set stateDirectory to a writable directory to keep it across restarts.`);
    memory ??= memoryJournalStore();
    return true;
  };
  return {
    async load(id) {
      if (memory) return memory.load(id);
      try { return JSON.parse(await readFile(path(id), "utf8")) as Journal; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" || unwritable(error)) return undefined; throw error; }
    },
    async save(id, journal) {
      if (!memory) {
        try { writeDurableJson(path(id), journal); return; }
        catch (error) { if (!unwritable(error)) throw error; }
      }
      await memory!.save(id, journal);
    },
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

/**
 * `Agents` for Node: local file paths attach as files. `stateDirectory` keeps each agent's event
 * cursor on disk (default: memory; a run's result never depends on it).
 */
export class Agents extends PortableAgents {
  constructor(options: AgentsOptions & { stateDirectory?: string } = {}) {
    const { stateDirectory, ...rest } = options;
    super({ ...rest, openFile: rest.openFile ?? (path => openAsBlob(path)), ...(stateDirectory && !rest.journalStore ? { journalStore: fileJournalStore(stateDirectory) } : {}) });
  }
}
