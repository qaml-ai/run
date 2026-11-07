import { HttpError } from "./errors.ts";
import type { Env } from "./agent-types.ts";
import { workerGitHubApps, type GitHubAppsEnv } from "./github-apps.ts";

/**
 * The GitHub App API, as src/github-apps-api.ts answers it on ECS: /v1/github-apps. Keys and webhook secrets go in and
 * never come out; the shared service (src/core/github-apps.ts) checks every body, so both backends answer alike.
 */

const reply = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });

/** A shared error (src/core/http-error.ts) as this backend answers errors. */
function answerable(error: unknown): never {
  const failure = error as { status?: unknown; message?: string; code?: unknown };
  if (typeof failure?.status === "number" && failure.status >= 400 && failure.status < 600 && error instanceof Error)
    throw new HttpError(failure.status, failure.message ?? "Request failed", typeof failure.code === "string" ? failure.code : undefined);
  throw error;
}

async function body(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.length > 64 * 1024) throw new HttpError(413, "Request too large");
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw new HttpError(400, "Invalid JSON"); }
}

/** `/v1/github-apps` and below, for an authenticated tenant; undefined for other paths. */
export async function githubAppRoutes(request: Request, env: Env, auth: { tenantId: string; kind: string }): Promise<Response | undefined> {
  const match = /^\/v1\/github-apps(?:\/([^/]+))?$/.exec(new URL(request.url).pathname);
  if (!match) return undefined;
  const [, ref] = match, method = request.method;
  const route = !ref ? method === "GET" || method === "POST" : ref === "manifest" ? method === "POST" : ["GET", "PATCH", "DELETE"].includes(method);
  if (!route) return undefined;
  // An App says where its tokens may go (hosts): an OAuth client acting for the tenant neither reads nor changes one.
  if (auth.kind === "oauth") throw new HttpError(403, "An OAuth access token works with agents only: use an API token or the console");
  const tenant = auth.tenantId;
  try {
    const apps = await workerGitHubApps(env as unknown as GitHubAppsEnv);
    if (!ref) return method === "GET" ? reply(await apps.list(tenant)) : reply(await apps.create(tenant, await body(request)), 201);
    if (ref === "manifest") return reply(await apps.fromManifest(tenant, await body(request)), 201);
    const app = decodeURIComponent(ref);
    if (method === "GET") return reply(await apps.get(tenant, app));
    if (method === "PATCH") return reply(await apps.update(tenant, app, await body(request)));
    await apps.remove(tenant, app);
    return reply({ deleted: true });
  } catch (error) { return answerable(error); }
}
