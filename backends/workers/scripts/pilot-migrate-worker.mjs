import { timingSafeEqual } from "node:crypto";
import pg from "pg";
import { applyMigrations, migrationStatus } from "./migrate.mjs";

/** Temporary pilot migration Worker (scripts/pilot-migrate.mjs deploys it). Its
 * only binding is the pilot's Hyperdrive; no database password exists anywhere
 * in this flow. The deployed source holds the repository migrations, a token
 * hash (never a usable credential) and an expiry. Responses carry migration
 * names and SQLSTATE codes only: no SQL, no database error text. */
export default function pilotMigrator({ tokenHash, expiresAt, migrations }) {
  const reply = (value, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
  return {
    async fetch(request, env) {
      if (Date.now() > expiresAt) return reply({ error: "Bootstrap expired" }, 410);
      const token = request.headers.get("Authorization")?.match(/^Bearer ([^\s]{32,200})$/)?.[1];
      if (!token) return reply({ error: "Unauthorized" }, 401);
      const hash = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
      if (!timingSafeEqual(hash, Buffer.from(tokenHash, "hex"))) return reply({ error: "Unauthorized" }, 401);
      const { pathname } = new URL(request.url);
      if (pathname === "/healthz" && request.method === "GET") return reply({ ok: true });
      if (pathname !== "/pilot/migrations" || !["GET", "POST"].includes(request.method)) return reply({ error: "Not found" }, 404);
      // One connection for the whole run: a migration's begin/commit must share it.
      // A migration may run longer than the API's 10 s query timeout.
      const db = new pg.Client({ connectionString: env.HYPERDRIVE.connectionString, connectionTimeoutMillis: 10_000, query_timeout: 600_000 });
      try {
        await db.connect();
        const status = await migrationStatus(db, migrations);
        if (request.method === "GET") return reply(status);
        if (status.unknown.length) return reply({ error: "Database is ahead of this checkout", unknown: status.unknown }, 409);
        return reply({ applied: await applyMigrations(db, migrations) });
      } catch (error) {
        if (error?.migration) return reply({ error: "Migration failed", migration: error.migration, code: error.code ?? null, applied: error.applied }, 500);
        return reply({ error: "Pilot migration request failed", code: typeof error?.code === "string" ? error.code : null }, 500);
      } finally {
        await db.end().catch(() => {});
      }
    },
  };
}
