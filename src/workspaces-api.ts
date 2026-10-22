import { createRoute, z, type RouteConfig } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { Db } from "./db.ts";
import { HttpError, readJson } from "./http.ts";
import { Workspaces } from "./workspaces.ts";
import { Workspace } from "./api-schemas.ts";

type Route = (config: RouteConfig, handler: (c: Context<any>) => Promise<Response> | Response) => void;
const name = z.string().trim().min(1).max(120);
const input = z.object({ name });
const patch = z.object({ name: name.optional(), archived: z.boolean().optional() });
const reply = (description: string, schema: z.ZodType) => ({ description, content: { "application/json": { schema } } });
const body = (schema: z.ZodType) => ({ content: { "application/json": { schema } } });
async function parse<T extends z.ZodType>(schema: T, c: Context): Promise<z.infer<T>> {
  const value = schema.safeParse(await readJson(c.req.raw.body, 16_384, {}));
  if (!value.success) throw new HttpError(400, value.error.issues[0].message);
  return value.data;
}

export function workspaceRoutes(route: Route, database: () => Db) {
  const workspaces = () => new Workspaces(database());
  route(createRoute({ method: "get", path: "/v1/workspaces", responses: { 200: reply("The account's workspaces, including archived ones", z.array(Workspace)) } }),
    async c => c.json(await workspaces().list(c.var.principal.tenant)));
  route(createRoute({ method: "post", path: "/v1/workspaces", request: { body: body(input) }, responses: { 201: reply("The new workspace", Workspace) } }),
    async c => c.json(await workspaces().create(c.var.principal.tenant, (await parse(input, c)).name), 201));
  route(createRoute({ method: "get", path: "/v1/workspaces/{id}", request: { params: z.object({ id: z.string() }) }, responses: { 200: reply("The workspace", Workspace) } }),
    async c => c.json(await workspaces().get(c.var.principal.tenant, c.req.param("id")!)));
  route(createRoute({ method: "patch", path: "/v1/workspaces/{id}", request: { params: z.object({ id: z.string() }), body: body(patch) }, responses: { 200: reply("The renamed, archived or restored workspace", Workspace) } }),
    async c => c.json(await workspaces().update(c.var.principal.tenant, c.req.param("id")!, await parse(patch, c))));
  route(createRoute({ method: "get", path: "/v1/workspaces/{id}/members", request: { params: z.object({ id: z.string() }) }, responses: { 200: reply("Agents and definitions assigned to this workspace", z.array(z.object({ kind: z.enum(["agent", "definition"]), id: z.string() }))) } }),
    async c => c.json(await workspaces().members(c.var.principal.tenant, c.req.param("id")!)));
  route(createRoute({ method: "get", path: "/v1/workspace-memberships", responses: { 200: reply("Current workspace assignments", z.array(z.object({ kind: z.enum(["agent", "definition"]), id: z.string(), workspaceId: z.string().nullable() }))) } }),
    async c => c.json(await workspaces().memberships(c.var.principal.tenant)));
  const assignment = z.object({ workspaceId: z.string().nullable() });
  route(createRoute({ method: "put", path: "/v1/workspace-memberships/{kind}/{id}", request: { params: z.object({ kind: z.enum(["agent", "definition"]), id: z.string() }), body: body(assignment) }, responses: { 200: reply("The resource's current workspace; earlier usage keeps its original attribution", assignment) } }), async c => {
    const tenant = c.var.principal.tenant, id = c.req.param("id")!, kind = c.req.param("kind");
    if (kind !== "agent" && kind !== "definition") throw new HttpError(400, "kind must be agent or definition");
    const exists = kind === "agent"
      ? await database().query("select 1 from agents where tenant = $1 and id = $2 and not revoked and purged_at is null and (expires_at is null or expires_at > $3)", [tenant, id, Date.now()])
      : await database().query("select 1 from definitions where tenant = $1 and id = $2", [tenant, id]);
    if (!exists.rowCount) throw new HttpError(404, "Unknown resource");
    const { workspaceId } = await parse(assignment, c);
    const saved = await workspaces().assign(tenant, kind, id, workspaceId);
    return c.json({ workspaceId: saved.workspace });
  });
}
