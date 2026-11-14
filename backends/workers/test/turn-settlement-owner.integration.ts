import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { startFixture } from "./fixture.ts";

for (const observerFirst of [false, true]) {
  const name = observerFirst
    ? "a tracker waits for the long-poll observer's single settlement"
    : "a long-poll waits for the tracker's single settlement";
  test(name, { timeout: 60_000 }, async t => {
    const f = await startFixture({
      entrypoint: fileURLToPath(new URL("./alarm-entry.ts", import.meta.url)),
      vars: { PILOT_DB_PROFILE: "1" },
    });
    t.after(() => f.stop());
    const call = async (path: string, body?: unknown) => {
      const response = await fetch(f.url + path, {
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${f.token}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const value = await response.json() as any;
      assert.ok(response.ok, `${path}: ${JSON.stringify(value)}`);
      return value;
    };
    const { id } = await call("/v1/agents", { model: "test/echo" });
    const race = `/experimental/agents/${id}/__test/observer-settlement-race`;
    if (observerFirst) await call(race, {});
    await call(`/v1/agents/${id}/requests`, {
      id: "observed", method: "prompt", params: { text: "slow:500:one settlement" },
    });
    const result = await call(`/v1/agents/${id}/requests/observed?wait=${observerFirst ? 5 : 1}`);
    assert.equal(result.state, "completed");
    assert.equal(result.status, "completed");
    if (observerFirst) assert.equal((await call(race)).trackerFlushed, true);
    const state = await call(`/experimental/agents/${id}/__test/alarm-state`);
    assert.equal(state.pending, 0, "the observer must wait until the receipt settles");
    assert.equal(state.profile.phases.settle.statements["select:idempotency_keys"].queries, 1);
    assert.equal(Number((await f.db.query("select count(*) n from usage_flushes")).rows[0].n), 1);
  });
}
