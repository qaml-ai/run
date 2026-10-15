import { createRoute, z, type RouteConfig } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { EndUserCredits } from "./end-user-credits.ts";
import { HttpError, readJson } from "./http.ts";
import * as schema from "./api-schemas.ts";

type Route = (config: RouteConfig, handler: (c: Context<any>) => Promise<Response> | Response) => void;
const json = (c: Context, status: number, value: unknown) => c.json(value, status as ContentfulStatusCode, { "Cache-Control": "no-store" });
const reply = (description: string, value: z.ZodType) => ({ description, content: { "application/json": { schema: value } } });
const body = (value: z.ZodType) => ({ content: { "application/json": { schema: value } } });
const endUserId = z.object({ id: z.string().openapi({ description: "The end user: the subject of the agents and calls that spend for them (URL-encoded)" }) });
const page = (value: string | undefined, what: string) => {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new HttpError(400, `${what} must be a positive integer`);
  return number;
};

/** /v1/end-user-settings and /v1/end-users: a tenant's own users' credit (end-user-credits.ts). */
export function endUserRoutes(route: Route, context: () => EndUserCredits | undefined) {
  const service = () => {
    const value = context();
    if (!value) throw new HttpError(404, "End-user credits are not enabled on this runtime");
    return value;
  };
  const read = (c: Context) => readJson(c.req.raw.body, 64 * 1024, {}) as Promise<Record<string, unknown>>;

  route(createRoute({ method: "get", path: "/v1/end-user-settings", responses: { 200: reply("How the tenant meters its end users", schema.EndUserSettings) } }),
    async c => json(c, 200, await service().settings(c.var.principal.tenant)));
  route(createRoute({ method: "put", path: "/v1/end-user-settings", request: { body: body(schema.EndUserSettingsInput) }, responses: { 200: reply("The settings now; a changed allowance applies to the next call and keeps what was spent today", schema.EndUserSettings) } }),
    async c => json(c, 200, await service().setSettings(c.var.principal.tenant, await read(c))));

  route(createRoute({
    method: "get", path: "/v1/end-users",
    request: { query: z.object({ after: z.string().optional().openapi({ description: "The previous page's next" }), limit: z.string().optional().openapi({ description: "1–200, default 50" }) }) },
    responses: { 200: reply("The tenant's end users (each metered or credited at least once), by id", schema.EndUserList) },
  }), async c => json(c, 200, await service().list(c.var.principal.tenant, { limit: page(c.req.query("limit"), "limit"), after: c.req.query("after") })));
  route(createRoute({
    method: "get", path: "/v1/end-users/{id}",
    request: { params: endUserId, query: z.object({ buckets: z.string().optional().openapi({ description: "Comma-separated buckets to include in today's spend even if unused today, e.g. builder,bot:42" }) }) },
    responses: { 200: reply("The end user's balance, limits and today's spend by bucket; one never seen is shown at zero", schema.EndUser) },
  }), async c => {
    const buckets = c.req.query("buckets")?.split(",").filter(Boolean) ?? [];
    if (buckets.length > 50) throw new HttpError(400, "Ask for at most 50 buckets");
    return json(c, 200, await service().get(c.var.principal.tenant, c.req.param("id")!, buckets));
  });
  route(createRoute({ method: "patch", path: "/v1/end-users/{id}", request: { params: endUserId, body: body(schema.EndUserUpdate) }, responses: { 200: reply("The end user with their new overrides; what they spent is unchanged", schema.EndUser) } }),
    async c => json(c, 200, await service().update(c.var.principal.tenant, c.req.param("id")!, await read(c))));
  route(createRoute({
    method: "get", path: "/v1/end-users/{id}/ledger",
    request: { params: endUserId, query: z.object({ before: z.string().optional().openapi({ description: "Entries older than this id: the previous page's next" }), limit: z.string().optional().openapi({ description: "1–200, default 50" }) }) },
    responses: { 200: reply("The end user's ledger, newest first: grants, refunds, adjustments and each call's usage", schema.EndUserLedger) },
  }), async c => json(c, 200, await service().ledger(c.var.principal.tenant, c.req.param("id")!, { limit: page(c.req.query("limit"), "limit"), before: page(c.req.query("before"), "before") })));
  route(createRoute({
    method: "post", path: "/v1/end-users/{id}/entries", request: { params: endUserId, body: body(schema.EndUserEntryInput) },
    responses: { 201: reply("The entry, posted", schema.EndUserEntry), 200: reply("The key was posted already: its entry", schema.EndUserEntry) },
  }), async c => {
    const posted = await service().post(c.var.principal.tenant, c.req.param("id")!, await read(c));
    return json(c, posted.replayed ? 200 : 201, posted);
  });
}
