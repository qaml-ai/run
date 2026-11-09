/** Local-only fixture adapter. It is never referenced by a deployment config. */
import application from "../src/index.ts";
import { CamelAgent as RuntimeAgent } from "../src/agent.ts";
import { ARM_AGENT, DUE_HUMAN_INPUTS, SHARED_ADMISSION_STATE, SUBMIT_SHARED_PROMPT } from "../src/agent-internals.ts";
import type { Env } from "../src/agent.ts";
import type { DelegatedChild } from "../src/delegation.ts";
import { databaseUnavailable, withSql } from "../src/postgres.ts";
export * from "../src/index.ts";

const resizeFailureKey = "contract-fixture/image-resize-failures";
const pendingQueues = new Set<Promise<void>>();
function imageFailureEnvironment(env: Env): Env {
  if ((env as Env & { TEST_IMAGE_RESIZE_FAILURE_ONCE?: string }).TEST_IMAGE_RESIZE_FAILURE_ONCE !== "1") return env;
  // Fail the real Images transform once, at its external-service boundary. The
  // production request preparation decides whether to omit and retry it.
  const images = env.IMAGES;
  return { ...env, IMAGES: new Proxy(images, {
    get(target, name) {
      if (name !== "input") return Reflect.get(target, name);
      return (...args: Parameters<ImagesBinding["input"]>) => {
        let pipeline = images.input(...args);
        const proxy: ImagesInput = new Proxy(pipeline, {
          get(_target, key) {
            if (key === "transform") return (...options: Parameters<ImagesInput["transform"]>) => { pipeline = pipeline.transform(...options); return proxy; };
            if (key === "output") return async (...options: Parameters<ImagesInput["output"]>) => {
              if (!await env.BUCKET.head(resizeFailureKey)) {
                await env.BUCKET.put(resizeFailureKey, "1");
                throw new Error("Image service interrupted");
              }
              return pipeline.output(...options);
            };
            const value = Reflect.get(pipeline, key);
            return typeof value === "function" ? value.bind(pipeline) : value;
          },
        });
        return proxy;
      };
    },
  }) };
}

const configurationReads = new Map<string, Promise<string>>();
function fixtureConfiguration(env: Env): Promise<string> {
  const key = env.HYPERDRIVE.connectionString;
  let pending = configurationReads.get(key);
  if (!pending) {
    pending = readFixtureConfiguration(env).finally(() => {
      if (configurationReads.get(key) === pending) configurationReads.delete(key);
    });
    configurationReads.set(key, pending);
  }
  return pending;
}

async function readFixtureConfiguration(env: Env): Promise<string> {
  // A burst of disconnected readers must not fan out fixture-only reloads or
  // poison the next request with a closed socket. Retain no settled result:
  // the next request still observes changes made through the fixture database.
  for (let attempt = 0; ; attempt++) {
    try {
      const config = await withSql(env, (sql) => sql.query(
        "select configuration from contract_fixture_configuration where singleton=true",
      ));
      if (!config.rows[0]) throw new Error("Missing contract fixture configuration");
      return JSON.stringify(config.rows[0].configuration);
    } catch (error) {
      if (attempt >= 2 || !databaseUnavailable(error)) throw error;
      await new Promise(resolve => setTimeout(resolve, 10 * (attempt + 1)));
    }
  }
}

// A deployment keeps its environment identity between requests. Preserve that
// identity until the fixture's tenant configuration actually changes, while
// still reading every request so configuration reload assertions stay live.
const configuredEnvironments = new WeakMap<Env, { configuration: string; env: Env }>();
async function configuredEnvironment(env: Env): Promise<Env> {
  const configuration = await fixtureConfiguration(env);
  const previous = configuredEnvironments.get(env);
  if (previous?.configuration === configuration) return previous.env;
  const configured = { ...env, AGENT_TENANTS_JSON: configuration };
  configuredEnvironments.set(env, { configuration, env: configured });
  return configured;
}

/** Clock preparation only: execution still runs through the original DO alarm/job. */
export class CamelAgent extends RuntimeAgent {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, imageFailureEnvironment({ ...env }));
    // Lifecycle installs its alarm handler during super(). Wrap that installed
    // handler, preserving Pi's job dispatch and re-arm behavior unchanged.
    const alarm = this.alarm?.bind(this);
    if (!alarm) throw new Error("Contract fixture requires the runtime alarm handler");
    Object.defineProperty(this, "alarm", { configurable: true, value: async (...args: Parameters<NonNullable<typeof alarm>>) => {
      this.env.AGENT_TENANTS_JSON = await fixtureConfiguration(this.env);
      return alarm(...args);
    } });
  }

  async fetch(request: Request) {
    if (new URL(request.url).pathname === "/__test/shared-state") return Response.json(await this[SHARED_ADMISSION_STATE]());
    if (new URL(request.url).pathname === "/__test/shared-prompt" && request.method === "POST") {
      const { member, ...params } = await request.json() as Record<string, unknown>;
      try {
        const record = await this[SUBMIT_SHARED_PROMPT]({ id: crypto.randomUUID(), method: "prompt", params }, String(member));
        return Response.json({ id: record.id, state: record.state }, { status: 202 });
      } catch (error) {
        return Response.json({ error: String((error as Error).message) }, { status: (error as { status?: number }).status ?? 500 });
      }
    }
    const configuration = fixtureConfiguration(this.env);
    // A disconnected request must not interrupt the fixture's tenant reload
    // before the real runtime receives its aborted signal.
    this.ctx.waitUntil(configuration.catch(() => {}));
    this.env.AGENT_TENANTS_JSON = await configuration;
    if (this.env.TEST_MODE === "1" && new URL(request.url).pathname === "/__test/contract-legacy-model" && request.method === "POST") {
      const { model } = await request.json() as { model: { provider: string; id: string } };
      if (!model || typeof model.provider !== "string" || typeof model.id !== "string") return Response.json({ error: "Invalid legacy model fixture input" }, { status: 400 });
      const configuration = await this.ctx.storage.get<Record<string, unknown>>("configuration");
      if (!configuration) return Response.json({ error: "Unknown agent" }, { status: 404 });
      // The stored resolved model is the Workers counterpart of Node's legacy
      // model object. Restart below makes the real runtime reload these facts.
      await this.ctx.storage.put("configuration", { ...configuration, resolvedModel: model });
      return Response.json({ updated: true });
    }
    if (this.env.TEST_MODE === "1" && new URL(request.url).pathname === "/__test/contract-child-settlement" && request.method === "POST") {
      // Match the Node fixture's lost-settlement state. Prior charges remain;
      // recovery must discover and land the completed child again itself.
      const children = await this.ctx.storage.list<DelegatedChild>({ prefix: "delegation:" });
      if (!children.size) return Response.json({ error: "Fixture child settlement not found" }, { status: 404 });
      await this.ctx.storage.transaction(async tx => {
        for (const [key, child] of children) await tx.put(key, {
          ...child, status: "running", endedAt: undefined, landedBy: undefined,
          charged: undefined,
        });
      });
      await this[ARM_AGENT](Date.now() + 300);
      return Response.json({ updated: children.size });
    }
    if (this.env.TEST_MODE === "1" && new URL(request.url).pathname === "/__test/contract-inputs-due" && request.method === "POST") {
      // Match the Node fixture's due inputs: each pending input's time is up now. The runtime's own alarm then expires
      // them, as it would after their wait.
      const due = await this[DUE_HUMAN_INPUTS](Date.now());
      if (!due) return Response.json({ error: "Fixture inputs not found" }, { status: 404 });
      return Response.json({ updated: due });
    }
    if (this.env.TEST_MODE === "1" && new URL(request.url).pathname === "/__test/contract-schedule-due" && request.method === "POST") {
      const { id, dueAt, history } = await request.json() as { id: string; dueAt: number; history?: "none" };
      if (typeof id !== "string" || !Number.isSafeInteger(dueAt) || (history !== undefined && history !== "none")) return Response.json({ error: "Invalid schedule fixture input" }, { status: 400 });
      const key = `schedule:${id}`;
      const schedule = await this.ctx.storage.get<Record<string, unknown>>(key);
      if (!schedule) return Response.json({ error: "Unknown schedule" }, { status: 404 });
      await this.ctx.storage.put(key, { ...schedule, dueAt, ...(history === undefined ? {} : { history }) });
      // The subclass capability prepares due times through the same runtime alarm
      // implementation without exposing a string-addressable RPC method.
      await this[ARM_AGENT]();
      return Response.json({ updated: true });
    }
    return super.fetch(request);
  }
}

export default {
  ...application,
  async queue(batch: Parameters<typeof application.queue>[0], env: Parameters<typeof application.queue>[1]) {
    const pending = application.queue(batch, env);
    pendingQueues.add(pending);
    try { await pending; }
    finally { pendingQueues.delete(pending); }
  },
  async fetch(request: Request, env: Env, context: ExecutionContext) {
    if (env.TEST_MODE !== "1") return new Response("Test fixture disabled", { status: 404 });
    if (request.method === "POST" && new URL(request.url).pathname === "/__test/drain") {
      // Miniflare.dispose() kills workerd. A graceful source-host stop lets
      // admitted deliveries finish their SQL writes before the process exits.
      await Promise.allSettled([...pendingQueues]);
      return new Response(null, { status: 204 });
    }
    if (new URL(request.url).pathname === "/__test/image-resize-failures")
      return Response.json({ count: await env.BUCKET.head(resizeFailureKey) ? 1 : 0 });
    const sharedState = /^\/__test\/shared-state\/([^/]+)$/.exec(new URL(request.url).pathname);
    if (sharedState) return env.AGENTS.getByName(sharedState[1]).fetch(new Request("https://fixture/__test/shared-state"));
    const sharedMatch = /^\/__test\/shared\/([^/]+)\/([^/]+)$/.exec(new URL(request.url).pathname);
    if (sharedMatch && request.method === "POST") {
      return env.AGENTS.getByName(sharedMatch[1]).fetch(new Request("https://fixture/__test/shared-prompt", {
        method: "POST", body: JSON.stringify({ ...await request.json() as object, member: sharedMatch[2] }),
      }));
    }
    if (new URL(request.url).pathname === "/healthz") return application.fetch(request, env, context);
    const configuration = configuredEnvironment(env);
    context.waitUntil(configuration.then(() => {}, () => {}));
    return application.fetch(request, await configuration, context);
  },
};
