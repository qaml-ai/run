import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { getRequestListener } from "@hono/node-server";
import { AgentRuntime } from "../clients/node.ts";
import { memoryStorage } from "../shared/storage.ts";
import { FileLinks } from "../src/files.ts";
import { internalRequests } from "../src/internal-requests.ts";
import { postgresTail } from "../src/log-tail.ts";
import { Ownership } from "../src/ownership.ts";
import { clusterVolumes, VOLUME_ORIGIN_HEADER, volumeApp } from "../src/volume-app.ts";
import ingress, { fetchLegacyApi } from "../v2/ingress/index.ts";
import { testDatabase } from "./database.ts";

const sessionSecret = "separate fixture session secret";
const originToken = "separate fixture volume origin token";

test("volume origin takes over and rolls back existing drafts without changing files, versions, or receipts", async () => {
  const { db } = await testDatabase();
  const storage = memoryStorage(postgresTail(db));
  const links = new FileLinks(sessionSecret, "https://run.camelai.test");
  const auth = (tenant = "bots") => new Headers({ authorization: `Bearer ${tenant}`, [VOLUME_ORIGIN_HEADER]: originToken });
  const accounts = {
    db,
    authenticate: async (authorization?: string) => ["Bearer bots", "Bearer outsider"].includes(authorization ?? "")
      ? { tenant: authorization!.slice(7), via: "operator" as const } : undefined,
  };
  const consoleAuth = { principal: async () => undefined, allowsMutation: () => false };

  async function start(volumeOnly: boolean) {
    const server = createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert(address && typeof address !== "string");
    const node = `http://127.0.0.1:${address.port}`;
    const ownership = new Ownership(db, { node, volumeOnly });
    const volumes = clusterVolumes({ ownership, db, storage, sessionSecret });
    const app = volumeApp({ accounts, consoleAuth, volumes, links, sessionSecret, originToken });
    server.on("request", getRequestListener(app.fetch));
    await ownership.start();
    let closing: Promise<void> | undefined;
    const close = () => closing ??= (async () => {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await volumes.close();
      await ownership.close();
    })();
    const call = (path: string, init?: RequestInit) => fetch(node + path, { ...init, headers: { ...Object.fromEntries(auth()), ...init?.headers } });
    return { node, ownership, call, close };
  }

  const legacy = await start(false);
  const origin = await start(true);
  try {
    assert.equal(await legacy.ownership.peer(), undefined, "do not route new agent work to the volume origin");
    assert.equal(await origin.ownership.peer(), legacy.node);
    await assert.rejects(origin.ownership.acquire(`client_${"a".repeat(40)}`), /can only own volumes/);
    const create = await legacy.call("/v1/volumes", { method: "POST", body: '{"name":"draft","key":"bot-a"}' });
    assert.equal(create.status, 201, await create.clone().text());
    const { id } = await create.json();
    const volume = `/v1/volumes/${id}`;
    const file = `${volume}/files/src/package.json`;
    const first = await legacy.call(file, { method: "PUT", body: "old", headers: { "if-none-match": "*" } });
    assert.equal(first.status, 201, await first.clone().text());
    const fileVersion = (await first.json()).version;
    assert.equal(await origin.ownership.owner(id), legacy.node);
    assert.equal((await fetch(origin.node + file, { headers: { authorization: "Bearer bots" } })).status, 401);
    assert.equal((await fetch(origin.node + file, { headers: auth("outsider") })).status, 404);
    assert.equal((await fetch(`${origin.node}/internal/volumes/${id}/ops`, { method: "POST", body: '{"tenant":"bots","op":"delete","args":{}}' })).status, 401);

    const pending = await Promise.all([
      legacy.call(file, { method: "PUT", body: "old worker", headers: { "if-match": String(fileVersion) } }),
      origin.call(file, { method: "PUT", body: "new origin", headers: { "if-match": String(fileVersion) } }),
    ]);
    assert.deepEqual(pending.map(res => res.status).sort(), [201, 412]);
    const before = await (await origin.call(file)).text();
    const makeSnapshot = { method: "POST", body: '{"name":"published","pinned":true}', headers: { "idempotency-key": "draft-publish" } };
    const snapshotResponse = await legacy.call(`${volume}/snapshots`, makeSnapshot);
    assert.equal(snapshotResponse.status, 201, await snapshotResponse.clone().text());
    const snapshot = await snapshotResponse.json();

    await legacy.close();
    origin.ownership.forget(id);
    const ingressEnv = {
      V2: { fetch: async () => { throw new Error("volume request was misrouted to the v2 agent runtime"); } },
      LEGACY_VOLUMES_ORIGIN: origin.node, LEGACY_VOLUMES_ORIGIN_TOKEN: originToken,
    };
    const apiUrl = "https://run.camelai.com";
    const draft = new AgentRuntime({
      url: apiUrl, apiKey: "bots",
      fetch: (input, init) => ingress.fetch(new Request(input, init), ingressEnv),
    });
    try {
      const got = await draft.volume(id).read("src/package.json");
      assert.equal(new TextDecoder().decode(got.data), before);
      const edit = await origin.call(file, { method: "PUT", body: "after takeover", headers: { "if-match": String(got.version) } });
      assert.equal(edit.status, 201, await edit.clone().text());
      assert.equal(await origin.ownership.owner(id), origin.node);
      assert.equal(await (await fetchLegacyApi(new Request(apiUrl + file, { headers: { authorization: "Bearer bots" } }), ingressEnv)).text(), "after takeover");
      const link = await draft.volume(id).link("src/package.json");
      const download = await ingress.fetch(new Request(apiUrl + new URL(link.url).pathname), ingressEnv);
      assert.equal(download.status, 200);
      assert.equal(await download.text(), "after takeover");
      assert.equal(await (await origin.call(`${file}?snapshot=${snapshot.id}`)).text(), before);
      const replay = await origin.call(`${volume}/snapshots`, makeSnapshot);
      assert.equal(replay.headers.get("idempotent-replayed"), "true");
      assert.deepEqual(await replay.json(), snapshot);

      // A still-active legacy agent writes to this actor through its ordinary signed peer protocol.
      const { signedPost } = internalRequests(sessionSecret);
      const peer = await signedPost(origin.node, `/internal/volumes/${id}/ops`, { tenant: "bots", op: "copy", args: { path: "/src/package.json", to: "/peer-edit" } });
      assert.equal(peer.status, 200, await peer.text());
    } finally {
      await origin.close();
    }
    const rollback = await start(false);
    try {
      assert.equal(await (await rollback.call(file)).text(), "after takeover");
      assert.equal(await (await rollback.call(`${volume}/files/peer-edit`)).text(), "after takeover");
      assert.equal(await (await rollback.call(`${file}?snapshot=${snapshot.id}`)).text(), before);
      const restored = await rollback.call(`${volume}/restore`, { method: "POST", body: JSON.stringify({ snapshot: snapshot.id }) });
      assert.equal(restored.status, 200, await restored.clone().text());
      assert.equal(await (await rollback.call(file)).text(), before);
    } finally { await rollback.close(); }
  } finally {
    await Promise.allSettled([legacy.close(), origin.close()]);
  }
});
