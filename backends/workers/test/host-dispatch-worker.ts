import worker from "../src/index.ts";
import type { Env } from "../src/agent.ts";
import type { JobHostsEnv } from "../src/jobs/hosts.ts";
import type { JobSpec } from "../src/jobs/job.ts";
import type { WireJob } from "../../../shared/job-host-protocol.ts";
export * from "../src/index.ts";

// Direct re-entry with the same job id, as workflow recovery does after an interrupted RPC.
export default {
  async fetch(request: Request, env: Env & JobHostsEnv, ctx: ExecutionContext) {
    const path = new URL(request.url).pathname;
    if (env.TEST_MODE === "1" && ["/__test/host-job", "/__test/host-dispatch"].includes(path)) {
      if (request.headers.get("authorization") !== `Bearer ${env.API_TOKEN}`) return new Response(null, { status: 401 });
      if (path === "/__test/host-job") {
        const spec = await request.json() as JobSpec;
        return Response.json(await env.HOST_JOBS!.getByName(spec.id).run(spec));
      }
      const { id, spec } = await request.json() as { id: string; spec: WireJob };
      return Response.json(await env.JOB_HOSTS!.getByName("restart-host").dispatch(id, spec, 60_000));
    }
    return worker.fetch(request, env, ctx);
  },
};
export { CamelfsStub } from "./camelfs-stub.ts";
