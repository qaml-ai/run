import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { applyScope } from "../../../shared/apply-scope.ts";
import pilotL90Worker from "../scripts/pilot-l90-worker.ts";
// @ts-ignore JavaScript operator script has no declaration file.
import { sweep } from "../scripts/pilot-l90-sweep.mjs";

test("pilot L90 routes gate access and reject a whole delete batch containing a refused key", async () => {
  const token = "unit-test-bearer-for-the-l90-worker";
  const options = { tokenHash: createHash("sha256").update(token).digest("hex"), expiresAt: Date.now() + 60_000 };
  const worker = pilotL90Worker(options);
  const deleted: string[][] = [];
  const env = {
    BUCKET: {
      list: async (options: R2ListOptions) => {
        assert.deepEqual(options, { prefix: "files/", limit: 1000, cursor: "+next" });
        return { objects: [{ key: "files/__proto__/one", size: 3 }, { key: "files/__proto__/two", size: 4 }], truncated: true, cursor: "next" };
      },
      delete: async (keys: string[]) => { deleted.push(keys); },
    },
    TENANTS: { getByName(tenant: string) {
      assert.equal(tenant, "regular-tenant");
      return { legacyVolumeTables: async (drop: boolean) => {
        assert.equal(drop, false);
        return { tables: [], alarm: null };
      } };
    } },
  } as unknown as Parameters<typeof worker.fetch>[1];
  const call = (path: string, body?: unknown, bearer = token, handler = worker) => handler.fetch(new Request(`https://test.invalid${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${bearer}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env);
  assert.equal((await call("/healthz", undefined, "x".repeat(32))).status, 401);
  assert.equal((await call("/healthz", undefined, token, pilotL90Worker({ ...options, expiresAt: 0 }))).status, 410);
  assert.equal((await call("/healthz")).status, 200);
  assert.equal((await call("/l90/r2/delete")).status, 404);
  assert.deepEqual(await (await call("/l90/r2?cursor=%2Bnext")).json(), {
    keys: ["files/__proto__/one", "files/__proto__/two"], bytes: 7,
    perTenant: { ["__proto__"]: { keys: 2, bytes: 7 } }, cursor: "next",
  });

  const good = "files/regular-tenant/old";
  for (const keys of [
    [good, "images/regular-tenant/keep"], [good, "chunks/regular-tenant/keep"], [good, "fork-claims/regular-tenant/keep"],
    [good, "mail/regular-tenant/keep"], [good, "files//old"], [good, "files/regular-tenant"], [good, 123], Array(1001).fill(good),
  ]) {
    const response = await call("/l90/r2/delete", { keys });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "Refused key" });
  }
  assert.deepEqual(deleted, []);
  assert.equal((await call("/l90/r2/delete", { keys: [good] })).status, 200);
  assert.deepEqual(deleted, [[good]]);
  assert.equal((await call("/l90/tables", { tenant: "regular-tenant", drop: "false" })).status, 400);
  assert.deepEqual(await (await call("/l90/tables", { tenant: "regular-tenant", drop: false })).json(), { tables: [], alarm: null });

  const sql = { query: async (query: string, values: unknown[]) => {
    assert.equal(query, "select id from tenants where id > $1 order by id limit 200");
    assert.deepEqual(values, ["a+b"]);
    return { rows: [{ id: "regular-tenant" }] };
  } };
  const response = await applyScope.run({ sql }, () => call("/l90/tenants?after=a%2Bb"));
  assert.deepEqual(await response.json(), { tenants: ["regular-tenant"] });
});

test("pilot L90 confirm deletes successful pages in order and reports only aggregate results", async () => {
  const keys = ["files/a/first", "files/b/fails", "files/a/last"];
  const calls: string[] = [];
  const request = async (path: string, init?: { body: { keys?: string[]; tenant?: string; drop?: boolean } }) => {
    calls.push(path);
    if (path.startsWith("/l90/r2?") || path === "/l90/r2") {
      const index = path.includes("cursor=skip") ? 1 : 0;
      const key = keys[index];
      return { keys: [key], bytes: 5, perTenant: { [key.split("/")[1]]: { keys: 1, bytes: 5 } },
        ...(index + 1 < keys.length ? { cursor: "skip" } : {}) };
    }
    if (path === "/l90/r2/delete") {
      const key = init?.body.keys?.[0];
      if (key === "files/b/fails") throw new Error("failed; category=Refused key; details redacted");
      keys.splice(keys.indexOf(key!), 1);
      return { ok: true };
    }
    if (path === "/l90/tenants?after=") return { tenants: ["a", "b", "c"] };
    assert.equal(path, "/l90/tables");
    assert.equal(init?.body.drop, true);
    if (init?.body.tenant === "b") throw new Error("private DB error text");
    return { tables: [{ name: "storage_objects", rows: 3 }], alarm: init?.body.tenant === "a" ? 42 : null };
  };

  const result = await sweep(request, true);
  assert.deepEqual(calls, ["/l90/r2", "/l90/r2/delete", "/l90/r2", "/l90/r2/delete", "/l90/r2?cursor=skip", "/l90/r2/delete",
    "/l90/tenants?after=", "/l90/tables", "/l90/tables", "/l90/tables"]);
  assert.deepEqual(keys, ["files/b/fails"]);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    r2: { keys: 3, bytes: 15, perTenant: { a: { keys: 2, bytes: 10 }, b: { keys: 1, bytes: 5 } } },
    tables: {
      storage_objects: { tenants: 2, rows: 6 },
      storage_total: { tenants: 0, rows: 0 },
      storage_listing: { tenants: 0, rows: 0 },
    },
    pendingAlarms: 1,
    failures: 2,
    errors: [{ tenant: "b", category: "Refused key" }, { tenant: "b", category: "L90 request failed" }],
  });
});
