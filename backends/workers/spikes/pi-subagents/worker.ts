/**
 * Throwaway load spike: N pure-Pi child conversations in one Durable Object, or (remote=1) the middle ground, where
 * each child conversation runs in a Durable Object of its own behind a Pi task the parent's call owns. Deployed under its
 * own script name (wrangler.jsonc here), never the pilot or production, and deleted after the run. See README.md.
 *
 * POST /run/<name>/start?n=&tps=&tokens=&tools=&ctx=&watch=&remote=   starts a fan-out in the object <name>
 * GET  /run/<name>/stats                                              what the object recorded, and its Pi state
 * POST /run/<name>/crash                                              resets the object (as an eviction or a crash)
 * Every request needs `Authorization: Bearer <SPIKE_TOKEN>`.
 */
import { DurableObject } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { AssistantEntry, type EntryId, type Wake } from "@earendil-works/pi-durable";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Metrics, lagProbe, openSpike, startRun, usageByConversation, type RemoteChildren, type Spike } from "./core.ts";

type Env = { LOAD: DurableObjectNamespace<LoadAgent>; SPIKE_TOKEN: string; MODEL_URL: string };
const context = BACKGROUND_CONTEXT;

export class LoadAgent extends DurableObject<Env> {
  metrics = new Metrics();
  spike?: Spike;
  opened?: Promise<Spike>;
  instance = crypto.randomUUID();

  /** Counts SQL statements Pi runs, on the storage object Pi gets. */
  storage() {
    const real = this.ctx.storage;
    const metrics = this.metrics;
    return {
      sql: { exec: (query: string, ...bindings: unknown[]) => { metrics.statements++; return real.sql.exec(query, ...(bindings as never[])); } },
      transaction: <T>(closure: () => Promise<T>) => real.transaction(closure),
    };
  }

  /** The parent's way to its children: RPC to a child object, named by the parent and the owning task. */
  remote(): RemoteChildren {
    const child = (name: string) => this.env.LOAD.getByName(name);
    return {
      start: async (name, requestId, task) => {
        await this.ctx.storage.put(`child:${name}`, 1);
        await child(name).childStart(requestId, task);
      },
      wait: (name, requestId, timeoutMs) => child(name).childWait(requestId, timeoutMs),
      abort: (name, requestId) => child(name).childAbort(requestId),
    };
  }

  open() {
    return (this.opened ??= (async () => {
      const fallback = Date.now() + 60_000;
      const current = await this.ctx.storage.getAlarm();
      if (current === null || current > fallback) await this.ctx.storage.setAlarm(fallback);
      const mode = await this.ctx.storage.get<{ watch: number; remote: boolean; name: string }>("mode");
      const storage = await openDurableObjectSqliteStorage(this.storage() as never);
      const spike = await openSpike(storage, this.env.MODEL_URL, this.metrics, {
        onWake: (wake) => void this.arm(wake).catch(() => this.ctx.abort("Alarm write failed")),
        watchChildren: mode?.watch ?? 0,
        ...(mode?.remote ? { remote: { children: this.remote(), prefix: mode.name } } : {}),
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

  // ── A child object (remote mode) ──

  /** Start the child's conversation: its own root, deduplicated by the parent's stable request id. */
  async childStart(requestId: string, task: string) {
    const starts = ((await this.ctx.storage.get<number>(`starts:${requestId}`)) ?? 0) + 1;
    await this.ctx.storage.put(`starts:${requestId}`, starts);
    const spike = await this.open();
    await this.arm({ ...spike.harness.wake(), active: true });
    await spike.root.submit({ type: "input", content: task, requestId }, context);
  }

  /** Wait up to `timeoutMs` for the answer. A repeated submit with the same request id finds the one submission. */
  async childWait(requestId: string, timeoutMs: number) {
    const spike = await this.open();
    const submission = await spike.root.submit({ type: "input", content: "(already submitted)", requestId }, context);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settled = await Promise.race([submission.wait(context), new Promise<undefined>((resolve) => { timer = setTimeout(resolve, timeoutMs); })]);
    clearTimeout(timer);
    if (!settled) return { done: false };
    if (settled.status !== "done" || settled.type !== "input") return { done: true, status: settled.status };
    const entry = await spike.root.commit((tx) => tx.entry(AssistantEntry, settled.answer as EntryId), context);
    const text = ((entry?.model?.[0] as AssistantMessage | undefined)?.content ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
    return { done: true, status: "done", text };
  }

  async childAbort(_requestId: string) {
    const spike = await this.open();
    await spike.root.abort(context);
  }

  async childStats() {
    const starts = [...(await this.ctx.storage.list<number>({ prefix: "starts:" })).values()];
    const spike = await this.open();
    const entries = await spike.root.entries({ order: "ascending" }, 1000, undefined, context);
    return { starts: starts.reduce((a, b) => a + b, 0), userInputs: entries.items.filter((entry) => entry.kind === "pi.user").length };
  }

  // ── HTTP ──

  /** Durable facts, which survive a reset: the parent's tool results and whether its run answered. */
  async piState(spike: Spike) {
    const entries = await spike.root.entries({ order: "ascending" }, 1000, undefined, context);
    const results = entries.items.filter((entry) => entry.kind === "pi.tool-result");
    const errors = results.filter((entry) => (entry.model?.[0] as { isError?: boolean } | undefined)?.isError).length;
    const answered = entries.items.some((entry, index) => index > 0 && entry.kind === "pi.assistant" && (entry.model?.[0] as AssistantMessage | undefined)?.stopReason === "stop");
    return { toolResults: results.length, toolErrors: errors, parentAnswered: answered };
  }

  override async fetch(request: Request) {
    const url = new URL(request.url);
    const action = url.pathname.split("/").at(-1);
    if (action === "start") {
      const number = (key: string, fallback: number) => Number(url.searchParams.get(key) ?? fallback);
      if (await this.ctx.storage.get("mode")) return Response.json({ error: "This object already ran: use a fresh name" }, { status: 409 });
      await this.ctx.storage.put("mode", { watch: number("watch", 5), remote: url.searchParams.get("remote") === "1", name: url.pathname.split("/").at(-2) });
      const spike = await this.open();
      await this.arm({ ...spike.harness.wake(), active: true });
      const run = { n: number("n", 1), tps: number("tps", 50), tokens: number("tokens", 2000), tools: number("tools", 3), ctx: number("ctx", 0), id: crypto.randomUUID() };
      lagProbe(this.metrics, 15 * 60_000);
      await startRun(spike, this.metrics, run);
      return Response.json({ started: run, instance: this.instance });
    }
    if (action === "crash") {
      this.ctx.abort("spike: simulated eviction");
      return new Response("unreachable");
    }
    if (action === "stats") {
      const spike = await this.open();
      const mode = await this.ctx.storage.get<{ remote: boolean; name: string }>("mode");
      const usage = url.searchParams.get("usage") === "1" && !mode?.remote
        ? await usageByConversation(spike, [...this.metrics.children.keys()].slice(0, 3))
        : undefined;
      let children: unknown;
      if (url.searchParams.get("children") === "1" && mode?.remote) {
        // Every child object the parent started, and how often its start ran and how many inputs its conversation has.
        const names = [...(await this.ctx.storage.list<number>({ prefix: "child:" })).keys()].map((key) => key.slice(6));
        const stats = await Promise.all(names.map((name) => this.env.LOAD.getByName(name).childStats()));
        children = { objects: names.length, starts: stats.reduce((sum, each) => sum + each.starts, 0), inputs: stats.reduce((sum, each) => sum + each.userInputs, 0), duplicated: stats.filter((each) => each.userInputs !== 1).length };
      }
      return Response.json({
        instance: this.instance,
        databaseBytes: this.ctx.storage.sql.databaseSize,
        pi: await this.piState(spike),
        summary: this.metrics.summary(),
        ...(usage ? { usage } : {}),
        ...(children ? { children } : {}),
      });
    }
    if (action === "child-stats") return Response.json(await this.childStats());
    return new Response("Not found", { status: 404 });
  }
}

export default {
  async fetch(request: Request, env: Env) {
    if (!env.SPIKE_TOKEN || request.headers.get("authorization") !== `Bearer ${env.SPIKE_TOKEN}`)
      return new Response("Unauthorized", { status: 401 });
    const match = /^\/run\/([A-Za-z0-9_-]{1,96})\/(start|stats|crash|child-stats)$/.exec(new URL(request.url).pathname);
    if (!match) return new Response("Not found", { status: 404 });
    return env.LOAD.getByName(match[1]!).fetch(request);
  },
};
