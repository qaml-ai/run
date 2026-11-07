import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Boat's API as computer tests need it, on loopback: each sandbox is a real directory and its commands run in it with
 * bash, so files written by one call are read by the next. A saved snapshot copies the directory, and a sandbox made
 * `from` one starts as a copy of it: an exact fork. Commands are the test's own (its fake model's); never expose this.
 */
export async function fakeBoatServer() {
  const root = await mkdtemp(join(tmpdir(), "fake-boat-"));
  const state = {
    sandboxes: new Map<string, { dir: string; snapshots: boolean; from?: string }>(), saved: new Map<string, { dir: string; from: string }>(),
    creates: 0, snapshots: [] as string[], dropped: [] as string[], commands: [] as { sandbox: string; command: string }[], keys: new Set<string>(),
  };
  let next = 0;
  const read = async (request: IncomingMessage) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    return text ? JSON.parse(text) : {};
  };
  const run = (dir: string, command: string, timeoutSeconds: number) => new Promise<{ exitCode: number; stdout: string; stderr: string }>(resolve => {
    const child = spawn("bash", ["-c", command], { cwd: dir, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, TMPDIR: process.env.TMPDIR ?? "/tmp" } });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => stdout += chunk);
    child.stderr.on("data", chunk => stderr += chunk);
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutSeconds * 1000);
    child.on("close", code => { clearTimeout(timer); resolve({ exitCode: code ?? 124, stdout, stderr }); });
  });
  const server = createServer(async (request, response) => {
    const send = (status: number, value?: unknown) => { response.writeHead(status, { "content-type": "application/json" }); response.end(value === undefined ? "" : JSON.stringify(value)); };
    try {
      const auth = request.headers.authorization ?? "";
      if (!auth.startsWith("Bearer ") || auth.length < 8) return send(401, { code: "unauthorized" });
      state.keys.add(auth.slice(7));
      const path = new URL(request.url!, "http://boat").pathname.replace(/^\/api\/v1/, "");
      const body = request.method === "POST" || request.method === "PATCH" ? await read(request) : {};
      let match: RegExpExecArray | null;
      if (path === "/sandboxes" && request.method === "POST") {
        const id = `sbx_${++next}`, dir = join(root, id);
        if (body.from !== undefined) {
          const saved = state.saved.get(body.from);
          if (!saved) return send(404, { code: "snapshot_not_found" });
          await cp(saved.dir, dir, { recursive: true });
        } else await mkdir(dir);
        state.creates++;
        state.sandboxes.set(id, { dir, snapshots: body.snapshots !== false, ...body.from !== undefined ? { from: body.from } : {} });
        return send(201, { sandbox: { id, state: "ready" } });
      }
      if ((match = /^\/sandboxes\/([^/]+)$/.exec(path))) {
        const box = state.sandboxes.get(match[1]);
        if (!box) return send(404, { code: "not_found" });
        if (request.method === "GET") return send(200, { sandbox: { id: match[1], state: "ready" } });
        if (request.method === "PATCH") return send(200, { sandbox: { id: match[1], state: "ready" } });
        if (request.method === "DELETE") { state.sandboxes.delete(match[1]); await rm(box.dir, { recursive: true, force: true }); return send(204); }
      }
      if ((match = /^\/sandboxes\/([^/]+)\/commands$/.exec(path)) && request.method === "POST") {
        const box = state.sandboxes.get(match[1]);
        if (!box) return send(404, { code: "not_found" });
        state.commands.push({ sandbox: match[1], command: body.command });
        return send(200, await run(box.dir, String(body.command), Number(body.timeoutSeconds ?? 60)));
      }
      if (path === "/saved-snapshots" && request.method === "POST") {
        const box = state.sandboxes.get(body.sandboxId);
        if (!box) return send(404, { code: "not_found" });
        // As Boat: a sandbox made with snapshots off can never be saved.
        if (!box.snapshots) return send(409, { code: "snapshots_disabled" });
        if (typeof body.name !== "string" || state.saved.has(body.name)) return send(409, { code: "name_taken" });
        const dir = join(root, `saved-${state.saved.size + state.dropped.length + 1}`);
        await cp(box.dir, dir, { recursive: true });
        state.saved.set(body.name, { dir, from: body.sandboxId });
        state.snapshots.push(body.name);
        return send(201, { savedSnapshot: { name: body.name, status: "pending" } });
      }
      if (path === "/saved-snapshots" && request.method === "GET") return send(200, { savedSnapshots: [...state.saved.keys()].map(name => ({ name, status: "ready" })) });
      if ((match = /^\/saved-snapshots\/([^/]+)$/.exec(path))) {
        const name = decodeURIComponent(match[1]), saved = state.saved.get(name);
        if (!saved) return send(404, { code: "not_found" });
        if (request.method === "GET") return send(200, { savedSnapshot: { name, status: "ready", sizeBytes: 4096 } });
        if (request.method === "DELETE") { state.saved.delete(name); state.dropped.push(name); await rm(saved.dir, { recursive: true, force: true }); return send(204); }
      }
      send(404, { code: "not_found" });
    } catch (error) { send(500, { code: "internal", message: (error as Error).message }); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    origin: `http://127.0.0.1:${port}`, url: `http://127.0.0.1:${port}/api/v1`, state,
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); },
  };
}
