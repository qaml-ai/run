import { createRoute, z, type RouteConfig } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { LEDGER_KINDS, type EndUserCredits, type LedgerKind } from "./end-user-credits.ts";
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

/** A ledger's `kind` filter: comma-separated kinds. */
const kinds = (value: string) => {
  const list = value.split(",").map(kind => kind.trim()).filter(Boolean);
  if (!list.length || list.some(kind => !(LEDGER_KINDS as readonly string[]).includes(kind))) throw new HttpError(400, `kind must be a comma-separated list of ${LEDGER_KINDS.join(", ")}`);
  return list as LedgerKind[];
};
/** A time as a query gives it: epoch ms, a UTC day (YYYY-MM-DD) or an ISO 8601 time. */
const time = (value: string | undefined, what: string) => {
  if (value === undefined) return undefined;
  const at = /^\d+$/.test(value) ? Number(value) : /^\d{4}-\d{2}-\d{2}(?:T.+)?$/.test(value) ? Date.parse(/T/.test(value) ? value : `${value}T00:00:00Z`) : NaN;
  if (!Number.isSafeInteger(at)) throw new HttpError(400, `${what} must be epoch milliseconds, a UTC day (YYYY-MM-DD) or an ISO 8601 time`);
  return at;
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
  route(createRoute({ method: "patch", path: "/v1/end-user-settings", request: { body: body(schema.EndUserSettingsPatch) }, responses: { 200: reply("The settings now: allowances and bucket limits merged key by key", schema.EndUserSettings) } }),
    async c => json(c, 200, await service().setSettings(c.var.principal.tenant, await read(c), { merge: true })));

  route(createRoute({
    method: "get", path: "/v1/end-users",
    request: { query: z.object({
      after: z.string().optional().openapi({ description: "The previous page's next" }), limit: z.string().optional().openapi({ description: "1–200, default 50" }),
      belowLowBalance: z.enum(["true", "false"]).optional().openapi({ description: "true: only those whose balance is under the low-balance threshold that applies to them (an auto top-up sweep)" }),
    }) },
    responses: { 200: reply("The tenant's end users (each metered or credited at least once), by id", schema.EndUserList) },
  }), async c => {
    const below = c.req.query("belowLowBalance");
    if (below !== undefined && below !== "true" && below !== "false") throw new HttpError(400, "belowLowBalance must be true or false");
    return json(c, 200, await service().list(c.var.principal.tenant, { limit: page(c.req.query("limit"), "limit"), after: c.req.query("after"), belowLowBalance: below === "true" }));
  });
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
    request: {
      params: endUserId,
      query: z.object({
        before: z.string().optional().openapi({ description: "Entries older than this id: the previous page's next" }), limit: z.string().optional().openapi({ description: "1–200, default 50" }),
        kind: z.string().optional().openapi({ description: "Comma-separated kinds to include: grant, refund, adjustment, usage. `grant,refund,adjustment` is the person's credit history without usage", example: "grant,refund,adjustment" }),
        from: z.string().optional().openapi({ description: "Entries created at or after this time: epoch milliseconds, a UTC day (YYYY-MM-DD) or an ISO 8601 time" }),
        to: z.string().optional().openapi({ description: "Entries created before this time (exclusive), as `from`" }),
        bucket: z.string().optional().openapi({ description: "Only this bucket's usage" }),
        moved: z.enum(["true", "false"]).optional().openapi({ description: "true: only entries that moved the balance (usage the allowance paid for in full is left out)" }),
      }),
    },
    responses: { 200: reply("The end user's ledger, newest first: grants, refunds, adjustments and each call's usage, as filtered", schema.EndUserLedger) },
  }), async c => {
    const kind = c.req.query("kind"), moved = c.req.query("moved");
    if (moved !== undefined && moved !== "true" && moved !== "false") throw new HttpError(400, "moved must be true or false");
    return json(c, 200, await service().ledger(c.var.principal.tenant, c.req.param("id")!, {
      limit: page(c.req.query("limit"), "limit"), before: page(c.req.query("before"), "before"),
      ...(kind !== undefined ? { kinds: kinds(kind) } : {}), from: time(c.req.query("from"), "from"), to: time(c.req.query("to"), "to"),
      ...(c.req.query("bucket") !== undefined ? { bucket: c.req.query("bucket") } : {}), moved: moved === "true",
    }));
  });
  route(createRoute({
    method: "get", path: "/v1/end-users/{id}/days",
    request: {
      params: endUserId,
      query: z.object({
        from: z.string().optional().openapi({ description: "The first UTC day (YYYY-MM-DD); default: `to` less 366 days" }),
        to: z.string().optional().openapi({ description: "The UTC day after the last (exclusive; YYYY-MM-DD); default: tomorrow, so today is the newest. The previous page's next" }),
        bucket: z.string().optional().openapi({ description: "Only this bucket's spend (and no credit entries, which belong to no bucket)" }),
        limit: z.string().optional().openapi({ description: "Days a page, 1–100, default 31" }),
      }),
    },
    responses: { 200: reply("The end user's spend by bucket and credit entries per UTC day, newest first; days with neither are left out. A range spans at most 366 days", schema.EndUserDays) },
  }), async c => json(c, 200, await service().days(c.var.principal.tenant, c.req.param("id")!, {
    from: c.req.query("from"), to: c.req.query("to"), bucket: c.req.query("bucket"), limit: page(c.req.query("limit"), "limit"),
  })));
  route(createRoute({
    method: "post", path: "/v1/end-users/{id}/entries", request: { params: endUserId, body: body(schema.EndUserEntryInput) },
    responses: { 201: reply("The entry, posted", schema.EndUserEntry), 200: reply("The key was posted already: its entry", schema.EndUserEntry) },
  }), async c => {
    const posted = await service().post(c.var.principal.tenant, c.req.param("id")!, await read(c));
    return json(c, posted.replayed ? 200 : 201, posted);
  });
}
