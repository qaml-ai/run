import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

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
  private port: number;
  private inspectorPort = 0;
  private storage: string;
  private config: string;
  private readyToken: string;
  private listener?: Server;
  private sockets = new Set<Socket>();
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
    this.inspectorPort = await unusedPort();
    const env = {
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
    this.child = spawn(
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
    this.child.on("message", (message: unknown) => {
      const direct = message as { type?: string; port?: number };
      if (direct.type === "workerd" && Number.isInteger(direct.port)) directPort = direct.port;
    });
    this.listener = createServer(socket => {
      if (!directPort) { socket.destroy(); return; }
      const upstream = createConnection(directPort, "127.0.0.1");
      for (const connection of [socket, upstream]) {
        this.sockets.add(connection);
        connection.on("close", () => this.sockets.delete(connection));
        connection.on("error", () => { socket.destroy(); upstream.destroy(); });
      }
      socket.pipe(upstream).pipe(socket);
    });
    await new Promise<void>((resolve, reject) => {
      this.listener!.once("error", reject);
      this.listener!.listen(this.port, "127.0.0.1", resolve);
    });
    const save = (data: Buffer) => {
      this.output = (this.output + data.toString()).slice(-16_000);
    };
    this.child.stdout!.on("data", save);
    this.child.stderr!.on("data", save);
    for (let attempt = 0; attempt < 480; attempt++) {
      if (this.child.exitCode !== null || this.child.signalCode !== null)
        throw new Error(`workerd exited: ${this.output}`);
      try {
        const response = await fetch(`${this.url}/healthz`, {
          headers: { authorization: `Bearer ${this.readyToken}` },
          signal: AbortSignal.timeout(1000),
        });
        if (response.ok) return;
      } catch {}
      await delay(250);
    }
    throw new Error(`workerd never became ready: ${this.output}`);
  }
  async stop(hard = false) {
    const child = this.child;
    this.child = undefined;
    for (const socket of this.sockets) socket.destroy();
    if (this.listener) {
      await new Promise<void>(resolve => this.listener!.close(() => resolve()));
      this.listener = undefined;
    }
    if (!child || child.exitCode !== null) return;
    const done = once(child, "exit");
    try {
      process.kill(-child.pid!, hard ? "SIGKILL" : "SIGTERM");
    } catch {}
    await Promise.race([done, delay(3000)]);
    if (child.exitCode === null) {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {}
      await Promise.race([done, delay(1000)]);
    }
  }
  async heap() {
    const targets = (await (
      await fetch(`http://127.0.0.1:${this.inspectorPort}/json/list`)
    ).json()) as { webSocketDebuggerUrl: string }[];
    const socket = new WebSocket(
      targets[0].webSocketDebuggerUrl.replace(
        /ws:\/\/[^/]+/,
        `ws://127.0.0.1:${this.inspectorPort}`,
      ),
    );
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = reject;
    });
    let next = 0;
    const call = (method: string) =>
      new Promise<Record<string, number>>((resolve, reject) => {
        const id = ++next;
        const timer = setTimeout(
          () => reject(new Error(`Inspector timeout: ${method}`)),
          5000,
        );
        socket.onmessage = (event) => {
          const message = JSON.parse(String(event.data));
          if (message.id !== id) return;
          clearTimeout(timer);
          if (message.error) reject(new Error(JSON.stringify(message.error)));
          else resolve(message.result);
        };
        socket.send(JSON.stringify({ id, method }));
      });
    try {
      await call("Runtime.enable");
      return await call("Runtime.getHeapUsage");
    } finally {
      socket.close();
    }
  }
  logs() {
    return this.output;
  }
}
