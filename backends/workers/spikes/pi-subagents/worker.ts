/**
 * Throwaway load spike: N pure-Pi child conversations in one Durable Object. Deployed under its own script name
 * (wrangler.jsonc here), never the pilot or production, and deleted after the run. See README.md.
 *
 * POST /run/<name>/start?n=&tps=&tokens=&tools=&ctx=&watch=   starts a fan-out in the object <name>
 * GET  /run/<name>/stats                                     what the object recorded so far
 * Every request needs `Authorization: Bearer <SPIKE_TOKEN>`.
 */
import { DurableObject } from "cloudflare:workers";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import type { Wake } from "@earendil-works/pi-durable";
import { Metrics, lagProbe, openSpike, startRun, usageByConversation, type Spike } from "./core.ts";

type Env = { LOAD: DurableObjectNamespace<LoadAgent>; SPIKE_TOKEN: string; MODEL_URL: string };

export class LoadAgent extends DurableObject<Env> {
  metrics = new Metrics();
  spike?: Spike;
  opened?: Promise<Spike>;
  instance = crypto.randomUUID();
  options = { watchChildren: 0 };

  /** Counts SQL statements Pi runs, on the storage object Pi gets. */
  storage() {
    const real = this.ctx.storage;
    const metrics = this.metrics;
    return {
      sql: { exec: (query: string, ...bindings: unknown[]) => { metrics.statements++; return real.sql.exec(query, ...(bindings as never[])); } },
      transaction: <T>(closure: () => Promise<T>) => real.transaction(closure),
    };
  }

  open() {
    return (this.opened ??= (async () => {
      const fallback = Date.now() + 60_000;
      const current = await this.ctx.storage.getAlarm();
      if (current === null || current > fallback) await this.ctx.storage.setAlarm(fallback);
      const storage = await openDurableObjectSqliteStorage(this.storage() as never);
      const spike = await openSpike(storage, this.env.MODEL_URL, this.metrics, {
        onWake: (wake) => void this.arm(wake).catch(() => this.ctx.abort("Alarm write failed")),
        watchChildren: this.options.watchChildren,
      });
      await this.arm(spike.harness.wake());
      spike.harness.resume();
      this.spike = spike;
      return spike;
    })());
  }

  async arm(wake: Wake) {
    const heartbeat = wake.active ? Date.now() + 60_000 : undefined;
    const at = heartbeat === undefined || wake.at === undefined ? (heartbeat ?? wake.at) : Math.min(heartbeat, wake.at);
    if (at === undefined) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(at);
  }

  override async alarm() {
    const spike = await this.open();
    await this.arm({ ...spike.harness.wake(), active: true });
    spike.harness.resume();
  }

  override async fetch(request: Request) {
    const url = new URL(request.url);
    const action = url.pathname.split("/").at(-1);
    if (action === "start") {
      const number = (key: string, fallback: number) => Number(url.searchParams.get(key) ?? fallback);
      // One run per object: use a fresh name for each run.
      if (this.opened) return Response.json({ error: "This object already ran" }, { status: 409 });
      this.options.watchChildren = number("watch", 5);
      const spike = await this.open();
      await this.arm({ ...spike.harness.wake(), active: true });
      const run = { n: number("n", 1), tps: number("tps", 50), tokens: number("tokens", 2000), tools: number("tools", 3), ctx: number("ctx", 0), id: crypto.randomUUID() };
      lagProbe(this.metrics, 15 * 60_000);
      await startRun(spike, this.metrics, run);
      return Response.json({ started: run, instance: this.instance });
    }
    if (action === "stats") {
      const spike = this.spike;
      const usage = url.searchParams.get("usage") === "1" && spike
        ? await usageByConversation(spike, ["0", ...[...this.metrics.children.keys()].slice(0, 3)])
        : undefined;
      return Response.json({
        instance: this.instance,
        opened: !!spike,
        databaseBytes: this.ctx.storage.sql.databaseSize,
        summary: this.metrics.summary(),
        ...(usage ? { usage } : {}),
      });
    }
    return new Response("Not found", { status: 404 });
  }
}

export default {
  async fetch(request: Request, env: Env) {
    if (!env.SPIKE_TOKEN || request.headers.get("authorization") !== `Bearer ${env.SPIKE_TOKEN}`)
      return new Response("Unauthorized", { status: 401 });
    const match = /^\/run\/([A-Za-z0-9_-]{1,64})\/(start|stats)$/.exec(new URL(request.url).pathname);
    if (!match) return new Response("Not found", { status: 404 });
    return env.LOAD.getByName(match[1]!).fetch(request);
  },
};
