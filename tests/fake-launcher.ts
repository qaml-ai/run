import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SandboxKind } from "../src/sandbox.ts";
import { v8ExecBinary } from "../src/v8-exec.ts";

type Context = { after: (fn: () => unknown) => void };

/** A frame as sandbox-wire.ts writes it. */
export const frame = (message: unknown) => {
  const body = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
};

/**
 * agent-launcher's sockets (sandbox/launcher.c) as the runtime sees them, without its confinement: for
 * each connection to `v8.sock` or `parse.sock`, a v8-exec or parse-job process with the connection as
 * its stdin and stdout, and when it ends, how, as a last frame. `intercept` may take a connection
 * instead, returning true. AGENT_SANDBOX_DIR points at it for the rest of the test.
 */
export async function fakeLauncher(t: Context, intercept?: (kind: SandboxKind, socket: Socket) => boolean | void) {
  // Short: unix socket paths are limited to about 100 bytes.
  const dir = await mkdtemp(join(tmpdir(), "sbx-"));
  const pids = new Set<number>();
  const started: Record<SandboxKind, number> = { v8: 0, parse: 0 };
  const sockets = new Set<Socket>();
  const servers = await Promise.all((["v8", "parse"] as const).map(async kind => {
    // Paused: the connection's bytes are the process's to read.
    const server = createServer({ pauseOnConnect: true }, socket => {
      socket.on("error", () => {});
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      if (intercept?.(kind, socket)) return;
      started[kind]++;
      const [command, args] = kind === "v8" ? [v8ExecBinary(), ["--jitless", "--max-data-mb", "512"]]
        : [process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", fileURLToPath(new URL("../src/parse-job.ts", import.meta.url))]];
      const child = spawn(command, args, { stdio: [socket, socket, kind === "v8" ? "ignore" : "inherit"], env: {} });
      if (child.pid) pids.add(child.pid);
      child.once("exit", (code, signal) => {
        pids.delete(child.pid!);
        socket.end(frame({ type: "exit", ...(signal ? { signal } : { code }) }));
      });
    });
    server.listen(join(dir, `${kind}.sock`));
    await once(server, "listening");
    return server;
  }));
  const previous = process.env.AGENT_SANDBOX_DIR;
  process.env.AGENT_SANDBOX_DIR = dir;
  t.after(async () => {
    if (previous === undefined) delete process.env.AGENT_SANDBOX_DIR; else process.env.AGENT_SANDBOX_DIR = previous;
    for (const pid of pids) try { process.kill(pid, "SIGKILL"); } catch {}
    for (const socket of sockets) socket.destroy();
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  return { dir, pids, started };
}
