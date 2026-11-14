import { timingSafeEqual } from "node:crypto";
import { withSql, type PostgresEnv } from "../src/postgres.ts";
import type { TenantAdmission } from "../src/tenant.ts";

type Env = PostgresEnv & {
  BUCKET: R2Bucket;
  TENANTS: DurableObjectNamespace<TenantAdmission>;
};
type Totals = { keys: number; bytes: number };

const legacyKey = /^files\/([^/]+)\//;
const pageSize = 1000;

/** Temporary pilot Worker for the L90 sweep. Its bearer expires after one hour. */
export default function pilotL90Worker({ tokenHash, expiresAt }: { tokenHash: string; expiresAt: number }) {
  const reply = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      if (Date.now() > expiresAt) return reply({ error: "Bootstrap expired" }, 410);
      const token = request.headers.get("Authorization")?.match(/^Bearer ([^\s]{32,200})$/)?.[1];
      if (!token) return reply({ error: "Unauthorized" }, 401);
      const hash = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
      if (!timingSafeEqual(hash, Buffer.from(tokenHash, "hex"))) return reply({ error: "Unauthorized" }, 401);
      const { pathname, searchParams } = new URL(request.url);
      if (pathname === "/healthz" && request.method === "GET") return reply({ ok: true });
      try {
        if (pathname === "/l90/r2" && request.method === "GET") {
          const page = await env.BUCKET.list({ prefix: "files/", limit: pageSize, cursor: searchParams.get("cursor") ?? undefined });
          const keys: string[] = [];
          const perTenant: Record<string, Totals> = Object.create(null);
          let bytes = 0;
          for (const object of page.objects) {
            keys.push(object.key);
            bytes += object.size;
            const tenant = legacyKey.exec(object.key)?.[1];
            if (tenant !== undefined) {
              const totals = perTenant[tenant] ??= { keys: 0, bytes: 0 };
              totals.keys++;
              totals.bytes += object.size;
            }
          }
          return reply({ keys, bytes, perTenant, ...(page.truncated ? { cursor: page.cursor } : {}) });
        }
        if (pathname === "/l90/r2/delete" && request.method === "POST") {
          const input = await request.json<{ keys?: unknown } | null>();
          const keys = input?.keys;
          if (!Array.isArray(keys) || keys.length > pageSize || keys.some(key => typeof key !== "string" || !legacyKey.test(key)))
            return reply({ error: "Refused key" }, 400);
          if (keys.length) await env.BUCKET.delete(keys);
          return reply({ ok: true });
        }
        if (pathname === "/l90/tenants" && request.method === "GET") {
          const after = searchParams.get("after") ?? "";
          return reply(await withSql(env, async sql => {
            const { rows } = await sql.query<{ id: string }>("select id from tenants where id > $1 order by id limit 200", [after]);
            return { tenants: rows.map(row => row.id) };
          }));
        }
        if (pathname === "/l90/tables" && request.method === "POST") {
          const input = await request.json<{ tenant?: unknown; drop?: unknown } | null>();
          if (typeof input?.tenant !== "string" || !input.tenant || typeof input.drop !== "boolean")
            return reply({ error: "L90 request failed" }, 400);
          return reply(await env.TENANTS.getByName(input.tenant).legacyVolumeTables(input.drop));
        }
        return reply({ error: "Not found" }, 404);
      } catch {
        return reply({ error: "L90 request failed" }, 500);
      }
    },
  };
}
