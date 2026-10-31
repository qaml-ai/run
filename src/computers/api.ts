import { createRoute, z, type RouteConfig } from "@hono/zod-openapi";
import type { Context } from "hono";
import { HttpError, readJson } from "../http.ts";
import type { Computers } from "./service.ts";
import { PROVIDERS } from "./providers.ts";

type Route = (config: RouteConfig, handler: (c: Context<any>) => Promise<Response> | Response) => void;
const input = z.object({ agent: z.string().min(1), provider: z.enum(PROVIDERS), credentials: z.record(z.string(), z.string()).optional().openapi({ description: "The provider account's credentials. Leave out with provider boat for a managed computer, billed to credit" }), leaseSeconds: z.number().int().min(60).max(86400).optional().openapi({ description: "With credentials: how long a session lasts, at most 900 (default 900). Managed: how long it stays after its latest command, at most 24 hours after it started (default 7200)" }), dailySeconds: z.number().int().min(60).max(86400).optional().openapi({ description: "Session time a day: default 3600 with credentials, 86400 managed" }) }).strict()
  .refine(value => value.credentials !== undefined ? (value.leaseSeconds ?? 0) <= 900 : value.provider === "boat");
const session = z.object({ id: z.string(), provider: z.enum(PROVIDERS), workspaceId: z.string().nullable(), state: z.enum(["starting", "active", "closing", "closed", "uncertain"]), recoveryRequired: z.boolean(), createdAt: z.number(), expiresAt: z.number(), closedAt: z.number().nullable(), error: z.string().optional() }).nullable();
const connection = z.object({ id: z.string(), agent: z.string(), provider: z.enum(PROVIDERS), managed: z.boolean(), leaseSeconds: z.number(), dailySeconds: z.number(), createdAt: z.number(), billing: z.enum(["provider_account", "credits"]), session });
const reply = (description: string, schema: z.ZodType = z.object({ stopped: z.boolean() })) => ({ description, content: { "application/json": { schema } } });
export function computerRoutes(route: Route, service: () => Computers | undefined) {
  const get = () => { const value = service(); if (!value) throw new HttpError(503, "Computers unavailable"); return value; };
  route(createRoute({ method: "get", path: "/v1/computers", responses: { 200: reply("Computer connections; credentials are never returned", z.array(connection)) } }), c => get().list(c.var.principal.tenant).then(r => c.json(r)));
  route(createRoute({ method: "post", path: "/v1/computers", request: { body: { content: { "application/json": { schema: input } } } }, responses: { 201: reply("Connect an agent to a provider, whose account bills the compute, or to a managed computer, billed to credit", connection) } }), async c => {
    const value = input.safeParse(await readJson(c.req.raw.body, 65536, {}));
    if (!value.success) throw new HttpError(400, "Invalid computer connection");
    return c.json(await get().create(c.var.principal.tenant, value.data), 201);
  });
  route(createRoute({ method: "delete", path: "/v1/computers/{id}", request: { params: z.object({ id: z.string() }) }, responses: { 200: reply("Stop sessions and remove credentials", z.object({ removed: z.boolean() })) } }), c => get().remove(c.var.principal.tenant, c.req.param("id")!).then(r => c.json(r)));
  route(createRoute({ method: "get", path: "/v1/computers/usage", responses: { 200: reply("Compute session time grouped by provider and workspace, separate from model billing", z.array(z.object({ workspace: z.string().nullable(), provider: z.enum(PROVIDERS), sessions: z.number(), seconds: z.union([z.number(),z.string()]), costUsd: z.number().openapi({ description: "Charged to credit: time on the platform's keys. Time on your own provider account costs 0 here" }) }))) } }), c => get().usage(c.var.principal.tenant).then(r => c.json(r)));
  route(createRoute({ method: "get", path: "/v1/agents/{id}/computer", request: { params: z.object({ id: z.string() }) }, responses: { 200: reply("Connection and session status", z.object({ connection, session })) } }), c => get().status(c.var.principal.tenant, c.req.param("id")!).then(r => c.json(r)));
  route(createRoute({ method: "post", path: "/v1/agents/{id}/computer/stop", request: { params: z.object({ id: z.string() }) }, responses: { 200: reply("Stop the agent's current computer session") } }), c => get().call(c.var.principal.tenant, c.req.param("id")!, "computer_stop", {}, c.req.header("Idempotency-Key") ?? crypto.randomUUID()).then(r => c.json(r)));
  const confirmed = z.object({ providerCleanupConfirmed: z.literal(true) }).strict();
  route(createRoute({ method: "post", path: "/v1/agents/{id}/computer/confirm-cleanup", request: { params: z.object({ id: z.string() }), body: { content: { "application/json": { schema: confirmed } } } }, responses: { 200: reply("Confirm manual provider cleanup after a failed creation or cleanup", z.object({ confirmed: z.boolean() })) } }), async c => {
    if (!confirmed.safeParse(await readJson(c.req.raw.body, 1024, {})).success) throw new HttpError(400, "Verify the computer was removed in your provider account before confirming");
    return c.json(await get().confirmCleanup(c.var.principal.tenant, c.req.param("id")!));
  });
}
