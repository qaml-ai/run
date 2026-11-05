import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { startFixture } from "./fixture.ts";
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function client(f: Awaited<ReturnType<typeof startFixture>>) {
  return async (
    path: string,
    body?: unknown,
    extra: Record<string, string> = {},
  ) => {
    const response = await fetch(f.url + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${f.token}`,
        "content-type": "application/json",
        ...extra,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as any };
  };
}

test(
  "tenant rejection cannot later execute an unaccepted request",
  { timeout: 60000 },
  async (t) => {
    const f = await startFixture({ vars: { TENANT_MAX_ACTIVE: "1" } });
    t.after(() => f.stop());
    const call = client(f);
    const a = (
        await call("/v1/agents", {
          model: "test/echo",
        })
      ).body.id,
      b = (await call("/v1/agents", { model: "test/echo" })).body.id;
    assert.equal(
      (
        await call(`/v1/agents/${a}/requests`, {
          id: "blocking",
          method: "prompt",
          params: { text: "slow:2500:release me" },
        })
      ).status,
      202,
    );
    const denied = await call(`/v1/agents/${b}/requests`, {
      id: "denied",
      method: "prompt",
      params: { text: "must wait for retry" },
    });
    assert.equal(denied.status, 429);
    for (let i = 0; i < 100; i++) {
      const r = await call(`/v1/agents/${a}/requests/blocking?wait=1`);
      if (r.body.state === "completed") break;
      await delay(20);
    }
    await delay(1300);
    assert.equal((await call(`/v1/agents/${b}/state`)).body.requests.length, 0);
    assert.equal(
      (await call(`/v1/agents/${b}/history`)).body.messages.length,
      0,
    );
    assert.equal(
      (
        await call(`/v1/agents/${b}/requests`, {
          id: "denied",
          method: "prompt",
          params: { text: "must wait for retry" },
        })
      ).status,
      202,
    );
    for (let i = 0; i < 100; i++) {
      const r = await call(`/v1/agents/${b}/requests/denied?wait=1`);
      if (r.body.state === "completed") break;
      await delay(20);
    }
  },
);

test(
  "human pauses release admission and account each resumed segment once",
  { timeout: 60000 },
  async (t) => {
    const f = await startFixture({ vars: { TENANT_MAX_ACTIVE: "1" } });
    t.after(() => f.stop());
    const call = client(f);
    const a = (
      await call("/v1/agents", { model: "test/echo", builtins: ["ask_human"] })
    ).body.id;
    const b = (await call("/v1/agents", { model: "test/echo" })).body.id;
    await call(`/v1/agents/${a}/requests`, {
      id: "pause",
      method: "prompt",
      params: { text: "ask:continue?" },
    });
    let inputs: any[] = [];
    for (let n = 0; n < 100 && !inputs.length; n++) {
      inputs = (await call(`/v1/agents/${a}/inputs`)).body;
      await delay(20);
    }
    assert.equal(inputs.length, 1);
    for (let n = 0; n < 100; n++) {
      const receipts = await f.db.query(
        "select count(*)::int n from idempotency_keys where tenant=$1 and key like 'workers:receipt:%'",
        ["camelrun-proto-local"],
      );
      if (receipts.rows[0].n) break;
      await delay(20);
    }
    assert.equal(
      (
        await call(`/v1/agents/${b}/requests`, {
          id: "while-paused",
          method: "prompt",
          params: { text: "hello" },
        })
      ).status,
      202,
    );
    for (let n = 0; n < 100; n++) {
      if (
        (await call(`/v1/agents/${b}/requests/while-paused?wait=1`)).body
          .state === "completed"
      )
        break;
    }
    const before = Number(
      (
        await f.db.query(
          "select count(*) n from idempotency_keys where tenant=$1 and key like 'workers:receipt:%'",
          ["camelrun-proto-local"],
        )
      ).rows[0].n,
    );
    const answered = await call(`/v1/agents/${a}/inputs/${inputs[0].id}`, {
      answer: "yes",
    });
    assert.equal(answered.status, 200);
    const resumed = answered.body.request.id;
    let result: any;
    for (let n = 0; n < 100; n++) {
      result = (await call(`/v1/agents/${a}/requests/${resumed}?wait=1`)).body;
      if (result.state === "completed") break;
    }
    assert.equal(result.status, "completed");
    assert.match(result.outcome.result.reply, /yes/);
    const after = Number(
      (
        await f.db.query(
          "select count(*) n from idempotency_keys where tenant=$1 and key like 'workers:receipt:%'",
          ["camelrun-proto-local"],
        )
      ).rows[0].n,
    );
    assert.equal(
      after,
      before + 1,
      "resume uses its own immutable active-time receipt",
    );
    const attempts = (
      await f.db.query(
        "select context from model_attempts where agent=$1 order by started_at",
        [a],
      )
    ).rows;
    assert.deepEqual(
      attempts.map((row) => row.context.requestId),
      ["pause", resumed],
    );
  },
);

test(
  "concurrent configuration leaves Postgres and Pi on one revision",
  { timeout: 60000 },
  async (t) => {
    const model = createServer(async (req, res) => {
      let bytes = "";
      for await (const chunk of req) bytes += chunk;
      const input = JSON.parse(bytes);
      const content = input.messages
        .filter((m: any) => m.role === "system" || m.role === "developer")
        .map((m: any) => m.content)
        .join("\n");
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        `data: ${JSON.stringify({ id: "local", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "local", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
      );
    });
    model.listen(0, "127.0.0.1");
    await once(model, "listening");
    const port = (model.address() as { port: number }).port,
      f = await startFixture({ modelURL: `http://127.0.0.1:${port}/v1` });
    t.after(async () => {
      await f.stop();
      await new Promise<void>((resolve) => model.close(() => resolve()));
    });
    const call = client(f);
    const headers = { "Idempotency-Key": "race-config" };
    const first = await call(
      "/v1/agents",
      { systemPrompt: "REVISION_INITIAL", model: "test/echo" },
      headers,
    );
    assert.equal(first.status, 201);
    const id = first.body.id;
    const changes = await Promise.all(
      ["REVISION_B", "REVISION_C"].map((systemPrompt) =>
        call("/v1/agents", { systemPrompt, model: "test/echo" }, headers),
      ),
    );
    assert.ok(
      changes.every((x) => [201, 409].includes(x.status)),
      JSON.stringify(changes.map((x) => x.status)),
    );
    const config = (await call(`/v1/agents/${id}/configuration`)).body;
    const admitted = await call(`/v1/agents/${id}/requests`, {
      id: "check-revision",
      method: "prompt",
      params: { text: "Which revision?" },
    });
    assert.equal(admitted.status, 202);
    let result: any;
    for (let i = 0; i < 100; i++) {
      result = (await call(`/v1/agents/${id}/requests/check-revision?wait=1`))
        .body;
      if (result.state === "completed") break;
      await delay(20);
    }
    assert.match(result.outcome.result.reply, new RegExp(config.systemPrompt));
  },
);

test(
  "accepted turn settles after restart without a client result poll",
  { timeout: 60000 },
  async (t) => {
    const f = await startFixture();
    t.after(() => f.stop());
    const call = client(f);
    const id = (await call("/v1/agents", { model: "test/echo" })).body.id;
    const accepted = await call(`/v1/agents/${id}/requests`, {
      id: "background-recovery",
      method: "prompt",
      params: { text: "slow:2000:recover without polling" },
    });
    assert.equal(accepted.status, 202);
    await f.worker.stop(true);
    await f.worker.start();
    // Only the financial authority is inspected after restart. No agent HTTP call
    // may be needed to project Pi completion or settle the reservation.
    let receipts = 0;
    for (let i = 0; i < 200; i++) {
      receipts = Number(
        (await f.db.query("SELECT count(*) n FROM usage_flushes")).rows[0].n,
      );
      if (receipts) break;
      await delay(50);
    }
    assert.equal(receipts, 1);
    assert.equal(
      Number(
        (await f.db.query("SELECT count(*) n FROM credit_holds")).rows[0].n,
      ),
      0,
    );
    const ledger = await f.db.query(
      "select sum(amount)::bigint total from credit_ledger where tenant=$1",
      ["camelrun-proto-local"],
    );
    const balance = await f.db.query(
      "select balance from credit_accounts where tenant=$1",
      ["camelrun-proto-local"],
    );
    assert.equal(Number(balance.rows[0].balance), Number(ledger.rows[0].total));
    assert.ok(
      Number(balance.rows[0].balance) <= 100000000,
      "source-priced active time is charged",
    );
  },
);
