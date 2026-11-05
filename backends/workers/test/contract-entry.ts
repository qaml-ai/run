/** Local-only fixture adapter. It is never referenced by a deployment config. */
import application from "../src/index.ts";
import { CamelAgent as RuntimeAgent } from "../src/agent.ts";
import type { Env } from "../src/agent.ts";
import { withSql } from "../src/postgres.ts";
export * from "../src/index.ts";

const resizeFailureKey = "contract-fixture/image-resize-failures";
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

async function fixtureConfiguration(env: Env): Promise<string> {
  const config = await withSql(env, (sql) => sql.query(
    "select configuration from contract_fixture_configuration where singleton=true",
  ));
  if (!config.rows[0]) throw new Error("Missing contract fixture configuration");
  return JSON.stringify(config.rows[0].configuration);
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
    this.env.AGENT_TENANTS_JSON = await fixtureConfiguration(this.env);
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
    if (this.env.TEST_MODE === "1" && new URL(request.url).pathname === "/__test/contract-schedule-due" && request.method === "POST") {
      const { id, dueAt, history } = await request.json() as { id: string; dueAt: number; history?: "none" };
      if (typeof id !== "string" || !Number.isSafeInteger(dueAt) || (history !== undefined && history !== "none")) return Response.json({ error: "Invalid schedule fixture input" }, { status: 400 });
      const key = `schedule:${id}`;
      const schedule = await this.ctx.storage.get<Record<string, unknown>>(key);
      if (!schedule) return Response.json({ error: "Unknown schedule" }, { status: 404 });
      await this.ctx.storage.put(key, { ...schedule, dueAt, ...(history === undefined ? {} : { history }) });
      // arm is intentionally private to the runtime. Only this non-deployed test
      // subclass prepares due times; it must not duplicate the alarm implementation.
      await (this as unknown as { arm(): Promise<void> }).arm();
      return Response.json({ updated: true });
    }
    return super.fetch(request);
  }
}

export default {
  ...application,
  async fetch(request: Request, env: Env, context: ExecutionContext) {
    if (env.TEST_MODE !== "1") return new Response("Test fixture disabled", { status: 404 });
    if (new URL(request.url).pathname === "/__test/image-resize-failures")
      return Response.json({ count: await env.BUCKET.head(resizeFailureKey) ? 1 : 0 });
    if (new URL(request.url).pathname === "/healthz") return application.fetch(request, env, context);
    return application.fetch(request, {
      ...env, AGENT_TENANTS_JSON: await fixtureConfiguration(env),
    }, context);
  },
};
