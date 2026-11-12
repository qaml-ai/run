import worker from "../src/index.ts";
import type { Env } from "../src/agent.ts";
import type { JobHostsEnv } from "../src/jobs/hosts.ts";
import type { JobSpec } from "../src/jobs/job.ts";
export * from "../src/index.ts";

/** Test-only RPC bridge: run two distinct jobs against the exact same immutable snapshot. */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    if (new URL(request.url).pathname === "/__test/camelfs-job" && env.TEST_MODE === "1") {
      if (request.headers.get("authorization") !== `Bearer ${env.API_TOKEN}`) return new Response(null, { status: 401 });
      const spec = await request.json() as JobSpec;
      return Response.json(await (env as Env & JobHostsEnv).HOST_JOBS!.getByName(spec.id).run(spec));
    }
    return worker.fetch(request, env, ctx);
  },
};
