import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { unstable_startWorker } from "wrangler";
import { CamelRun } from "../sdk/src/index.ts";

const ADMIN_SECRET = "migration-sweep-admin-secret";
const VAULT_SECRET = "migration-sweep-vault-secret-32b";

test("direct pi-durable v1 history import writes zero legacy rows", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "camelrun-pi-migrate-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const config = join(dir, "wrangler.json");
  writeFileSync(
    config,
    JSON.stringify({
      name: "pi-migration-sweep-test",
      main: fileURLToPath(new URL("./fixtures/pi-migration-sweep-worker.ts", import.meta.url)),
      compatibility_date: "2026-03-01",
      compatibility_flags: ["nodejs_compat", "enhanced_error_serialization"],
      vars: {
        ADMIN_SECRET,
        VAULT_SECRET,
        DEFAULT_MODEL: "mock/default",
      },
      durable_objects: {
        bindings: [
          { name: "TENANT_DO", class_name: "TenantDO" },
          { name: "AGENT_DO", class_name: "AgentDO" },
          { name: "VOICE_CALL_DO", class_name: "VoiceCallDO" },
        ],
      },
      migrations: [
        { tag: "v1", new_sqlite_classes: ["TenantDO", "AgentDO"] },
        { tag: "v2", new_sqlite_classes: ["VoiceCallDO"] },
      ],
    }),
  );

  const worker = await unstable_startWorker({ config, dev: { persist: false, logLevel: "none" } });
  t.after(() => worker.dispose());

  const origin = "https://pi-migrate.test";
  const workerFetch = worker.fetch.bind(worker) as unknown as typeof fetch;

  const tenant = await CamelRun.createTenant({
    baseUrl: origin,
    adminKey: ADMIN_SECRET,
    name: "pi-migrate-tenant",
    initialCreditsUsd: 25,
    fetch: workerFetch,
  });
  const camel = new CamelRun({
    baseUrl: origin,
    apiKey: tenant.apiKey,
    fetch: workerFetch,
  });
  t.after(() => camel.close());

  const inspectAgent = async (agentId: string) => {
    const res = await worker.fetch(`${origin}/_migration_fixture/${agentId}/inspect`);
    assert.equal(res.status, 200);
    return (await res.json()) as {
      legacyMessagesCount: number;
      hasPiRoot: boolean;
      piEntriesCount: number;
    };
  };

  // =========================================================================
  // 1. PUT /v2/agents/:id/history/import writes directly to pi-durable
  //    with 0 rows in legacy `messages`, preserves proof/idempotency/replace,
  //    and GET /history + follow-up run work cleanly.
  // =========================================================================
  await t.test("1. PUT /history/import writes directly into pi-durable with 0 legacy messages rows", async () => {
    const importedAgent = await camel.agents.upsert("direct-pi-import", {
      model: "mock/default",
      builtins: [],
    });

    const v1Messages = [
      { role: "user", content: [{ type: "text", text: "Remember secret ZETA-99" }], timestamp: 1000 },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "lookup", arguments: { q: "zeta" } }],
        timestamp: 1001,
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "lookup",
        content: [{ type: "text", text: "ZETA-RESULT" }],
        timestamp: 1002,
      },
      { role: "assistant", content: [{ type: "text", text: "Got ZETA-99 and ZETA-RESULT." }], timestamp: 1003 },
    ];

    const imported = await importedAgent.importV1History({
      source: "v1-direct-test",
      messages: v1Messages,
    });
    assert.equal(imported.count, 4);

    // Idempotent retry returns exact same receipt and count
    const retry = await importedAgent.importV1History({
      source: "v1-direct-test",
      messages: v1Messages,
    });
    assert.deepEqual(retry, imported);

    // Verify 0 rows in legacy `messages` and Pi root populated directly!
    const storageState = await inspectAgent(importedAgent.id);
    assert.equal(storageState.legacyMessagesCount, 0, "Expected 0 rows in legacy messages table");
    assert.equal(storageState.hasPiRoot, true, "Expected pi_conversations root to exist immediately after import");
    assert.equal(storageState.piEntriesCount, 4, "Expected 4 entries in pi_entries");

    // Verify GET /history/import proof returns exact receipt & messageCount
    const proofRes = await worker.fetch(`${origin}/v2/agents/${importedAgent.id}/history/import`, {
      headers: { Authorization: `Bearer ${tenant.apiKey}` },
    });
    assert.equal(proofRes.status, 200);
    const proof = (await proofRes.json()) as { source: string; receipt: string; messageCount: number };
    assert.equal(proof.source, "v1-direct-test");
    assert.equal(proof.receipt, imported.receipt);
    assert.equal(proof.messageCount, 4);

    // Single-shot replacement with previous receipt works cleanly and keeps 0 legacy rows
    const replacedMessages = [
      ...v1Messages,
      { role: "user", content: "Also note OMEGA-77", timestamp: 1004 },
      { role: "assistant", content: [{ type: "text", text: "Noted OMEGA-77." }], timestamp: 1005 },
    ];
    const replaced = await importedAgent.importV1History({
      source: "v1-direct-test",
      previous: imported.receipt,
      messages: replacedMessages,
    });
    assert.equal(replaced.count, 6);
    const afterReplaceState = await inspectAgent(importedAgent.id);
    assert.equal(afterReplaceState.legacyMessagesCount, 0);
    assert.equal(afterReplaceState.hasPiRoot, true);
    assert.equal(afterReplaceState.piEntriesCount, 6);

    // GET /history serves all 6 imported messages with meta.v1 intact
    const histBeforeRun = await importedAgent.history();
    assert.equal(histBeforeRun.length, 6);
    assert.deepEqual(
      histBeforeRun.map((m) => (m.content as { meta?: { v1?: unknown } }).meta?.v1),
      replacedMessages,
    );

    // Follow-up run works cleanly on top of directly-imported Pi transcript
    const followUp = await importedAgent.run("Follow-up after direct pi import");
    assert.equal(followUp.status, "completed");

    const histAfterRun = await importedAgent.history();
    assert.equal(histAfterRun.length, 8);
    assert.equal((histAfterRun[6]!.content as { text?: string }).text, "Follow-up after direct pi import");

    // Still 0 rows in legacy `messages`
    const finalStorage = await inspectAgent(importedAgent.id);
    assert.equal(finalStorage.legacyMessagesCount, 0);
  });

  // =========================================================================
  // 2. Chunked PUT /history/import/chunk writes directly to pi-durable
  //    with 0 legacy rows and preserves idempotency + proof.
  // =========================================================================
  await t.test("2. PUT /history/import/chunk appends directly into pi-durable with 0 legacy messages rows", async () => {
    const chunkedAgent = await camel.agents.upsert("direct-pi-chunked", {
      model: "mock/default",
      builtins: [],
    });

    const c1 = await chunkedAgent.importV1History({
      source: "v1-chunked-test",
      appendAfter: 0,
      messages: [
        { role: "user", content: "Chunk 1 user", timestamp: 2000 },
        { role: "assistant", content: [{ type: "text", text: "Chunk 1 assistant" }], timestamp: 2001 },
      ],
    });
    assert.equal(c1.count, 2);

    const c2 = await chunkedAgent.importV1History({
      source: "v1-chunked-test",
      previous: c1.receipt,
      appendAfter: 2,
      messages: [
        { role: "user", content: "Chunk 2 user", timestamp: 2002 },
        { role: "assistant", content: [{ type: "text", text: "Chunk 2 assistant" }], timestamp: 2003 },
      ],
    });
    assert.equal(c2.count, 4);

    const state = await inspectAgent(chunkedAgent.id);
    assert.equal(state.legacyMessagesCount, 0);
    assert.equal(state.hasPiRoot, true);
    assert.equal(state.piEntriesCount, 4);

    const hist = await chunkedAgent.history();
    assert.equal(hist.length, 4);
    assert.equal((hist[0]!.content as { text?: string }).text, "Chunk 1 user");
    assert.equal((hist[3]!.content as { text?: string }).text, "Chunk 2 assistant");
  });
});
