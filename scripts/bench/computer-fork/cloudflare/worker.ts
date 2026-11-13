// Throwaway benchmark Worker: one Durable Object per machine, each owning one
// Container under the `durable_object` scheduling policy. A fork is a new
// Durable Object whose Container starts from another one's snapshot.
// Deployed by ../bench.ts (cloudflare provider) and deleted afterwards.
import { DurableObject } from "cloudflare:workers";

type Env = { MACHINES: DurableObjectNamespace<Machine>; BENCH_TOKEN: string };
type Instance = "standard-1" | "standard-2" | "standard-3" | "standard-4";

const tail = (s: string, n = 16384) => (s.length > n ? s.slice(-n) : s);

export class Machine extends DurableObject<Env> {
  private get box() {
    if (!this.ctx.container) throw new Error("container binding unavailable");
    return this.ctx.container;
  }
  async status() {
    return { running: this.box.running, info: this.box.running ? await this.box.inspect() : null };
  }
  /** Start fresh from the image, or from a snapshot handle made by any Machine. */
  async start(opts: { snapshot?: { id: string }; instance?: Instance }) {
    const t0 = Date.now();
    if (this.box.running) return { alreadyRunning: true, ms: 0 };
    const base = { enableInternet: true, instance: opts.instance ?? "standard-4" } as const;
    if (opts.snapshot) this.box.start({ ...base, containerSnapshot: { id: opts.snapshot.id } });
    else this.box.start({ ...base, image: this.box.images.workspace });
    await this.box.setInactivityTimeout(30 * 60_000);
    return { ms: Date.now() - t0 };
  }
  async exec(cmd: string, timeoutMs = 600_000) {
    const t0 = Date.now();
    const p = await this.box.exec(["bash", "-lc", cmd], { cwd: "/", stdout: "pipe", stderr: "pipe", signal: AbortSignal.timeout(timeoutMs) });
    const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exitCode]);
    return { code, stdout: tail(stdout), stderr: tail(stderr), ms: Date.now() - t0 };
  }
  async snapshot(name: string) {
    const t0 = Date.now();
    const snap = await this.box.snapshotContainer({ name });
    await this.ctx.storage.put(`snapshot:${name}`, snap);
    return { snapshot: snap, ms: Date.now() - t0 };
  }
  async destroy() {
    const t0 = Date.now();
    if (this.box.running) await this.box.destroy();
    await this.ctx.storage.deleteAll();
    return { ms: Date.now() - t0 };
  }
}

export default {
  async fetch(req: Request, env: Env) {
    if (req.headers.get("authorization") !== `Bearer ${env.BENCH_TOKEN}`) return new Response("forbidden", { status: 403 });
    const m = new URL(req.url).pathname.match(/^\/m\/([a-z0-9-]{1,63})\/(start|exec|snapshot|destroy|status)$/);
    if (!m) return new Response("not found", { status: 404 });
    const stub = env.MACHINES.get(env.MACHINES.idFromName(m[1]));
    const body: any = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    try {
      const op = m[2];
      const result =
        op === "start" ? await stub.start(body)
        : op === "exec" ? await stub.exec(String(body.cmd), body.timeoutMs)
        : op === "snapshot" ? await stub.snapshot(String(body.name ?? m[1]))
        : op === "destroy" ? await stub.destroy()
        : await stub.status();
      return Response.json(result);
    } catch (error) {
      return Response.json({ error: String((error as Error)?.message ?? error) }, { status: 500 });
    }
  },
};
