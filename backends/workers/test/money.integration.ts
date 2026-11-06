import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { startFixture } from "./fixture.ts";
import { reserveTurn, settleTurn, transfer } from "../src/control.ts";
import { EndUserCredits } from "../src/end-user-credits.ts";
import { database, transaction } from "../src/postgres.ts";
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("Postgres money: holds, concurrent overspend, lost acknowledgement, transfers and rollback", async () => {
  const fixture = await startFixture();
  const env = {
    HYPERDRIVE: { connectionString: fixture.databaseUrl },
    TEST_MODE: "1",
  };
  try {
    const created = await fetch(`${fixture.url}/v1/agents`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${fixture.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "test/echo" }),
    });
    assert.equal(created.status, 201);
    const agent = (await created.json()) as { id: string };
    const tenant = "camelrun-proto-local",
      requestId = crypto.randomUUID();
    assert.deepEqual(
      await reserveTurn(env, tenant, agent.id, requestId, 10000),
      { held: 10000 },
    );
    assert.deepEqual(
      await reserveTurn(env, tenant, agent.id, requestId, 10000),
      { held: 10000 },
    );
    const initial = Number(
      (
        await fixture.db.query(
          "select balance from credit_accounts where tenant=$1",
          [tenant],
        )
      ).rows[0].balance,
    );
    const receipt = {
      tenantId: tenant,
      agentId: agent.id,
      requestId,
      costMicros: 7000,
    };
    await assert.rejects(
      settleTurn(env, { ...receipt, faultAfterCommit: true }),
      /lost PG acknowledgement/,
    );
    assert.deepEqual(await settleTurn(env, receipt), { duplicate: true });
    assert.equal(
      Number(
        (
          await fixture.db.query(
            "select balance from credit_accounts where tenant=$1",
            [tenant],
          )
        ).rows[0].balance,
      ),
      initial - 7000,
    );
    await assert.rejects(
      settleTurn(env, { ...receipt, costMicros: 8000 }),
      /Receipt changed/,
    );
    assert.equal(
      (
        await fixture.db.query(
          "select count(*) from credit_holds where tenant=$1",
          [tenant],
        )
      ).rows[0].count,
      0,
    );
    const target = "camelrun-proto-team";
    await fixture.db.query(
      "insert into tenants(id,created_at,billing) values($1,$2,'prepaid')",
      [target, Date.now()],
    );
    await fixture.db.query("insert into credit_accounts(tenant) values($1)", [
      target,
    ]);
    assert.deepEqual(await transfer(env, tenant, target, 10000, "team-1"), {
      transferred: 10000,
      replayed: false,
    });
    assert.deepEqual(await transfer(env, tenant, target, 10000, "team-1"), {
      transferred: 10000,
      replayed: true,
    });
    await assert.rejects(
      transfer(env, tenant, target, 11000, "team-1"),
      /Transfer changed/,
    );
    assert.equal(
      Number(
        (
          await fixture.db.query(
            "select balance from credit_accounts where tenant=$1",
            [target],
          )
        ).rows[0].balance,
      ),
      10000,
    );
    const before = Number(
      (
        await fixture.db.query(
          "select balance from credit_accounts where tenant=$1",
          [tenant],
        )
      ).rows[0].balance,
    );
    await assert.rejects(
      transaction(env, async (sql) => {
        await sql.query(
          "update credit_accounts set balance=0 where tenant=$1",
          [tenant],
        );
        throw new Error("crash");
      }),
      /crash/,
    );
    assert.equal(
      Number(
        (
          await fixture.db.query(
            "select balance from credit_accounts where tenant=$1",
            [tenant],
          )
        ).rows[0].balance,
      ),
      before,
    );
    await fixture.db.query(
      "update credit_accounts set balance=2000000,purchased=0 where tenant=$1",
      [tenant],
    );
    await fixture.db.query(
      "update credit_spend_minutes set amount=1000000 where tenant=$1",
      [tenant],
    );
    await assert.rejects(
      reserveTurn(env, tenant, agent.id, crypto.randomUUID(), 10000),
      /hourly allowance/,
    );
    await fixture.db.query(
      "insert into billing_disputes(id,payment_intent,tenant,amount,status,created_at,updated_at) values('fixture-dispute','fixture-intent',$1,100,'needs_response',$2,$2)",
      [tenant, Date.now()],
    );
    await fixture.db.query(
      "update credit_accounts set purchased=100000000 where tenant=$1",
      [tenant],
    );
    await assert.rejects(
      reserveTurn(env, tenant, agent.id, crypto.randomUUID(), 10000),
      /hourly allowance/,
    );
    await fixture.db.query(
      "update billing_disputes set closed=true where id='fixture-dispute'",
    );
    await fixture.db.query(
      "update credit_accounts set balance=100000 where tenant=$1",
      [tenant],
    );
    const outcomes = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        reserveTurn(env, tenant, agent.id, crypto.randomUUID(), 10000),
      ),
    );
    assert.equal(outcomes.filter((x) => x.status === "fulfilled").length, 10);
    assert.equal(
      Number(
        (
          await fixture.db.query(
            "select sum(amount) n from credit_holds where tenant=$1",
            [tenant],
          )
        ).rows[0].n,
      ),
      100000,
    );
  } finally {
    await fixture.stop();
  }
});

test("Unchanged end-user credit policy: expiring lots and idempotent grants", async () => {
  const fixture = await startFixture();
  const env = { HYPERDRIVE: { connectionString: fixture.databaseUrl } };
  try {
    const credits = new EndUserCredits(database(env)),
      tenant = "camelrun-proto-local";
    await credits.setSettings(tenant, { enabled: true });
    const grant = {
      kind: "grant",
      amount: 10000,
      key: "fixture-grant",
      expiresAt: Date.now() + 5000,
    };
    assert.equal((await credits.post(tenant, "person", grant)).replayed, false);
    assert.equal((await credits.post(tenant, "person", grant)).replayed, true);
    await credits.post(tenant, "person", {
      kind: "grant",
      amount: 2000,
      key: "permanent",
    });
    await credits.expireDue(100, Date.now() + 10000);
    const state = await credits.get(tenant, "person");
    assert.equal(state.balance, 2000);
  } finally {
    await fixture.stop();
  }
});

test("API keys isolate tenants, revoke immediately, Queue delivers signed webhooks and account email links once", async () => {
  const deliveries: { body: string; headers: Record<string, unknown> }[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    deliveries.push({ body, headers: req.headers });
    res.writeHead(204).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const fixture = await startFixture({
    tenants: [
      { id: "camelrun-proto-local", token: "fixture-operator-key" },
      { id: "camelrun-proto-other", token: "other-fixture-key" },
    ],
  });
  const call = async (
    path: string,
    method = "GET",
    body?: unknown,
    token = fixture.token,
  ) =>
    fetch(fixture.url + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  try {
    const keyRes = await call("/v1/api-keys", "POST", { name: "test" });
    assert.equal(keyRes.status, 201);
    const key = (await keyRes.json()) as { id: string; token: string };
    assert.equal(
      (await call("/v1/credits", "GET", undefined, key.token)).status,
      200,
    );
    const agentRes = await call("/v1/agents", "POST", { model: "test/echo" });
    const agent = (await agentRes.json()) as { id: string };
    assert.equal(
      (
        await call(
          `/v1/agents/${agent.id}`,
          "GET",
          undefined,
          "other-fixture-key",
        )
      ).status,
      404,
    );
    assert.equal((await call(`/v1/api-keys/${key.id}`, "DELETE")).status, 200);
    assert.equal(
      (await call("/v1/credits", "GET", undefined, key.token)).status,
      401,
    );
    const endpoint = await call("/v1/webhooks", "POST", {
      url: `http://127.0.0.1:${port}/hook`,
      events: ["usage.recorded"],
    });
    assert.equal(endpoint.status, 201);
    const env = {
        HYPERDRIVE: { connectionString: fixture.databaseUrl },
        TEST_MODE: "1",
      },
      requestId = crypto.randomUUID();
    await reserveTurn(env, "camelrun-proto-local", agent.id, requestId);
    await settleTurn(env, {
      tenantId: "camelrun-proto-local",
      agentId: agent.id,
      requestId,
      costMicros: 7000,
    });
    const flush = await call("/__test/flush-webhooks", "POST");
    assert.equal(flush.status, 200);
    const flushed = await flush.json();
    for (let i = 0; i < 40 && deliveries.length === 0; i++) await pause(250);
    assert.ok(
      deliveries.length >= 1,
      JSON.stringify({
        flushed,
        pending: (
          await fixture.db.query(
            "select attempts,last_error,due from webhook_deliveries",
          )
        ).rows,
      }),
    );
    assert.ok(deliveries[0].headers["webhook-signature"]);
    assert.equal(JSON.parse(deliveries[0].body).type, "usage.recorded");
    assert.equal(
      (
        await call("/v1/account/email", "POST", {
          email: "fixture@example.test",
        })
      ).status,
      200,
    );
    let inbox: any[] = [];
    for (let i = 0; i < 40; i++) {
      inbox = (await (
        await call("/experimental/account-emails")
      ).json()) as any[];
      if (inbox[0]?.delivered) break;
      await pause(250);
    }
    assert.equal(inbox[0]?.delivered, true);
    assert.equal(
      (
        await call("/v1/account/email/verify", "POST", {
          token: inbox[0].token,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await call("/v1/account/email/verify", "POST", {
          token: inbox[0].token,
        })
      ).status,
      400,
    );
  } finally {
    try { await fixture.stop(); }
    finally {
      const closed = once(server, "close");
      server.close();
      server.closeAllConnections();
      await closed;
    }
  }
});

test("Public-id creation keys cannot take another tenant agent; unknown webhook receivers are refused", async () => {
  const fixture = await startFixture({
    tenants: [
      { id: "camelrun-proto-local", token: "owner-fixture-key" },
      { id: "camelrun-proto-other", token: "attacker-fixture-key" },
    ],
  });
  const call = (
    path: string,
    method: string,
    body: unknown,
    token: string,
    key?: string,
  ) =>
    fetch(fixture.url + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(key ? { "Idempotency-Key": key } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  try {
    const created = await call(
      "/v1/agents",
      "POST",
      {
        model: "test/echo",
        name: "owner-agent",
        systemPrompt: "owner-configuration",
      },
      "owner-fixture-key",
    );
    assert.equal(created.status, 201);
    const victim = (await created.json()) as {
      id: string;
      token: string;
      configHash: string;
    };
    const before = (
      await fixture.db.query(
        "select tenant,header,revision from agents where id=$1",
        [victim.id],
      )
    ).rows[0];
    const attempts = await Promise.all(
      Array.from({ length: 4 }, () =>
        call(
          "/v1/agents",
          "POST",
          {
            model: "test/echo",
            name: "attacker-agent",
            systemPrompt: "replaced",
          },
          "attacker-fixture-key",
          victim.id,
        ),
      ),
    );
    assert.ok(
      attempts.every((response) => response.status === 403),
      "Every cross-tenant mutation is refused",
    );
    const after = (
      await fixture.db.query(
        "select tenant,header,revision from agents where id=$1",
        [victim.id],
      )
    ).rows[0];
    assert.deepEqual(after, before, "No directory field or revision changed");
    const config = await call(
      `/clients/${victim.id}/configuration`,
      "GET",
      undefined,
      victim.token,
    );
    assert.equal(config.status, 200);
    assert.equal(
      ((await config.json()) as { name: string }).name,
      "owner-agent",
    );
    const credentials = await call(
      `/v1/agents/${victim.id}/credentials`,
      "GET",
      undefined,
      "owner-fixture-key",
    );
    // src/client-sessions/configuration.ts only recovers credentials for keyed agents.
    // The original token still authenticated the unchanged configuration above.
    assert.equal(credentials.status, 409);
    assert.equal((await credentials.json() as { code: string }).code, "AGENT_KEYLESS");
    const foreignRead = await call(
      `/v1/agents/${victim.id}`,
      "GET",
      undefined,
      "attacker-fixture-key",
    );
    assert.equal(foreignRead.status, 404);
    for (const url of [
      "https://10.0.0.1/hook",
      "https://[fe80::1]/hook",
      "http://192.168.0.1/hook",
    ]) {
      const refused = await call(
        "/v1/webhooks",
        "POST",
        { url, events: ["usage.recorded"] },
        "owner-fixture-key",
      );
      assert.equal(refused.status, 400);
    }
  } finally {
    await fixture.stop();
  }
});
