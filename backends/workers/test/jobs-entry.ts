/** Local-only: the runtime's Worker plus a route that runs a job through jobDriver(), for computers.integration.ts. */
import worker from "../src/index.ts";
import { jobDriver, type JobDriverEnv } from "../src/jobs/driver.ts";
import type { JobResult, JobSpec } from "../src/jobs/job.ts";
export * from "../src/index.ts";

const base64 = (bytes: Uint8Array) => btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(""));
const unbase64 = (text: string) => Uint8Array.from(atob(text), char => char.charCodeAt(0));
/** A result as JSON: byte fields as base64. */
function jsonResult(result: JobResult) {
  if (!result.ok) return result;
  return {
    ...result,
    stdout: { ...result.stdout, bytes: base64(result.stdout.bytes) },
    stderr: { ...result.stderr, bytes: base64(result.stderr.bytes) },
    outputs: Object.fromEntries(Object.entries(result.outputs).map(([name, output]) => [name, { ...output, bytes: base64(output.bytes) }])),
  };
}

export default {
  ...worker,
  async fetch(request: Request, env: JobDriverEnv & { TEST_MODE?: string }, ctx: ExecutionContext) {
    const path = new URL(request.url).pathname;
    if (env.TEST_MODE === "1" && request.method === "POST" && (path === "/__test/jobs" || path === "/__test/jobs/stop")) {
      const found = jobDriver(env);
      if (!found.ok) return Response.json(found, { status: 503 });
      const body = await request.json() as JobSpec & { files?: Record<string, string> };
      if (path === "/__test/jobs/stop") return Response.json(await found.driver.stop(body.id));
      const files = body.files && Object.fromEntries(Object.entries(body.files).map(([name, text]) => [name, unbase64(text)]));
      return Response.json(jsonResult(await found.driver.run({ ...body, ...files ? { files } : {} })));
    }
    // The bucket's keys under a prefix (job host snapshots' tests read what is stored, and what was deleted).
    if (env.TEST_MODE === "1" && request.method === "GET" && path === "/__test/r2") {
      const bucket = (env as unknown as { BUCKET: R2Bucket }).BUCKET, prefix = new URL(request.url).searchParams.get("prefix") ?? "";
      const listed = await bucket.list({ prefix, limit: 1000 });
      return Response.json(listed.objects.map(object => ({ key: object.key, size: object.size })));
    }
    return (worker as unknown as { fetch(request: Request, env: unknown, ctx: ExecutionContext): Promise<Response> }).fetch(request, env, ctx);
  },
};
