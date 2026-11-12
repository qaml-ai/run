import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { observeWorkerExit } from "./local-worker-exit.ts";

const directory = fileURLToPath(new URL("../", import.meta.url));
const token = "local-integration-only-token-with-at-least-32-characters";
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function unusedPort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

export class LocalWorker {
  readonly url: string;
  private child?: ChildProcess;
  private output = "";
  logLimit = 16_000;
  /** src/alarm-guard.ts's lines, all of them. */
  alarmLines: string[] = [];
  private port: number;
  private inspectorPort = 0;
  private storage: string;
  private config: string;
  private readyToken: string;
  private stopping = false;
  private ready = false;
  private listener?: Server;
  private sockets = new Set<Socket>();
  private cancelListen?: () => void;
  constructor(
    port: number,
    storage: string,
    config = "wrangler.test.jsonc",
    readyToken = token,
  ) {
    this.config = config;
    this.readyToken = readyToken;
    this.port = port;
    this.storage = storage;
    this.url = `http://127.0.0.1:${port}`;
  }
  async start() {
    this.stopping = false;
    this.ready = false;
    this.inspectorPort = await unusedPort();
    if (this.stopping) throw new Error("Local Worker startup was cancelled");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CI: "1",
      WRANGLER_SEND_METRICS: "false",
      // Production returns early refusals without waiting for the upload.
      WRANGLER_DISABLE_REQUEST_BODY_DRAINING: "true",
      WRANGLER_LOG_PATH: join(this.storage, "logs"),
      CLOUDFLARE_DEV_REGISTRY_PATH: join(this.storage, "registry"),
    };
    // Model tests must not accidentally fall back to a configured cloud account.
    for (const key of [
      "CLOUDFLARE_API_TOKEN",
      "CLOUDFLARE_API_KEY",
      "CLOUDFLARE_ACCOUNT_ID",
    ])
      delete env[key];
    const proxyPort = await unusedPort();
    if (this.stopping) throw new Error("Local Worker startup was cancelled");
    const child = this.child = spawn(
      process.execPath,
      ["test/local-worker-process.mjs", this.config, String(proxyPort), String(this.inspectorPort), this.storage],
      {
        cwd: directory,
        env,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        detached: true,
      },
    );
    this.output = "";
    let directPort: number | undefined;
    child.on("message", (message: unknown) => {
      const direct = message as { type?: string; port?: number };
      if (direct.type === "workerd" && Number.isInteger(direct.port)) directPort = direct.port;
    });
    const listener = this.listener = createServer(socket => {
      if (!directPort) { socket.destroy(); return; }
      const upstream = createConnection(directPort, "127.0.0.1");
      for (const connection of [socket, upstream]) {
        this.sockets.add(connection);
        connection.on("close", () => this.sockets.delete(connection));
        connection.on("error", () => { socket.destroy(); upstream.destroy(); });
      }
      // A graceful FIN still permits an HTTP response. A disconnected client
      // needs a TCP reset so workerd cancels a request before its headers exist.
      socket.once("close", () => {
        if (!upstream.destroyed) upstream.resetAndDestroy();
      });
      socket.pipe(upstream).pipe(socket);
    });
    let output = "";
    const save = (data: Buffer) => {
      output = (output + data.toString()).slice(-this.logLimit);
      // The alarm guard's lines are kept whole, past the log limit: a test fails on one (fixture.ts alarmFindings).
      for (const line of data.toString().match(/\{"type":"alarm_(?:hot_loop|rearm_due)"[^\n]*/g) ?? []) this.alarmLines.push(line);
      this.output = output;
    };
    child.stdout!.on("data", save);
    child.stderr!.on("data", save);
    const exited = observeWorkerExit(child, () => output);
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        listener.off("error", failed);
        this.cancelListen = undefined;
        if (error) reject(error); else resolve();
      };
      const failed = (error: Error) => finish(error);
      this.cancelListen = () => finish(new Error("Local Worker startup was cancelled"));
      listener.once("error", failed);
      void exited.then(finish);
      listener.listen(this.port, "127.0.0.1", () => finish());
    });
    // A cold native-computer fixture builds its image before workerd can answer health checks.
    for (let attempt = 0; attempt < 1200; attempt++) {
      if (this.stopping) throw new Error("Local Worker startup was cancelled");
      if (child.exitCode !== null || child.signalCode !== null)
        throw await exited;
      try {
        const response = await fetch(`${this.url}/healthz`, {
          headers: { authorization: `Bearer ${this.readyToken}` },
          signal: AbortSignal.timeout(1000),
        });
        if (response.ok) { this.ready = true; return; }
      } catch {}
      await delay(250);
    }
    throw new Error(`workerd never became ready: ${this.output}`);
  }
  async stop(hard = false) {
    this.stopping = true;
    this.cancelListen?.();
    const child = this.child;
    this.child = undefined;
    const listener = this.listener;
    this.listener = undefined;
    const wasReady = this.ready;
    this.ready = false;
    if (!hard && wasReady && child?.pid && listener?.listening) {
      try {
        // Only the contract entrypoint implements this endpoint. Other local
        // Workers return 404; crashes deliberately skip the graceful drain.
        const response = await fetch(`${this.url}/__test/drain`, {
          method: "POST",
          headers: { authorization: `Bearer ${this.readyToken}` },
          signal: AbortSignal.timeout(15_000),
        });
        await response.body?.cancel();
      } catch { /* A crashed worker still needs its process group cleaned up. */ }
    }
    for (const socket of this.sockets) socket.destroy();
    const listenerClosed = new Promise<void>(resolve => {
      if (!listener) return resolve();
      const timer = setTimeout(resolve, 1000);
      const close = () => listener.close(() => { clearTimeout(timer); resolve(); });
      // A stop can race the asynchronous bind. Close again if it finishes
      // after the first close reports that the server is not listening yet.
      if (!listener.listening) listener.once("listening", close);
      close();
    });
    if (!child?.pid) return listenerClosed;
    // The wrangler parent may have exited while its detached workerd/esbuild
    // group remains. Always stop the owned group, including that case. Do it
    // before waiting on the listener so a stalled bind cannot delay cleanup.
    const alive = () => { try { process.kill(-child.pid!, 0); return true; } catch { return false; } };
    try {
      process.kill(-child.pid!, hard ? "SIGKILL" : "SIGTERM");
    } catch {}
    const deadline = Date.now() + (hard ? 1000 : 3000);
    while (alive() && Date.now() < deadline) await delay(50);
    if (alive()) {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {}
      const killedDeadline = Date.now() + 1000;
      while (alive() && Date.now() < killedDeadline) await delay(50);
    }
    await listenerClosed;
  }
  /** Invoke Wrangler's local Cron Trigger; the real scheduled handler does the work. */
  async scheduled() {
    const response = await fetch(`${this.url}/cdn-cgi/local/scheduled`, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Local scheduled handler failed: ${response.status}`);
    await response.arrayBuffer();
  }
  /** One inspector connection avoids retaining a new debugger session per sample. */
  async heapSampler() {
    const targets = await (await fetch(`http://127.0.0.1:${this.inspectorPort}/json/list`)).json() as { webSocketDebuggerUrl: string }[];
    const socket = new WebSocket(targets[0].webSocketDebuggerUrl.replace(/ws:\/\/[^/]+/, `ws://127.0.0.1:${this.inspectorPort}`));
    await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = reject; });
    let next = 0;
    return {
      read: () => new Promise<Record<string, number>>((resolve, reject) => {
        const id = ++next;
        const timer = setTimeout(() => reject(new Error('Inspector timeout: Runtime.getHeapUsage')), 30_000);
        socket.onmessage = event => {
          const message = JSON.parse(String(event.data));
          if (message.id !== id) return;
          clearTimeout(timer);
          if (message.error) reject(new Error(JSON.stringify(message.error))); else resolve(message.result);
        };
        socket.send(JSON.stringify({ id, method: 'Runtime.getHeapUsage' }));
      }),
      close: () => socket.close(),
    };
  }
  async heap() {
    const sampler = await this.heapSampler();
    try { return await sampler.read(); } finally { sampler.close(); }
  }
  logs() {
    return this.output;
  }
  alarmLogs() {
    return this.alarmLines.join("\n");
  }
}
