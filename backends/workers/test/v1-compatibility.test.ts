import assert from "node:assert/strict";
import test from "node:test";
import { canonical } from "../../../shared/durable-json.ts";
import { hash } from "../../../src/client-sessions/state.ts";
import { V1Compatibility } from "../../../src/v1-v2-compatibility.ts";
import type { Sql } from "../src/postgres.ts";
import { handleLegacyAgentRequest } from "../src/v1-compatibility.ts";

const agent = `client_${"a".repeat(40)}`;
const destination = "ag_v2";
const principal = { tenantId: "alice", kind: "api" };
const mounts = [{ volumeId: "vol_test", path: "/workspace", mode: "rw" }];
const receipt = {
  id: "legacy", method: "prompt", startedAt: 1, began: 1, endedAt: 2, state: "completed",
  fingerprint: hash(canonical({ method: "prompt", params: { text: "hello" } })),
  outcome: { result: { reply: "earlier" } },
};

function fixture({ published = true, hasArchive = true } = {}) {
  const forwarded: string[] = [];
  const fingerprints = new Map<string, string>();
  const sql: Sql = {
    async query<R>(text: string, values = []) {
      const rows: unknown[] = [];
      if (text.includes("from agents")) {
        assert.equal(values[0], agent);
        if (values[1] === principal.tenantId) rows.push({ mounts });
      } else if (text.includes("from agent_v2_cutovers")) {
        assert.equal(values[0], principal.tenantId);
        assert.equal(values[1], agent);
        if (published) rows.push({ tenant: values[0], agent, destination_tenant: "v2", destination_agent: destination, event_base: 42 });
      } else if (text.includes("from agent_v2_receipt_archives")) {
        if (hasArchive) rows.push(values[2] ? { receipt: values[2] === receipt.id ? receipt : null } : { receipts: [receipt] });
      } else if (text.startsWith("insert into agent_v2_requests")) {
        fingerprints.set(values[2], values[3]);
        return { rows: [] as R[], rowCount: 1 };
      } else if (text.includes("from agent_v2_requests") && !text.includes("any(")) {
        const fingerprint = fingerprints.get(values[2]);
        if (fingerprint) rows.push({ fingerprint });
      } else {
        assert.fail(`Unhandled query: ${text}`);
      }
      return { rows: rows as R[], rowCount: rows.length };
    },
  };
  const compatibility = new V1Compatibility(sql, new URL("https://v2.invalid/v2/"), new Map([["v2", "example-only"]]), async (input, init) => {
    const path = new URL(String(input)).pathname;
    forwarded.push(path);
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer example-only");
    if (path.endsWith("/events")) return Response.json({ events: [], nextAfter: 0 });
    const { prompt, idempotencyKey } = JSON.parse(String(init?.body));
    assert.equal(prompt, "next");
    return Response.json({
      id: "run_next", agentId: destination, idempotencyKey, startedAt: 3, status: "queued", text: "",
      output: null, toolCalls: [], usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 }, error: null,
    });
  });
  const request = (tail: string, init?: RequestInit, caller = principal) =>
    handleLegacyAgentRequest(new Request(`https://run.camelai.com/v1/agents/${agent}/${tail}`, init), sql, compatibility, caller);
  return { request, forwarded };
}

test("answers legacy mounts before publication and leaves the active turn on its runtime", async () => {
  const { request, forwarded } = fixture({ published: false });
  assert.deepEqual(await (await request("mounts"))?.json(), mounts);
  assert.equal(await request("state"), undefined);
  assert.deepEqual(forwarded, []);
});

test("preserves old request IDs and rejects cross-tenant reads", async () => {
  const { request, forwarded } = fixture();
  assert.deepEqual(await (await request("requests/legacy"))?.json(), receipt);
  const retried = await request("prompt", { method: "POST", body: JSON.stringify({ text: "hello", requestId: "legacy" }) });
  assert.equal(retried?.status, 202);
  assert.deepEqual(await retried?.json(), receipt);
  await assert.rejects(request("mounts", undefined, { ...principal, tenantId: "bob" }), { status: 404 });
  assert.deepEqual(forwarded, []);
});

test("accepts a new legacy request against its published v2 agent, or fails if the old ledger is unavailable", async () => {
  const init = { method: "POST", headers: { "Idempotency-Key": "next" }, body: JSON.stringify({ text: "next" }) };
  const working = fixture();
  const accepted = await working.request("prompt", init);
  assert.equal(accepted?.status, 202);
  assert.equal((await accepted?.json() as { id: string })?.id, "next");
  assert.deepEqual(working.forwarded, [`/v2/agents/${destination}/runs`]);
  const withoutArchive = fixture({ hasArchive: false });
  await assert.rejects(withoutArchive.request("prompt", init), { status: 503, code: "V1_ARCHIVE_UNAVAILABLE" });
  assert.deepEqual(withoutArchive.forwarded, []);
});

test("keeps the original cursor namespace and propagates legacy replay errors", async () => {
  const { request } = fixture();
  const poll = await request("events?poll=1");
  assert.deepEqual(await poll?.json(), {
    cursor: 42,
    events: [{ id: 42, data: { type: "snapshot", cursor: 42, requestId: null, turn: null } }],
  });
  await assert.rejects(request("events?poll=1&snapshot=0", { headers: { "Last-Event-ID": "41" } }), { status: 409, code: "REPLAY_GAP" });
});
