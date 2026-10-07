import { AsyncResource } from "node:async_hooks";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeConfig } from "../../src/node-config.ts";
import { createNode, type NodeDeps, type RuntimeNode } from "../../src/node.ts";
import { nodeContext, type Clock } from "../../src/node-context.ts";
import { runtimeSecrets } from "../../src/secrets.ts";
import { tenantsFromEnvironment } from "../../src/tenants.ts";
import { memoryStorage } from "../../shared/storage.ts";
import { fakeExecutor } from "../fake-executor.ts";
import { SimDb } from "./db.ts";
import { prng, SimEnv, type ClockSkew } from "./env.ts";
import { fakeModel, type Answer, type Served } from "./fakes/model.ts";
import { SimNet } from "./net.ts";
import { SimHooks, type BuggifyPlan } from "./hooks.ts";

export const TOKEN = "simulation-operator-token-at-least-24-chars";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

/** A runtime node in the simulation: its handles, how to reach it, and how it was started (to start it again). */
export type SimNode = {
  name: string; host: string; url: string; runtime: RuntimeNode; clock: Clock; crashed: boolean; kill(): void; started: { env: Record<string, string>; skew: ClockSkew };
  /** Settles when the node's process ends (a crash, or the exit after a drain). */
  ended: Promise<void>;
};

/** `map`, refusing changes once `dead()` (a crashed node's writes never land); maps it holds are guarded too. */
function guarded<K, V>(map: Map<K, V>, dead: () => boolean): Map<K, V> {
  return new Proxy(map, {
    get(target, name) {
      const value = Reflect.get(target, name, target);
      if (name === "set" || name === "delete" || name === "clear") {
        return (...args: unknown[]) => { if (dead()) throw new Error("The node crashed"); return (value as (...args: unknown[]) => unknown).apply(target, args); };
      }
      if (name === "get") return (key: K) => { const found = target.get(key); return found instanceof Map ? guarded(found, dead) : found; };
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * A simulated cluster in this process: runtime nodes (createNode) on one SimDb, one in-memory object store and one
 * SimNet, with a fake model provider, all on the simulation's clock and seeded randomness (SimEnv). Nothing touches a
 * real socket or database, and the same seed runs the same way. Every operation runs the clock until it settles.
 */
export class Sim {
  readonly seed: string;
  readonly env: SimEnv;
  /** BUGGIFY decisions and the assertions recorded. */
  readonly hooks: SimHooks;
  readonly db: SimDb;
  readonly net = new SimNet();
  /** The object store every node shares (S3's stand-in). */
  readonly objects = { logs: new Map<string, Map<string, string>>(), blobs: new Map<string, Uint8Array>() };
  readonly nodes = new Map<string, SimNode>();
  readonly model: { served: Served[] };
  private readonly root = mkdtempSync(join(tmpdir(), "agent-sim-"));
  private readonly nodeEnv: Record<string, string>;
  private readonly incarnations = new Map<string, number>();
  /** Work done as no node at all: the fakes, the database, the client. */
  private readonly world = new AsyncResource("SimWorld");

  private constructor(seed: string, env: SimEnv, hooks: SimHooks, db: SimDb, respond: (body: any, served: Served[]) => Answer, nodeEnv: Record<string, string>) {
    this.seed = seed;
    this.env = env;
    this.hooks = hooks;
    this.db = db;
    const model = fakeModel(respond, address => this.net.hostOf(address));
    this.net.add("model.sim", model.server, work => this.world.runInAsyncScope(work));
    this.net.add("client.sim");
    this.model = model;
    this.nodeEnv = nodeEnv;
    hooks.where = () => { const node = nodeContext()?.clock; return { at: env.elapsed, ...(node ? { node: env.names.get(node) } : {}) }; };
  }

  /**
   * A world for `seed`, its database migrated; `respond` is the model's script; `env` applies to every node; `buggify`
   * says which BUGGIFY sites fire. Installs the simulation's environment and hooks for the process until `close`.
   */
  static async create(options: { seed: string | number; respond: (body: any, served: Served[]) => Answer; env?: Record<string, string>; buggify?: BuggifyPlan; quiet?: boolean }) {
    const seed = String(options.seed);
    const db = await SimDb.create(prng(`${seed}:sql`).float() * 2 - 1);
    await db.migrate();
    return new Sim(seed, new SimEnv(seed, undefined, options.quiet), new SimHooks(seed, options.buggify ?? false), db, options.respond, options.env ?? {});
  }

  /** Start node `name` (reachable at http://<name>.sim), with `env` over the world's, its clock off by `skew`. */
  /**
   * `drive` (default true) runs the clock until the node has started. A driver that moves time itself passes false:
   * two loops moving one clock would interleave by how fast the real machine runs.
   */
  async start(name: string, env: Record<string, string> = {}, skew: ClockSkew = {}, options: { drive?: boolean } = {}): Promise<SimNode> {
    const host = `${name}.sim`, url = `http://${host}`;
    if (this.nodes.get(name) && !this.nodes.get(name)!.crashed) throw new Error(`Node ${name} is running`);
    this.net.add(host);
    const config = nodeConfig({
      PATH: process.env.PATH, PORT: "80", AGENT_NODE_URL: url, AGENT_PUBLIC_URL: url, AGENT_DATA_DIR: join(this.root, name),
      AGENT_HOSTING: "inline", AGENT_LEASE_TTL_MS: "6000", AGENT_SCHEDULER_INTERVAL_MS: "200",
      AGENT_TENANTS_JSON: JSON.stringify({ tenants: { alice: { tokenSha256: sha(TOKEN), apiKeys: { openrouter: "sim-model-key" } } } }),
      AGENT_SESSION_SECRET: "simulation-session-secret-of-32-characters", AGENT_SECRETS_KEY: "0".repeat(64),
      AGENT_PROVIDER: "openrouter", AGENT_MODEL: "openai/gpt-4o-mini", AGENT_BASE_URL: "http://model.sim/v1",
      ...this.nodeEnv, ...env,
    });
    // Each start of a node is a new process: its own randomness and clock, which a crash ends.
    const incarnation = (this.incarnations.get(name) ?? 0) + 1;
    this.incarnations.set(name, incarnation);
    let dead = false;
    const clock = this.env.nodeClock(skew);
    const db = this.db.connection(host, () => this.env.whenRunning(clock));
    this.env.names.set(clock, `${name}#${incarnation}`);
    const deps: NodeDeps = {
      tenants: await tenantsFromEnvironment(config.env),
      secrets: await runtimeSecrets(config.env),
      db,
      listen: this.db.listen(host, () => dead, work => this.env.deliver(clock, work)),
      sandbox: { mode: "simulated" },
      network: this.net.networkFor(host),
      clock,
      random: prng(`${this.seed}:${name}:${incarnation}`),
      codeExecutor: fakeExecutor(),
      storage: (tail, meter) => memoryStorage(tail, meter, { logs: guarded(this.objects.logs, () => dead), blobs: guarded(this.objects.blobs, () => dead) }),
    };
    let runtime: RuntimeNode;
    // A node that fails to start exits, as the process would: nothing it began goes on.
    try { runtime = await (options.drive === false ? createNode(config, deps) : this.env.settle(createNode(config, deps))); }
    catch (error) { dead = true; db.kill(); this.env.crash(clock); throw error; }
    this.net.add(host, runtime.server, work => runtime.run(work));
    const ended = Promise.withResolvers<void>();
    const node: SimNode = { name, host, url, runtime, clock, crashed: false, kill: () => { dead = true; db.kill(); ended.resolve(); }, started: { env, skew }, ended: ended.promise };
    this.nodes.set(name, node);
    return node;
  }

  /**
   * Node `name`'s process dies (SIGKILL, a lost host): its timers stop, its connections drop and new ones are refused,
   * its database connections fail, and nothing it was writing lands. Peers find out as in production: its heartbeat
   * goes stale, and probes are refused.
   */
  crash(name: string) {
    const node = this.nodes.get(name);
    if (!node || node.crashed) throw new Error(`Node ${name} is not running`);
    node.crashed = true;
    node.kill();
    this.env.crash(node.clock);
    this.net.remove(node.host);
  }

  /**
   * Node `name` leaves as a deploy takes it out: SIGTERM's drain (turns handed to peers or finished, then everything
   * released), then its process exits.
   */
  async drain(name: string) {
    const node = this.nodes.get(name);
    if (!node || node.crashed) throw new Error(`Node ${name} is not running`);
    // A node that crashes while it drains never finishes draining.
    await Promise.race([node.runtime.drain("SIGTERM").catch(() => {}), node.ended]);
    if (node.crashed) return;
    node.crashed = true;
    node.kill();
    this.env.crash(node.clock);
    this.net.remove(node.host);
  }

  /**
   * Node `name`'s process stops for `ms` and then goes on (SIGSTOP and SIGCONT, a long GC pause): see SimEnv.pause.
   * Settles when it resumes.
   */
  pause(name: string, ms: number) {
    const node = this.nodes.get(name);
    if (!node || node.crashed) throw new Error(`Node ${name} is not running`);
    return this.env.pause(node.clock, ms);
  }

  /** Start a crashed node again, as it was started: a new process (a new session) at the same address. */
  restart(name: string, options: { drive?: boolean } = {}) {
    const node = this.nodes.get(name);
    if (!node?.crashed) throw new Error(`Node ${name} has not crashed`);
    return this.start(name, node.started.env, node.started.skew, options);
  }

  /** Cut `a` off from `b` (both ways), as a partition does: connections are refused, or (blackhole) never answer. */
  partition(a: string, b: string, how: "refused" | "blackhole" = "refused") { this.net.cut(this.hostOf(a), this.hostOf(b), how); }
  /** Heal every partition. */
  heal() { this.net.heal(); }
  /** Cut node `name` off from the database (a failover, a network fault), or let it back. */
  databaseDown(name: string, down = true) { this.db.setDown(this.hostOf(name), down); }
  private hostOf(name: string) { return name.includes(".") ? name : `${name}.sim`; }

  /** Call the API on `node` as the operator (or with `token`), as a client on the simulated network does. */
  call(node: string, path: string, init: { method?: string; body?: unknown; token?: string; headers?: Record<string, string> } = {}) {
    return this.env.settle(this.request(node, path, init));
  }

  /**
   * The same call without running the clock: for a driver that issues calls while it moves time itself. A node that
   * cannot be reached fails it (a TypeError, as fetch's).
   */
  request(node: string, path: string, init: { method?: string; body?: unknown; token?: string; headers?: Record<string, string>; timeoutMs?: number } = {}): Promise<{ status: number; json: any }> {
    return this.asWorld(async () => {
      const response = await this.net.networkFor("client.sim").fetch(`http://${node}.sim${path}`, {
        method: init.method ?? (init.body === undefined ? "GET" : "POST"),
        headers: { Authorization: `Bearer ${init.token ?? TOKEN}`, ...(init.body === undefined ? {} : { "Content-Type": "application/json" }), ...init.headers },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        // As a client gives up on a node that never answers (a blackholed link).
        signal: AbortSignal.timeout(init.timeoutMs ?? 60_000),
      });
      const text = await response.text();
      let json: any;
      try { json = JSON.parse(text); } catch { json = text; }
      return { status: response.status, json };
    });
  }

  /** Run `work` as no node (a client, a driver): the base clock and the world's randomness. */
  asWorld<T>(work: () => T): T { return this.world.runInAsyncScope(work); }

  /** Move virtual time on by `ms`. */
  advance(ms: number) { return this.env.advance(ms); }

  /**
   * Run until `check` returns something truthy, polling every `everyMs` virtual ms, failing past `limitMs`. A check that
   * waits on the simulation (a `call`) runs the clock itself; between checks this moves it.
   */
  async until<V>(check: () => V | Promise<V>, what: string, limitMs = 60_000, everyMs = 50): Promise<NonNullable<V>> {
    for (const deadline = this.env.elapsed + limitMs; ;) {
      const value = await check();
      if (value) return value as NonNullable<V>;
      if (this.env.elapsed >= deadline) throw new Error(`Timed out (virtual ${limitMs} ms) waiting for ${what}`);
      await this.env.advance(everyMs);
    }
  }

  /** Stop every node (without waiting for turns), the database and the environment. */
  async close() {
    try {
      for (const node of this.nodes.values()) if (!node.crashed) await this.env.settle(node.runtime.close()).catch(() => {});
      this.nodes.clear();
    } finally {
      this.hooks.uninstall();
      this.env.uninstall();
      await this.db.close();
      rmSync(this.root, { recursive: true, force: true });
    }
  }
}
