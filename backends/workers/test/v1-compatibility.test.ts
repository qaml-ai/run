import assert from "node:assert/strict";
import test from "node:test";
import { V1_COMPAT_REQUEST_PREFIX } from "../../../shared/client-protocol.ts";
import { canonical } from "../../../shared/durable-json.ts";
import { hash } from "../../../src/client-sessions/state.ts";
import { V1Compatibility } from "../../../src/v1-v2-compatibility.ts";
import type { Sql } from "../src/postgres.ts";
import { handleLegacyAgentRequest } from "../src/v1-compatibility.ts";

const agent = `client_${"a".repeat(40)}`;
const destination = "ag_v2";
const agentKey = "agent-key-used-before-cutover";
const principal = { tenantId: "alice", kind: "api" };
const mounts = [{ volumeId: "vol_test", path: "/workspace", mode: "rw" }];
const receipt = {
  id: "legacy", method: "prompt", startedAt: 1, began: 1, endedAt: 2, state: "completed",
  fingerprint: hash(canonical({ method: "prompt", params: { text: "hello" } })),
  outcome: { result: { reply: "earlier" } },
};

function fixture({ published = true, hasArchive = true, history = false, historyAgent = destination } = {}) {
  const forwarded: string[] = [];
  const fingerprints = new Map<string, string>([["continued", receipt.fingerprint]]);
  const sql: Sql = {
    async query<R>(text: string, values = []) {
      const rows: unknown[] = [];
      if (text.includes("from agents")) {
        assert.equal(values[0], agent);
        if (values.length === 1) rows.push({ tenant: principal.tenantId, revoked: false, purged: false, expires_at: null, digest: hash(agentKey) });
        else if (values[1] === principal.tenantId) rows.push({ mounts });
      } else if (text.includes("from agent_v2_cutovers")) {
        assert.equal(values[0], principal.tenantId);
        assert.equal(values[1], agent);
        if (published) rows.push({ tenant: values[0], agent, destination_tenant: "v2", destination_agent: destination, event_base: 42 });
      } else if (text.includes("from agent_v2_receipt_archives")) {
        if (hasArchive) rows.push(values[2] ? { receipt: values[2] === receipt.id ? receipt : null } : { receipts: [receipt] });
      } else if (text.startsWith("insert into agent_v2_requests")) {
        fingerprints.set(values[2], values[3]);
        return { rows: [] as R[], rowCount: 1 };
      } else if (text.includes("from agent_v2_requests")) {
        if (text.includes("any(")) {
          for (const requestId of values[2] as string[]) {
            const fingerprint = fingerprints.get(requestId);
            if (fingerprint) rows.push({ request_id: requestId, fingerprint });
          }
        } else {
          const fingerprint = fingerprints.get(values[2]);
          if (fingerprint) rows.push({ fingerprint });
        }
      } else {
        assert.fail(`Unhandled query: ${text}`);
      }
      return { rows: rows as R[], rowCount: rows.length };
    },
  };
  const compatibility = V1Compatibility.configured(sql, '{"v2":"cr_live_v2.example-only"}', "https://v2.invalid/v2/", async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname;
    forwarded.push(path);
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer cr_live_v2.example-only");
    const historyRun = (id: string) => ({
      id, agentId: historyAgent,
      idempotencyKey: id === "run_native" ? "native_request" : id === "run_legacy" ? V1_COMPAT_REQUEST_PREFIX + "continued" : null,
      startedAt: 3, status: id === "run_keyless" ? "running" : "completed", text: "done", output: null, toolCalls: [],
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 }, error: null,
    });
    if (path.endsWith("/events")) {
      if (!history) return Response.json({ events: [], nextAfter: 0 });
      const events = [
        { seq: 1, runId: "run_native", type: "run_started", data: {} },
        { seq: 2, runId: "run_native", type: "tool_call_start", data: { callId: "call", name: "list_bots", args: {} } },
        { seq: 3, runId: "run_native", type: "run_completed", data: {} },
        { seq: 4, runId: "run_legacy", type: "run_completed", data: {} },
      ];
      return Response.json({ events: url.searchParams.get("after") === "latest" ? [] : events, nextAfter: events.length });
    }
    if (history && path.endsWith("/runs") && init?.method === "GET") return Response.json({
      cursor: 4, activeRunId: "run_keyless", runs: ["run_native", "run_keyless", "run_legacy"].map(historyRun),
    });
    if (history && path.endsWith("/history")) {
      const messages = [
        { seq: 1, runId: null, role: "user", content: { meta: { v1: { role: "user", content: "before", requestId: "legacy" } } }, createdAt: 1 },
        { seq: 2, runId: "run_native", role: "user", content: { text: "from the v2 app" }, createdAt: 2 },
        { seq: 3, runId: "run_native", role: "tool", content: { toolName: "list_bots", toolCallId: "call", text: "listed" }, createdAt: 3 },
        { seq: 4, runId: "run_keyless", role: "user", content: { text: "without a request key" }, createdAt: 4 },
        { seq: 5, runId: "run_legacy", role: "user", content: { text: "from v1" }, createdAt: 5 },
      ];
      return Response.json({ messages: url.searchParams.has("before") ? messages.slice(-1) : messages });
    }
    if (history && path.includes("/runs/")) return Response.json(historyRun(path.split("/").at(-1)!));
    const { prompt, idempotencyKey } = JSON.parse(String(init?.body));
    assert.equal(prompt, "next");
    return Response.json({
      id: "run_next", agentId: destination, idempotencyKey, startedAt: 3, status: "queued", text: "",
      output: null, toolCalls: [], usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 }, error: null,
    });
  })!;
  const request = (tail: string, init?: RequestInit, caller = principal) =>
    handleLegacyAgentRequest(new Request(`https://run.camelai.com/v1/agents/${agent}/${tail}`, init), sql, compatibility, caller);
  const scoped = (tail: string, init?: RequestInit) =>
    handleLegacyAgentRequest(new Request(`https://run.camelai.com/clients/${agent}/${tail}`, init), sql, compatibility, null);
  return { request, scoped, forwarded };
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

test("keeps scoped agent credentials without permitting browser-origin requests", async () => {
  const { scoped, forwarded } = fixture();
  const headers = { Authorization: `Bearer ${agentKey}` };
  await assert.rejects(scoped("requests/legacy"), { status: 401 });
  await assert.rejects(scoped("requests/legacy", { headers: { ...headers, Origin: "https://other.invalid" } }), { status: 401 });
  assert.deepEqual(await (await scoped("requests/legacy", { headers }))?.json(), receipt);
  const retried = await scoped("requests", {
    method: "POST", headers, body: JSON.stringify({ id: "legacy", method: "prompt", params: { text: "hello" } }),
  });
  assert.equal(retried?.status, 202);
  assert.deepEqual(await retried?.json(), receipt);
  assert.deepEqual(forwarded, []);
});

test("shows imported, native v2, and later v1 turns under the original scoped key", async () => {
  const { scoped } = fixture({ history: true });
  const headers = { Authorization: `Bearer ${agentKey}` };
  const response = await scoped("history?after=0&limit=10", { headers });
  assert.equal(response?.status, 200);
  const { entries, total } = await response!.json() as { entries: Array<{ message: { role: string; requestId?: string; toolName?: string } }>; total: number };
  assert.equal(total, 5);
  assert.deepEqual(entries.map(entry => [entry.message.role, entry.message.requestId ?? entry.message.toolName]), [
    ["user", "legacy"], ["user", "native_request"], ["toolResult", "list_bots"], ["user", "run_keyless"], ["user", "continued"],
  ]);
  const wrongDestination = fixture({ history: true, historyAgent: "other_v2" });
  await assert.rejects(wrongDestination.scoped("history?after=0&limit=10", { headers }), { status: 502, code: "V2_RUNTIME_UNAVAILABLE" });
});



test("native v2 runs appear in legacy state and events without creating v1 replay receipts", async () => {
  const { scoped } = fixture({ history: true });
  const headers = { Authorization: `Bearer ${agentKey}` };
  const state = await (await scoped("state", { headers }))!.json() as {
    activeRun: string; busy: boolean; cursor: number; requests: Array<{ id: string; fingerprint: string }>;
  };
  assert.equal(state.activeRun, "run_keyless");
  assert.equal(state.busy, true);
  assert.equal(state.cursor, 46);
  assert.deepEqual(state.requests.map(({ id, fingerprint }) => [id, fingerprint]), [
    ["legacy", receipt.fingerprint], ["native_request", "v2:run_native"], ["run_keyless", "v2:run_keyless"], ["continued", receipt.fingerprint],
  ]);
  const { events, cursor } = await (await scoped("events?poll=1&request=native_request", { headers }))!.json() as {
    cursor: number; events: Array<{ id: number; data: { type: string; requestId?: string; id?: string; event?: { type: string } } }>;
  };
  assert.equal(cursor, 46);
  assert.deepEqual(events.slice(1).map(({ id, data }) => [id, data.requestId ?? data.id, data.event?.type ?? data.type]), [
    [43, "native_request", "agent_start"], [44, "native_request", "tool_execution_start"], [45, "native_request", "response"],
  ]);
  await assert.rejects(scoped("requests/native_request", { headers }), { status: 404 });
  assert.deepEqual(await (await scoped("requests/legacy", { headers }))?.json(), receipt);
});
