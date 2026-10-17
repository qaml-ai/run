import { test } from "node:test";
import assert from "node:assert/strict";
import { listenFromEnvironment } from "../src/db.ts";
import { testDatabase } from "./database.ts";
import { until } from "./runtime-server.ts";

test("the listen connection comes back after the server ends it, and hears notifications again", async () => {
  const { db, url } = await testDatabase({ migrate: false });
  const channel = `listen_${Math.random().toString(36).slice(2)}`;
  const heard: string[] = [];
  const listen = await listenFromEnvironment({ [channel]: payload => heard.push(payload) }, { AGENT_DATABASE_URL: url });
  try {
    await db.query("select pg_notify($1, 'one')", [channel]);
    await until(async () => heard.includes("one"), "the first notification");
    // A failover ends the session from the server's side.
    const ended = await db.query("select pg_terminate_backend(pid) from pg_stat_activity where query ilike $1 and pid <> pg_backend_pid()", [`listen "${channel}"%`]);
    assert.equal(ended.rowCount, 1);
    await until(async () => {
      await db.query("select pg_notify($1, 'two')", [channel]);
      return heard.includes("two");
    }, "a notification after reconnecting", 15_000);
  } finally { await listen.close(); }
});
