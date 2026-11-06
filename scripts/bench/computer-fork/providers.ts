// Provider adapters for the fork benchmark. Each one creates a source machine,
// makes it forkable, forks it, runs commands, stops/wakes and deletes machines.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

export type Result = { code: number; stdout: string; stderr: string };
export type Machine = { id: string; name: string; [k: string]: unknown };
export interface Provider {
  name: string;
  /** Workspace root inside a machine. */
  ws: string;
  create(name: string): Promise<Machine>;
  exec(m: Machine, cmd: string, timeoutSec?: number): Promise<Result>;
  /** Make the source forkable; returns the handle forks start from. */
  prepareFork(source: Machine, label: string): Promise<unknown>;
  fork(handle: unknown, name: string): Promise<Machine>;
  /** Stop then wake; returns what the provider calls each phase. */
  stopWake?(m: Machine): Promise<{ stopMs: number; wakeMs: number; note: string }>;
  destroy(m: Machine): Promise<void>;
  /** Names of machines (and snapshots) still present that start with the prefix. */
  leftovers(prefix: string): Promise<string[]>;
  cleanupHandle?(handle: unknown): Promise<void>;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const run = (cmd: string, args: string[], input?: string, timeoutSec = 900) =>
  new Promise<Result>(resolve => {
    const child = execFile(cmd, args, { maxBuffer: 64 << 20, timeout: timeoutSec * 1000 }, (error, stdout, stderr) =>
      resolve({ code: error ? (typeof (error as any).code === "number" ? (error as any).code : 1) : 0, stdout: String(stdout), stderr: String(stderr) }));
    if (input !== undefined) { child.stdin?.end(input); }
  });

// ---------------------------------------------------------------- Boat
export function boat(mode: "stop" | "saved" | "live" = "stop", type = "default"): Provider {
  const key = process.env.BOAT_API_KEY ?? readFileSync(`${homedir()}/.config/boat/key`, "utf8").trim();
  const base = "https://boat.dev/api/v1";
  const api = async (path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) => {
    for (let attempt = 0; ; attempt++) {
      const r = await fetch(base + path, { method, headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await r.text(); let json: any = {}; try { json = JSON.parse(text); } catch {}
      if (r.ok) return json;
      const code = json?.error?.code ?? json?.code ?? text.slice(0, 200);
      const retry = r.status === 429 || r.status === 502 || r.status === 503 || (r.status === 409 && /sandbox_starting|sandbox_resuming|idempotency_in_progress/.test(String(code)));
      if (retry && attempt < 60) { await sleep(r.status === 429 ? 5000 : 1000); continue; }
      if (method === "GET" && r.status === 404) return null;
      throw new Error(`boat ${method} ${path} -> ${r.status} ${JSON.stringify(code)}`);
    }
  };
  const state = async (id: string) => (await api(`/sandboxes/${id}`))?.sandbox?.state as string | undefined;
  const waitState = async (id: string, want: string[], limitSec = 600) => {
    for (const until = Date.now() + limitSec * 1000; Date.now() < until; await sleep(500)) { const s = await state(id); if (s && want.includes(s)) return s; if (s === "error") throw new Error(`boat ${id} error`); }
    throw new Error(`boat ${id} never reached ${want}`);
  };
  const ready = ["ready", "idle", "running"];
  const made = new Set<string>();
  const self: Provider = {
    name: `boat-${mode}`, ws: "/home/user/ws",
    async create(name) {
      const r = await api("/sandboxes", "POST", { type, ttlSeconds: 7200, name }, { "Idempotency-Key": `cfork-${name}-${Date.now()}` });
      made.add(r.sandbox.id); return { id: r.sandbox.id, name };
    },
    async exec(m, cmd, timeoutSec = 600) {
      const r = await api(`/sandboxes/${m.id}/commands`, "POST", { command: cmd, timeoutSeconds: Math.min(600, timeoutSec) });
      return { code: r.exitCode ?? (r.timedOut ? 124 : 1), stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    },
    async prepareFork(source, label) {
      if (mode === "live") return source.id;
      if (mode === "stop") { await api(`/sandboxes/${source.id}/stop`, "POST", {}); await waitState(source.id, ["archived"]); return source.id; }
      const name = `cfork-${label}`;
      await api("/saved-snapshots", "POST", { sandboxId: source.id, name });
      for (;; await sleep(1000)) { const s = await api(`/saved-snapshots/${encodeURIComponent(name)}`); const st = s?.savedSnapshot?.status ?? s?.snapshot?.status ?? s?.status; if (st === "ready") return { saved: name }; if (st === "failed" || st === "error") throw new Error(`saved snapshot ${st}`); }
    },
    async fork(handle, name) {
      const headers = { "Idempotency-Key": `cfork-${name}-${Date.now()}` };
      const r = typeof handle === "string"
        ? await api(`/sandboxes/${handle}/fork`, "POST", { ttlSeconds: 3600, name }, headers)
        : await api("/sandboxes", "POST", { from: (handle as any).saved, ttlSeconds: 3600, name }, headers);
      made.add(r.sandbox?.id ?? r.id); return { id: r.sandbox?.id ?? r.id, name };
    },
    async stopWake(m) {
      let t = Date.now(); await api(`/sandboxes/${m.id}/stop`, "POST", {}); await waitState(m.id, ["archived"]); const stopMs = Date.now() - t;
      t = Date.now(); await api(`/sandboxes/${m.id}/resume`, "POST", { ttlSeconds: 3600 }); await waitState(m.id, ready); const wakeMs = Date.now() - t;
      return { stopMs, wakeMs, note: "boat stop (disk snapshot, machine released) then resume on a new machine" };
    },
    async destroy(m) {
      await api(`/sandboxes/${m.id}`, "DELETE", undefined, { "X-ASCII-Confirm-Delete": m.id }).catch(e => { if (!/404/.test(String(e))) throw e; });
      for (let i = 0; i < 60 && (await api(`/sandboxes/${m.id}`)) !== null; i++) await sleep(1000);
    },
    async leftovers(prefix) {
      const r = await api("/sandboxes?limit=100");
      const saved = await api("/saved-snapshots").catch(() => null);
      return [...(r?.sandboxes ?? []).filter((s: any) => String(s.name ?? "").startsWith(prefix) || made.has(s.id)).map((s: any) => `${s.id}:${s.name}:${s.state}`),
        ...((saved?.savedSnapshots ?? saved?.snapshots ?? []) as any[]).filter(s => String(s.name).startsWith(prefix)).map(s => `saved:${s.name}`)];
    },
    async cleanupHandle(handle) { if (handle && typeof handle === "object") await api(`/saved-snapshots/${encodeURIComponent((handle as any).saved)}`, "DELETE").catch(() => {}); },
  };
  return self;
}

// ---------------------------------------------------------------- exe.dev
export function exe(cpu = 0): Provider {
  const lobby = (args: string[]) => run("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=20", "exe.dev", ...args], undefined, 900);
  return {
    name: "exe", ws: "/home/exedev/ws",
    async create(name) {
      const r = await lobby(["new", `--name=${name}`, "--no-email", "--json", ...(cpu ? [`--cpu=${cpu}`] : [])]);
      if (r.code) throw new Error(`exe new: ${r.stdout}${r.stderr}`);
      return { id: name, name };
    },
    async exec(m, cmd, timeoutSec = 900) {
      return run("ssh", ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=10", `${m.name}.exe.xyz`, "bash -l -s"], cmd, timeoutSec);
    },
    async prepareFork(source) { return source.name; },
    async fork(handle, name) {
      const r = await lobby(["cp", String(handle), name, "--copy-tags=false", "--json"]);
      if (r.code) throw new Error(`exe cp: ${r.stdout}${r.stderr}`);
      return { id: name, name };
    },
    async stopWake(m) {
      let t = Date.now(); const r = await lobby(["restart", m.name]); if (r.code) throw new Error(`exe restart: ${r.stdout}${r.stderr}`);
      const stopMs = Date.now() - t; t = Date.now();
      for (let i = 0; i < 120; i++) { if ((await this.exec(m, "true", 20)).code === 0) break; await sleep(1000); }
      return { stopMs, wakeMs: Date.now() - t, note: "exe restart (reboot; disk kept). pause/resume (RAM to disk) not used" };
    },
    async destroy(m) { const r = await lobby(["rm", m.name]); if (r.code && !/not found|no such/i.test(r.stdout + r.stderr)) throw new Error(`exe rm: ${r.stdout}${r.stderr}`); },
    async leftovers(prefix) { const r = await lobby(["ls", "--json"]); return (r.stdout.match(/[a-z0-9-]+\.exe\.xyz/g) ?? []).filter(n => n.startsWith(prefix)); },
  };
}

// ---------------------------------------------------------------- Sprites (checkpoint/restore on the same sprite; no fork API)
export function sprites(): Provider {
  const s = (args: string[], input?: string, t = 900) => run("sprite", ["-o", "camelai", ...args], input, t);
  return {
    name: "sprites", ws: "/home/sprite/ws",
    async create(name) { const r = await s(["create", name]); if (r.code) throw new Error(`sprite create: ${r.stdout}${r.stderr}`); return { id: name, name }; },
    async exec(m, cmd, timeoutSec = 900) { return s(["exec", "-s", m.name, "--", "bash", "-lc", cmd], undefined, timeoutSec); },
    async prepareFork(source) {
      const r = await s(["checkpoint", "create", "-s", source.name]);
      if (r.code) throw new Error(`checkpoint: ${r.stdout}${r.stderr}`);
      const list = await s(["checkpoint", "list", "-s", source.name, "--json"]);
      return { sprite: source.name, create: r.stdout.trim(), list: list.stdout.trim() };
    },
    async fork() { throw new Error("Sprites has no fork API"); },
    async destroy(m) { const r = await s(["destroy", "-s", m.name, "--force"]); if (r.code) { const r2 = await s(["destroy", m.name, "--force"]); if (r2.code) throw new Error(`sprite destroy: ${r.stdout}${r.stderr}${r2.stderr}`); } },
    async leftovers(prefix) { const r = await s(["list"]); return r.stdout.split(/\s+/).filter(n => n.startsWith(prefix)); },
  };
}

// ---------------------------------------------------------------- Cloudflare Containers, durable_object policy, native snapshots
export function cloudflare(url: string, token: string, instance = "standard-4"): Provider {
  const call = async (name: string, op: string, body: unknown = {}) => {
    for (let attempt = 0; ; attempt++) {
      const r = await fetch(`${url}/m/${name}/${op}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
      const json: any = await r.json().catch(async () => ({ error: `HTTP ${r.status}` }));
      if (r.ok) return json;
      if (attempt < 3 && /network|reset|overloaded|Internal error/i.test(String(json.error))) { await sleep(1000); continue; }
      throw new Error(`cloudflare ${op} ${name}: ${json.error}`);
    }
  };
  return {
    name: "cloudflare", ws: "/workspace",
    async create(name) { const r = await call(name, "start", { instance }); return { id: name, name, startMs: r.ms }; },
    async exec(m, cmd, timeoutSec = 600) { const r = await call(m.name, "exec", { cmd, timeoutMs: timeoutSec * 1000 }); return { code: r.code, stdout: r.stdout, stderr: r.stderr }; },
    async prepareFork(source, label) { const r = await call(source.name, "snapshot", { name: label }); return r.snapshot; },
    async fork(handle, name) { const r = await call(name, "start", { snapshot: handle, instance }); return { id: name, name, startMs: r.ms }; },
    async stopWake(m) {
      // A container's disk lives only while it runs. Keep work across a sleep by
      // snapshotting first, then start the same Durable Object from that snapshot.
      let t = Date.now(); const snap = (await call(m.name, "snapshot", { name: `${m.name}-sleep` })).snapshot; await call(m.name, "destroy"); const stopMs = Date.now() - t;
      t = Date.now(); await call(m.name, "start", { snapshot: snap, instance }); return { stopMs, wakeMs: Date.now() - t, note: "snapshotContainer + destroy, then start({containerSnapshot})" };
    },
    async destroy(m) { await call(m.name, "destroy"); },
    async leftovers() { return []; },
  };
}
