import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { LocalWorker, unusedPort } from "./local-worker.ts";

test("sticky route election survives overlapping requests and a real Workerd restart", { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "legacy-gateway-text-routes-"));
  const entry = join(directory, "worker.ts");
  const config = join(directory, "wrangler.json");
  const source = fileURLToPath(new URL("../src/legacy-gateway-text-routes.ts", import.meta.url));
  await writeFile(entry, `
    export { LegacyGatewayTextRoutes } from ${JSON.stringify(source)};
    export default {
      async fetch(request, env) {
        const path = new URL(request.url).pathname;
        if (path === "/healthz") return new Response("ok");
        if (path === "/__test/drain") return new Response(null, { status: 204 });
        const [tenant, id] = path.slice(1).split("/");
        const authority = env.ROUTES.getByName(tenant);
        if (request.method === "POST") return Response.json(await authority.pin(id, await request.json()));
        return Response.json(await authority.lookup(id));
      },
    };
  `);
  await writeFile(config, JSON.stringify({
    name: "legacy-gateway-text-routes-fixture", main: entry, compatibility_date: "2026-09-01",
    durable_objects: { bindings: [{ name: "ROUTES", class_name: "LegacyGatewayTextRoutes" }] },
    migrations: [{ tag: "test", new_sqlite_classes: ["LegacyGatewayTextRoutes"] }],
  }));
  const store = join(directory, "persist");
  const makeWorker = async () => new LocalWorker(await unusedPort(), store, config, "test", { startupTimeoutMs: 15_000 });
  const runId = "run_8cf6a63c8f048fe8e5dec18caf5fd2fbdb92c1eb";
  let worker: LocalWorker | undefined;
  const check = async (tenant: string, owner?: Record<string, string>) =>
    await (await fetch(`${worker!.url}/${tenant}/${runId}`, owner ? {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(owner),
    } : undefined)).json();
  try {
    worker = await makeWorker();
    await worker.start();
    assert.equal(await check("test-tenant"), null);
    const proposed = [{ owner: "legacy" }, { owner: "native", fingerprint: "a".repeat(64) }];
    const [first, second] = await Promise.all(proposed.map(owner => check("test-tenant", owner)));
    assert.deepEqual(first, second);
    assert.ok(proposed.some(owner => JSON.stringify(owner) === JSON.stringify(first)));
    assert.equal(await check("other-tenant"), null);
    await worker.stop();
    worker = await makeWorker();
    await worker.start();
    assert.deepEqual(await check("test-tenant"), first);
    assert.deepEqual(await check("test-tenant", { owner: "native", fingerprint: "b".repeat(64) }), first);
  } finally {
    await worker?.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
