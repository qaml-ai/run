import { createRoute, z, type RouteConfig } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Definitions } from "./definitions.ts";
import type { RequestRecord } from "../shared/client-protocol.ts";
import { HttpError, readJson } from "./http.ts";
import * as schema from "./api-schemas.ts";

type Route = (config: RouteConfig, handler: (c: Context<any>) => Promise<Response> | Response) => void;
type Submit = (agent: string, tenant: string, request: { id: string; method: string; params: Record<string, unknown> }) => Promise<RequestRecord>;
const json = (c: Context, status: number, value: unknown) => c.json(value, status as ContentfulStatusCode, { "Cache-Control": "no-store" });
const reply = (description: string, value: z.ZodType) => ({ description, content: { "application/json": { schema: value } } });
const body = (value: z.ZodType) => ({ content: { "application/json": { schema: value } } });
const definitionId = z.object({ id: z.string() });

async function parse<T extends z.ZodType>(type: T, c: Context): Promise<z.infer<T>> {
  const result = type.safeParse(await readJson(c.req.raw.body, 1024 * 1024, {}));
  if (!result.success) throw new HttpError(400, `${result.error.issues[0].path.join(".") || "body"}: ${result.error.issues[0].message}`);
  return result.data;
}

/** /v1/definitions: a tenant's reusable agent definitions. */
export function definitionRoutes(route: Route, context: () => { definitions?: Definitions; submit?: Submit }) {
  const service = () => {
    const value = context().definitions;
    if (!value) throw new HttpError(404, "Definitions are not enabled on this runtime");
    return value;
  };
  route(createRoute({ method: "get", path: "/v1/definitions", responses: { 200: reply("The tenant's definitions", z.array(schema.Definition)) } }),
    async c => json(c, 200, await service().list(c.var.principal.tenant)));
  route(createRoute({ method: "post", path: "/v1/definitions", request: { body: body(schema.DefinitionInput) }, responses: { 201: reply("The definition, at revision 1", schema.Definition) } }), async c => {
    const definitions = service();
    return json(c, 201, definitions.view(await definitions.create(c.var.principal.tenant, await parse(schema.DefinitionInput, c))));
  });
  route(createRoute({ method: "get", path: "/v1/definitions/{id}", request: { params: definitionId }, responses: { 200: reply("The definition", schema.Definition) } }),
    async c => json(c, 200, await service().get(c.var.principal.tenant, c.req.param("id")!)));
  route(createRoute({
    method: "patch", path: "/v1/definitions/{id}", request: { params: definitionId, body: body(schema.DefinitionUpdate) },
    responses: { 200: reply("The definition at its new revision; with apply, the agents asked to take it", schema.DefinitionUpdated) },
  }), async c => {
    const definitions = service();
    const tenant = c.var.principal.tenant;
    const input = await parse(schema.DefinitionUpdate, c);
    const submit = context().submit;
    if (input.apply === "all" && !submit) throw new HttpError(404, "Applying definitions is not enabled on this runtime");
    const updated = await definitions.update(tenant, c.req.param("id")!, input);
    if (input.apply !== "all") return json(c, 200, definitions.view(updated));
    return json(c, 200, { ...definitions.view(updated), applied: await definitions.apply(updated, (agent, request) => submit!(agent, tenant, request)) });
  });
  route(createRoute({ method: "delete", path: "/v1/definitions/{id}", request: { params: definitionId }, responses: { 200: reply("The definition is deleted; agents made from it keep their configuration", schema.Deleted) } }), async c => {
    await service().remove(c.var.principal.tenant, c.req.param("id")!);
    return json(c, 200, { deleted: true });
  });
  route(createRoute({ method: "get", path: "/v1/definitions/{id}/agents", request: { params: definitionId }, responses: { 200: reply("Live agents made from the definition, and the revision each has", z.array(schema.DefinitionAgent)) } }), async c => {
    const definitions = service();
    const tenant = c.var.principal.tenant;
    await definitions.read(tenant, c.req.param("id")!);
    return json(c, 200, await definitions.agents(tenant, c.req.param("id")!));
  });
}
