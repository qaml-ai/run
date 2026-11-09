import { createRoute, z, type RouteConfig } from "@hono/zod-openapi";
import type { Context } from "hono";
import { decodeVaultPath, type Vault, type SecretInput } from "./core/vault.ts";
import { HttpError, readJson } from "./http.ts";
const input = z.object({ value: z.string().optional(), allowedHosts: z.array(z.string()).optional(), locations: z.array(z.enum(["header", "query", "body"])).optional() });
const result = z.object({ name: z.string() });
export function vaultRoutes(route: (config: RouteConfig, handler: (c: Context<any>) => Promise<Response>) => void, get: () => Vault | undefined) {
  for (const scoped of [false, true]) {
    const path = scoped ? "/v1/workspaces/{workspace}/secrets" : "/v1/secrets";
    const params = scoped ? { workspace: z.string() } : {};
    for (const method of ["get", "post", "patch", "delete"] as const) {
      const named = method !== "get";
      route(createRoute({ method, path: path + (named ? "/{name}" : ""), request: { params: z.object({ ...params, ...(named ? { name: z.string() } : {}) }), ...(["post", "patch"].includes(method) ? { body: { content: { "application/json": { schema: input } } } } : {}) }, responses: { 200: { description: "Secret names only; values are write-only", content: { "application/json": { schema: method === "get" ? z.array(z.string()) : method === "delete" ? z.object({ deleted: z.boolean() }) : result } } } } }), async c => {
        const vault = get(); if (!vault) throw new HttpError(503, "Vault is unavailable");
        const tenant = c.var.principal.tenant, workspace = decodeVaultPath(c.req.param("workspace") ?? ""), name = decodeVaultPath(c.req.param("name") ?? "");
        let value: unknown;
        if (method === "get") value = await vault.list(tenant, workspace);
        else if (method === "delete") { await vault.remove(tenant, name, workspace); value = { deleted: true }; }
        else value = await vault.put(tenant, name, await readJson(c.req.raw.body, 32 * 1024, {}) as SecretInput, workspace, method === "post");
        return c.json(value as never, 200, { "Cache-Control": "no-store" });
      });
    }
  }
}
