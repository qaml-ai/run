import { createRoute, z, type RouteConfig } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Channels } from "./channels.ts";
import { HttpError, readJson } from "./http.ts";
import * as schema from "./api-schemas.ts";

type Route = (config: RouteConfig, handler: (c: Context<any>) => Promise<Response> | Response) => void;
const json = (c: Context, status: number, value: unknown) => c.json(value, status as ContentfulStatusCode, { "Cache-Control": "no-store" });
const reply = (description: string, value: z.ZodType) => ({ description, content: { "application/json": { schema: value } } });
const body = (value: z.ZodType) => ({ content: { "application/json": { schema: value } } });
const channelId = z.object({ id: z.string() });

async function parse<T extends z.ZodType>(type: T, c: Context): Promise<z.infer<T>> {
  const result = type.safeParse(await readJson(c.req.raw.body, 512 * 1024, {}));
  if (!result.success) throw new HttpError(400, `${result.error.issues[0].path.join(".") || "body"}: ${result.error.issues[0].message}`);
  return result.data;
}

/** /v1/channels: a tenant's channels. Credentials go in and never come out. */
export function channelRoutes(route: Route, channels: () => Channels | undefined) {
  const service = () => {
    const value = channels();
    if (!value) throw new HttpError(404, "Channels are not enabled on this runtime");
    return value;
  };
  route(createRoute({ method: "get", path: "/v1/channels", responses: { 200: reply("The tenant's channels", z.array(schema.Channel)) } }),
    async c => json(c, 200, await service().list(c.var.principal.tenant)));
  route(createRoute({ method: "post", path: "/v1/channels", request: { body: body(schema.ChannelInput) }, responses: { 201: reply("The channel, its webhook registered", schema.Channel) } }),
    async c => json(c, 201, await service().create(c.var.principal.tenant, await parse(schema.ChannelInput, c))));
  route(createRoute({ method: "get", path: "/v1/channels/{id}", request: { params: channelId }, responses: { 200: reply("The channel", schema.Channel) } }),
    async c => json(c, 200, await service().get(c.var.principal.tenant, c.req.param("id")!)));
  route(createRoute({ method: "patch", path: "/v1/channels/{id}", request: { params: channelId, body: body(schema.ChannelUpdate) }, responses: { 200: reply("The updated channel", schema.Channel) } }),
    async c => json(c, 200, await service().update(c.var.principal.tenant, c.req.param("id")!, await parse(schema.ChannelUpdate, c))));
  route(createRoute({ method: "delete", path: "/v1/channels/{id}", request: { params: channelId }, responses: { 200: reply("The channel is deleted and its webhook removed", schema.Deleted) } }), async c => {
    await service().remove(c.var.principal.tenant, c.req.param("id")!);
    return json(c, 200, { deleted: true });
  });
}
