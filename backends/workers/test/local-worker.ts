import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
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
  private stopping = false;
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
    this.inspectorPort = await unusedPort();
    if (this.stopping) throw new Error("Local Worker startup was cancelled");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CI: "1",
      WRANGLER_SEND_METRICS: "false",
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
    const child = this.child = spawn(
      process.execPath,
      [
        "node_modules/wrangler/bin/wrangler.js",
        "dev",
        "--local",
        "--config",
        this.config,
        "--config",
        "codemode/wrangler.jsonc",
        "--ip",
        "127.0.0.1",
        "--port",
        String(this.port),
        "--inspector-port",
        String(this.inspectorPort),
        "--persist-to",
        this.storage,
      ],
      {
        cwd: directory,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      },
    );
    this.output = "";
    const save = (data: Buffer) => {
      this.output = (this.output + data.toString()).slice(-16_000);
    };
    child.stdout!.on("data", save);
    child.stderr!.on("data", save);
    for (let attempt = 0; attempt < 480; attempt++) {
      if (this.stopping) throw new Error("Local Worker startup was cancelled");
      if (child.exitCode !== null || child.signalCode !== null)
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
    this.stopping = true;
    const child = this.child;
    this.child = undefined;
    if (!child?.pid) return;
    // The wrangler parent may have exited while its detached workerd/esbuild
    // group remains. Always stop the owned group, including that case.
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
