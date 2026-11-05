/** Local-only fixture adapter. It is never referenced by a deployment config. */
import application from "../src/index.ts";
import type { Env } from "../src/agent.ts";
import { withSql } from "../src/postgres.ts";
import { digest } from "../src/api-contract.ts";
export * from "../src/index.ts";

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
