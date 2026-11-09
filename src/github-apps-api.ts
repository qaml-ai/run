import { createRoute, z, type RouteConfig } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { GitHubApps } from "./core/github-apps.ts";
import { HttpError, readJson } from "./http.ts";
import * as schema from "./api-schemas.ts";

type Route = (config: RouteConfig, handler: (c: Context<any>) => Promise<Response> | Response) => void;
const json = (c: Context, status: number, value: unknown) => c.json(value, status as ContentfulStatusCode, { "Cache-Control": "no-store" });
const reply = (description: string, value: z.ZodType) => ({ description, content: { "application/json": { schema: value } } });
const body = (value: z.ZodType) => ({ content: { "application/json": { schema: value } } });
const appRef = z.object({ app: z.string().openapi({ description: "The App's id (gha_…) or name" }) });

/** A body as sent: the shared service checks it, so both backends answer it alike (the schemas are for the OpenAPI document). */
const parse = (_type: z.ZodType, c: Context) => readJson(c.req.raw.body, 64 * 1024, {}) as Promise<Record<string, unknown>>;

/** /v1/github-apps: a tenant's GitHub Apps. Keys and secrets go in and never come out; tokens are minted where definitions ask. */
export function githubAppRoutes(route: Route, apps: () => GitHubApps | undefined) {
  const service = (c: Context) => {
    try { decodeURI(c.req.path); } catch { throw new HttpError(400, "Invalid path encoding"); }
    const value = apps();
    if (!value) throw new HttpError(404, "GitHub Apps are not enabled on this runtime");
    return value;
  };
  route(createRoute({ method: "get", path: "/v1/github-apps/{app}/repositories", request: { params: appRef, query: z.object({ cursor: z.string().optional(), perPage: z.string().optional() }) }, responses: { 200: reply("A page of installation repositories; follow nextCursor until null, including empty pages", schema.GitHubRepositories) } }),
    async c => json(c, 200, await service(c).repositories(c.var.principal.tenant, c.req.param("app")!, c.req.query("cursor"), c.req.query("perPage") === undefined ? 100 : Number(c.req.query("perPage")))));
  route(createRoute({ method: "get", path: "/v1/github-apps/{app}/repositories/{owner}/{name}", request: { params: appRef.extend({ owner: z.string(), name: z.string() }) }, responses: { 200: reply("Repository the installation can access; 404 if unavailable", schema.GitHubRepository) } }),
    async c => json(c, 200, await service(c).repository(c.var.principal.tenant, c.req.param("app")!, c.req.param("owner")!, c.req.param("name")!)));
  route(createRoute({ method: "get", path: "/v1/github-apps", responses: { 200: reply("The tenant's GitHub Apps, their credentials masked", z.array(schema.GitHubApp)) } }),
    async c => json(c, 200, await service(c).list(c.var.principal.tenant)));
  route(createRoute({ method: "post", path: "/v1/github-apps", request: { body: body(schema.GitHubAppInput) }, responses: { 201: reply("The App, its key checked with GitHub (GET /app) and stored encrypted", schema.GitHubApp) } }),
    async c => json(c, 201, await service(c).create(c.var.principal.tenant, await parse(schema.GitHubAppInput, c))));
  route(createRoute({ method: "post", path: "/v1/github-apps/manifest", request: { body: body(schema.GitHubAppManifestInput) }, responses: { 201: reply("The App GitHub made from your manifest, with its key and webhook secret stored encrypted", schema.GitHubApp) } }),
    async c => json(c, 201, await service(c).fromManifest(c.var.principal.tenant, await parse(schema.GitHubAppManifestInput, c))));
  route(createRoute({ method: "get", path: "/v1/github-apps/{app}", request: { params: appRef }, responses: { 200: reply("The App", schema.GitHubApp) } }),
    async c => json(c, 200, await service(c).get(c.var.principal.tenant, c.req.param("app")!)));
  route(createRoute({ method: "patch", path: "/v1/github-apps/{app}", request: { params: appRef, body: body(schema.GitHubAppUpdate) }, responses: { 200: reply("The App: renamed, its key rotated (tokens are minted with the new key from now on) or its webhook secret changed", schema.GitHubApp) } }),
    async c => json(c, 200, await service(c).update(c.var.principal.tenant, c.req.param("app")!, await parse(schema.GitHubAppUpdate, c))));
  route(createRoute({ method: "delete", path: "/v1/github-apps/{app}", request: { params: appRef }, responses: { 200: reply("The App is deleted: no token is minted from it again, and the ones this node holds are revoked", schema.Deleted) } }), async c => {
    await service(c).remove(c.var.principal.tenant, c.req.param("app")!);
    return json(c, 200, { deleted: true });
  });
}
