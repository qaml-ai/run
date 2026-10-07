import { AsyncResource } from "node:async_hooks";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeConfig } from "../../src/node-config.ts";
import { createNode, type NodeDeps, type RuntimeNode } from "../../src/node.ts";
import { runtimeSecrets } from "../../src/secrets.ts";
import { tenantsFromEnvironment } from "../../src/tenants.ts";
import { memoryStorage } from "../../shared/storage.ts";
import { fakeExecutor } from "../fake-executor.ts";
import { SimDb } from "./db.ts";
import { prng, SimEnv, type ClockSkew } from "./env.ts";
import { fakeModel, type Answer, type Served } from "./fakes/model.ts";
import { SimNet } from "./net.ts";

export const TOKEN = "simulation-operator-token-at-least-24-chars";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

/** A runtime node in the simulation: its handles, and how to reach it. */
export type SimNode = { name: string; host: string; url: string; runtime: RuntimeNode };

/**
 * A simulated cluster in this process: runtime nodes (createNode) on one SimDb, one in-memory object store and one
 * SimNet, with a fake model provider, all on the simulation's clock and seeded randomness (SimEnv). Nothing touches a
 * real socket or database, and the same seed runs the same way. Every operation runs the clock until it settles.
 */
export class Sim {
  readonly seed: string;
  readonly env: SimEnv;
  readonly db: SimDb;
  readonly net = new SimNet();
  /** The object store every node shares (S3's stand-in). */
  readonly objects = { logs: new Map<string, Map<string, string>>(), blobs: new Map<string, Uint8Array>() };
  readonly nodes = new Map<string, SimNode>();
  readonly model: { served: Served[] };
  private readonly root = mkdtempSync(join(tmpdir(), "agent-sim-"));
  private readonly nodeEnv: Record<string, string>;
  /** Work done as no node at all: the fakes, the database, the client. */
  private readonly world = new AsyncResource("SimWorld");

  private constructor(seed: string, env: SimEnv, db: SimDb, respond: (body: any, served: Served[]) => Answer, nodeEnv: Record<string, string>) {
    this.seed = seed;
    this.env = env;
    this.db = db;
    const model = fakeModel(respond, address => this.net.hostOf(address));
    this.net.add("model.sim", model.server, work => this.world.runInAsyncScope(work));
    this.net.add("client.sim");
    this.model = model;
    this.nodeEnv = nodeEnv;
  }

  /**
   * A world for `seed`, its database migrated; `respond` is the model's script; `env` applies to every node. Installs the
   * simulation's environment for the process until `close`.
   */
  static async create(options: { seed: string | number; respond: (body: any, served: Served[]) => Answer; env?: Record<string, string> }) {
    const db = await SimDb.create();
    await db.migrate();
    const seed = String(options.seed);
    return new Sim(seed, new SimEnv(seed), db, options.respond, options.env ?? {});
  }

  /** Start node `name` (reachable at http://<name>.sim), with `env` over the world's, its clock off by `skew`. */
  async start(name: string, env: Record<string, string> = {}, skew: ClockSkew = {}): Promise<SimNode> {
    const host = `${name}.sim`, url = `http://${host}`;
    this.net.add(host);
    const config = nodeConfig({
      PATH: process.env.PATH, PORT: "80", AGENT_NODE_URL: url, AGENT_PUBLIC_URL: url, AGENT_DATA_DIR: join(this.root, name),
      AGENT_HOSTING: "inline", AGENT_LEASE_TTL_MS: "6000", AGENT_SCHEDULER_INTERVAL_MS: "200",
      AGENT_TENANTS_JSON: JSON.stringify({ tenants: { alice: { tokenSha256: sha(TOKEN), apiKeys: { openrouter: "sim-model-key" } } } }),
      AGENT_SESSION_SECRET: "simulation-session-secret-of-32-characters", AGENT_SECRETS_KEY: "0".repeat(64),
      AGENT_PROVIDER: "openrouter", AGENT_MODEL: "openai/gpt-4o-mini", AGENT_BASE_URL: "http://model.sim/v1",
      ...this.nodeEnv, ...env,
    });
    const deps: NodeDeps = {
      tenants: await tenantsFromEnvironment(config.env),
      secrets: await runtimeSecrets(config.env),
      db: this.db.connection(host),
      listen: this.db.listen(host),
      sandbox: { mode: "simulated" },
      network: this.net.networkFor(host),
      clock: this.env.nodeClock(skew),
      random: prng(`${this.seed}:${name}`),
      codeExecutor: fakeExecutor(),
      storage: (tail, meter) => memoryStorage(tail, meter, this.objects),
    };
    const runtime = await this.env.settle(createNode(config, deps));
    this.net.add(host, runtime.server, work => runtime.run(work));
    const node = { name, host, url, runtime };
    this.nodes.set(name, node);
    return node;
  }

  /** Call the API on `node` as the operator (or with `token`), as a client on the simulated network does. */
  call(node: string, path: string, init: { method?: string; body?: unknown; token?: string } = {}) {
    return this.env.settle(this.world.runInAsyncScope(async () => {
      const response = await this.net.networkFor("client.sim").fetch(`http://${node}.sim${path}`, {
        method: init.method ?? (init.body === undefined ? "GET" : "POST"),
        headers: { Authorization: `Bearer ${init.token ?? TOKEN}`, ...(init.body === undefined ? {} : { "Content-Type": "application/json" }) },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });
      const text = await response.text();
      let json: any;
      try { json = JSON.parse(text); } catch { json = text; }
      return { status: response.status, json };
    }));
  }

  /** Move virtual time on by `ms`. */
  advance(ms: number) { return this.env.advance(ms); }

  /** Run until `check` returns something truthy, polling every `everyMs` virtual ms, failing past `limitMs`. */
  async until<V>(check: () => V | Promise<V>, what: string, limitMs = 60_000, everyMs = 50): Promise<NonNullable<V>> {
    for (const deadline = this.env.elapsed + limitMs; ;) {
      const value = await this.env.settle(Promise.resolve(check()));
      if (value) return value as NonNullable<V>;
      if (this.env.elapsed >= deadline) throw new Error(`Timed out (virtual ${limitMs} ms) waiting for ${what}`);
      await this.env.advance(everyMs);
    }
  }

  /** Stop every node (without waiting for turns), the database and the environment. */
  async close() {
    try {
      for (const node of this.nodes.values()) await this.env.settle(node.runtime.close()).catch(() => {});
      this.nodes.clear();
    } finally {
      this.env.uninstall();
      await this.db.close();
      rmSync(this.root, { recursive: true, force: true });
    }
  }
}
