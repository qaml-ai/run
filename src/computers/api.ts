import { createRoute, z, type RouteConfig } from "@hono/zod-openapi";
import type { Context } from "hono";
import { HttpError, readJson } from "../http.ts";
import type { Computers } from "./service.ts";
import { PROVIDERS } from "./providers.ts";
import { FORK_LIMITS, forkTargets } from "../core/computer-fork.ts";

type Route = (config: RouteConfig, handler: (c: Context<any>) => Promise<Response> | Response) => void;
const input = z.object({ agent: z.string().min(1), provider: z.enum(PROVIDERS), subagents: z.boolean().optional().openapi({ description: "Give newly created sub-agents their own connection with the same settings. Default true; inherited by their children too" }), credentials: z.record(z.string(), z.string()).optional().openapi({ description: "The provider account's credentials. Leave out with provider lambda or boat for the runtime-selected managed computer, billed to credit" }), leaseSeconds: z.number().int().min(60).max(86400).optional().openapi({ description: "With credentials: how long a session lasts, at most 900 (default 900). Managed Lambda: fixed session duration, at most 28800 (default 7200). Boat: idle lease, at most 24 hours after starting" }), dailySeconds: z.number().int().min(60).max(86400).optional().openapi({ description: "Session time a day: default 3600 with credentials, 86400 managed" }) }).strict()
  .refine(value => value.credentials !== undefined ? (value.leaseSeconds ?? 0) <= 900 : value.provider === "boat" || value.provider === "lambda");
const session = z.object({ id: z.string(), provider: z.enum(PROVIDERS), workspaceId: z.string().nullable(), state: z.enum(["starting", "active", "closing", "closed", "uncertain"]), recoveryRequired: z.boolean(), createdAt: z.number(), expiresAt: z.number(), closedAt: z.number().nullable(), error: z.string().optional() }).nullable();
const forkedFrom = z.object({ agent: z.string(), connection: z.string().optional(), snapshot: z.string(), provider: z.string(), at: z.number() }).openapi({ description: "A forked connection: whose computer it copies, and the snapshot its sessions start from" });
const connection = z.object({ id: z.string(), agent: z.string(), provider: z.enum(PROVIDERS), managed: z.boolean(), subagents: z.boolean(), leaseSeconds: z.number(), dailySeconds: z.number(), createdAt: z.number(), billing: z.enum(["provider_account", "credits"]), session, forkedFrom: forkedFrom.optional() });
const forkInput = z.object({ agents: z.array(z.string()).min(1).max(FORK_LIMITS.agents).optional().openapi({ description: "The agents to fork the computer into: each gets a connection whose sessions start from one snapshot of this computer, taken now. Each must have no computer connection yet" }), agent: z.string().optional().openapi({ description: "One agent, instead of agents" }) }).strict();
const forked = z.object({ snapshot: z.object({ id: z.string(), provider: z.string(), createdAt: z.number() }), forks: z.array(connection) });
const reply = (description: string, schema: z.ZodType = z.object({ stopped: z.boolean() })) => ({ description, content: { "application/json": { schema } } });
export function computerRoutes(route: Route, service: () => Computers | undefined, operatorOnly: (c: Context<any>) => string) {
  const get = () => { const value = service(); if (!value) throw new HttpError(503, "Computers unavailable"); return value; };
  const stopInput = z.object({ block: z.boolean().default(false).openapi({ description: "Also start no new managed computer for the account until DELETE /v1/tenants/{id}/computers/block" }) }).strict();
  const stopped = z.object({ stopped: z.number(), failed: z.number().openapi({ description: "Whose machine could not be deleted yet: it ends by itself at its deadline" }), blocked: z.boolean() });
  route(createRoute({ method: "post", path: "/v1/tenants/{id}/computers/stop", request: { params: z.object({ id: z.string() }), body: { content: { "application/json": { schema: stopInput } } } }, responses: { 200: reply("The platform operator stops an account's running managed computers. Its bring-your-own connections are its own and are not touched", stopped) } }), async c => {
    const by = operatorOnly(c);
    const value = stopInput.safeParse(await readJson(c.req.raw.body, 1024, {}));
    if (!value.success) throw new HttpError(400, "Invalid stop");
    return c.json(await get().managed.stopTenant(c.req.param("id")!, by, value.data.block));
  });
  route(createRoute({ method: "delete", path: "/v1/tenants/{id}/computers/block", request: { params: z.object({ id: z.string() }) }, responses: { 200: reply("The platform operator lets an account start managed computers again", z.object({ blocked: z.boolean() })) } }), c => {
    operatorOnly(c);
    return get().managed.unblockTenant(c.req.param("id")!).then(r => c.json(r));
  });
  route(createRoute({ method: "get", path: "/v1/computers/options", responses: { 200: reply("What this runtime offers: managed, a computer with no provider account of your own, billed to credit", z.object({ managed: z.boolean() })) } }), c => c.json({ managed: !!get().options.enabled }));
  route(createRoute({ method: "get", path: "/v1/computers", responses: { 200: reply("Computer connections; credentials are never returned", z.array(connection)) } }), c => get().list(c.var.principal.tenant).then(r => c.json(r)));
  route(createRoute({ method: "post", path: "/v1/computers", request: { body: { content: { "application/json": { schema: input } } } }, responses: { 201: reply("Connect an agent to a provider, whose account bills the compute, or to a managed computer, billed to credit", connection) } }), async c => {
    const value = input.safeParse(await readJson(c.req.raw.body, 65536, {}));
    if (!value.success) throw new HttpError(400, "Invalid computer connection");
    return c.json(await get().create(c.var.principal.tenant, value.data), 201);
  });
  const fork = async (c: Context<any>, source: { agent?: string; connection?: string }) => {
    const body = await readJson(c.req.raw.body, 8192, {});
    const agents = forkTargets(body, source.agent ?? "");
    return c.json(await get().forkInto(c.var.principal.tenant, source, agents), 201);
  };
  const forkDoc = "Fork this computer into other agents: one exact snapshot of its running session's disk, taken now, and for each agent a connection whose sessions start from it. Each fork is its own machine, billed as any session; writes never reach the source or each other. 409 FORK_UNSUPPORTED when the provider cannot copy a disk (Lambda, Sprites, E2B, Daytona, Modal, tunnels, browsers; Boat can), 409 NO_SESSION when no session runs";
  route(createRoute({ method: "post", path: "/v1/computers/{id}/fork", request: { params: z.object({ id: z.string() }), body: { content: { "application/json": { schema: forkInput } } } }, responses: { 201: reply(forkDoc, forked) } }), c => fork(c, { connection: c.req.param("id")! }));
  route(createRoute({ method: "post", path: "/v1/agents/{id}/computer/fork", request: { params: z.object({ id: z.string() }), body: { content: { "application/json": { schema: forkInput } } } }, responses: { 201: reply(`${forkDoc}. The same as POST /v1/computers/{id}/fork, by the agent`, forked) } }), c => fork(c, { agent: c.req.param("id")! }));
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
