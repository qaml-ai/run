import assert from "node:assert/strict";
import test from "node:test";
import { createAssistantMessageEventStream, type Api, type Model, type StreamOptions, type TranscriptContext } from "@earendil-works/pi-ai";
import { MODEL_INVOCATION } from "../src/model-request-auth.ts";
import { modelRuntime } from "../src/model.ts";
import { Billing } from "../src/billing.ts";
import { AgentInvocation } from "../src/agent-invocation.ts";
import type { Db } from "../src/postgres.ts";
import { databaseTenants } from "../src/billing-host.ts";

function fixture() {
  const statements: string[] = [];
  let balance = 0;
  const db = {
    async query(sql: string) {
      if (sql.includes("from tenants")) {
        statements.push("tenant");
        return { rows: [{ billing: "prepaid", limits: { maxBusyAgents: 2 } }] };
      }
      assert.match(sql, /credit_spend_minutes/);
      statements.push("account");
      return { rows: [{ balance, purchased: 1, last_hour: "0", disputed: false }] };
    },
  } as unknown as Db;
  return { billing: new Billing({ db, tenants: databaseTenants }), statements, fund: () => { balance = 1; } };
}

test("pre-read tenant policy and account skip SQL, with the same refusal as the ordinary read", async () => {
  const { billing, statements } = fixture();
  const row = await billing.readTenant("tenant");
  const account = await billing.readAccount("tenant");
  statements.length = 0;
  const reads = { row: async () => row, account: async () => account };
  const refusal = await billing.creditLimit("tenant", reads);
  assert.equal(refusal?.code, "INSUFFICIENT_CREDIT");
  assert.deepEqual(await billing.busyLimit("tenant", undefined, reads), { limit: 2, source: "tenant" });
  assert.deepEqual(statements, []);

  assert.equal((await billing.creditLimit("tenant"))?.message, refusal.message);
  assert.deepEqual(statements, ["tenant", "account"]);
});

test("tenant reads join within an invocation and fresh balances bypass Billing's cache", async () => {
  const { billing, statements, fund } = fixture();
  const invocation = new AgentInvocation();
  assert.deepEqual(await Promise.all([
    billing.mode("tenant", undefined, invocation.tenant(billing, "tenant")),
    billing.mode("tenant", undefined, invocation.tenant(billing, "tenant")),
  ]), ["prepaid", "prepaid"]);
  await billing.mode("tenant", undefined, new AgentInvocation().tenant(billing, "tenant"));
  assert.equal((await billing.account("tenant")).balance, 0);
  fund();
  assert.equal((await billing.readAccount("tenant")).balance, 1);
  assert.deepEqual(statements, ["tenant", "tenant", "account", "account"]);
});

test("two model steps of one turn each share one tenant read across preflight, credentials and metering", async () => {
  const { billing, statements, fund } = fixture();
  const creditRefusals: Array<string | undefined> = [];
  const scopes: AgentInvocation[] = [];
  const failures: unknown[] = [];
  const stream = (target: Model<Api>, _context: TranscriptContext, options?: StreamOptions) => {
    const output = createAssistantMessageEventStream();
    void (async () => {
      const invocation = (options as StreamOptions & { [MODEL_INVOCATION]: AgentInvocation })[MODEL_INVOCATION];
      scopes.push(invocation);
      const reads = { ...invocation.tenant(billing, "tenant"), account: () => billing.readAccount("tenant") };
      creditRefusals.push((await billing.creditLimit("tenant", reads))?.code);
      await billing.mode("tenant", undefined, reads);
      output.push({ type: "done", reason: "stop", message: {
        role: "assistant", api: target.api, model: target.id, provider: target.provider,
        content: [], stopReason: "stop", timestamp: 1,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      } });
    })().catch(error => {
      // End the stream so assertions below report any failed policy read.
      output.end();
      failures.push(error);
    });
    return output;
  };
  const { models, model } = modelRuntime({ MODEL: "openai/gpt-5.4" }, async () => "tenant", {
    wrapProvider: provider => ({ ...provider, stream, streamSimple: stream }),
    settings: async () => ({ requestId: "same-turn" }),
    beforeRequest: async invocation => {
      await billing.runLimits("tenant", invocation.tenant(billing, "tenant"));
    },
    credentials: async (_provider, invocation) => {
      assert.ok(invocation);
      await billing.mode("tenant", undefined, invocation.tenant(billing, "tenant"));
      return { apiKey: "fixture" };
    },
  });

  const transcript: TranscriptContext = { messages: [{ role: "user", content: "one turn", timestamp: 0 }] };
  const result = await models.streamSimple(model, transcript).result();
  assert.equal(result.stopReason, "stop", result.errorMessage);
  assert.deepEqual(statements, ["tenant", "account"]);
  fund();
  assert.equal((await models.streamSimple(model, transcript).result()).stopReason, "stop");
  assert.deepEqual(statements, ["tenant", "account", "tenant", "account"]);
  assert.deepEqual(creditRefusals, ["INSUFFICIENT_CREDIT", undefined]);
  assert.deepEqual(failures, []);
  assert.notEqual(scopes[0], scopes[1]);
});
