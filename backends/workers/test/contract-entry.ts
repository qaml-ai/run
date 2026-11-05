/** Local-only fixture adapter. It is never referenced by a deployment config. */
import application from "../src/index.ts";
import { CamelAgent as RuntimeAgent } from "../src/agent.ts";
import type { Env } from "../src/agent.ts";
import { withSql } from "../src/postgres.ts";
import { digest } from "../src/api-contract.ts";
export * from "../src/index.ts";

/** Clock preparation only: execution still runs through the original DO alarm/job. */
export class CamelAgent extends RuntimeAgent {
  async fetch(request: Request) {
    if (this.env.TEST_MODE === "1" && new URL(request.url).pathname === "/__test/contract-schedule-due" && request.method === "POST") {
      const { id, dueAt } = await request.json() as { id: string; dueAt: number };
      if (typeof id !== "string" || !Number.isSafeInteger(dueAt)) return Response.json({ error: "Invalid schedule fixture input" }, { status: 400 });
      const key = `schedule:${id}`;
      const schedule = await this.ctx.storage.get<Record<string, unknown>>(key);
      if (!schedule) return Response.json({ error: "Unknown schedule" }, { status: 404 });
      await this.ctx.storage.put(key, { ...schedule, dueAt });
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
    if (new URL(request.url).pathname === "/healthz") return application.fetch(request, env, context);
    const token = request.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
    if (token) {
      const hash = await digest(token);
      const found = await withSql(env, (sql) => sql.query(
        "select tenant from contract_fixture_operators where sha256=$1",
        [hash],
      ));
      if (found.rows[0]) {
        // The production entrypoint has one configured operator. Tests can seed several,
        // as Node's tenants file does, without changing any public authentication route.
        const headers = new Headers(request.headers);
        headers.set("authorization", `Bearer ${env.API_TOKEN}`);
        return application.fetch(new Request(request, { headers }), {
          ...env, DEFAULT_TENANT: found.rows[0].tenant,
        }, context);
      }
    }
    return application.fetch(request, env, context);
  },
};
