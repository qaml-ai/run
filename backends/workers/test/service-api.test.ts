import assert from "node:assert/strict";
import test from "node:test";
import { handleServiceRequest } from "../src/service-api.ts";
import type { ControlEnv, DirectoryEntry } from "../src/control.ts";

const id = `client_${"a".repeat(40)}`;
const entry: DirectoryEntry = {
  id, tenantId: "alice", key: "key", config: { name: "Service agent", fileTools: false, systemPrompt: "hello" },
  configHash: "hash", createdAt: 1, expiresAt: null, revision: 1, initialized: true,
};
const auth = { tenantId: "alice", kind: "operator" as const, scopes: ["*"] };
const directory = { list: async () => [entry], get: async (value: string) => value === id ? entry : null };
let calls = 0;
const env = { AGENTS: { getByName: () => ({ fetch: async (request: Request) => {
  calls++;
  if (new URL(request.url).pathname === "/requests") return Response.json(await request.json(), { status: 202 });
  return Response.json({ cursor: 7, requests: [] });
} }) } } as unknown as ControlEnv;
const call = (path: string, init?: RequestInit) => handleServiceRequest(new Request(`https://runtime.test${path}`, init), env, auth, directory);

test("registry bridge authenticates before checking ownership and rejects browsers", async () => {
  calls = 0;
  assert.equal((await handleServiceRequest(new Request("https://runtime.test/registry"), env, null, directory))?.status, 401);
  assert.equal((await call("/registry", { headers: { origin: "https://other.test" } }))?.status, 403);
  const other = `client_${"b".repeat(40)}`;
  assert.equal((await call(`/registry/${other}`))?.status, 404);
  assert.equal((await call(`/registry/${other}/requests`, { method: "POST" }))?.status, 401);
  assert.equal(calls, 0, "unauthorized requests never wake an agent");
});

test("registry lists, inspects supported configuration, and forwards durable requests", async () => {
  const listed = await (await call("/registry"))!.json() as { name: string }[];
  assert.deepEqual(listed.map(item => item.name), ["Service agent"]);
  const inspected = await (await call(`/registry/${id}`))!.json() as any;
  assert.equal(inspected.systemPrompt, "hello");
  assert.equal(inspected.fileTools, false);
  assert.equal(inspected.cursor, 7);
  const request = { id: "request-1", method: "prompt", params: { text: "hello" } };
  const accepted = await call(`/registry/${id}/requests`, { method: "POST", body: JSON.stringify(request) });
  assert.equal(accepted?.status, 202);
  assert.deepEqual(await accepted!.json(), request);
  assert.equal((await call(`/registry/${id}/requests`))?.status, 405);
  assert.equal((await call(`/registry/${id}/history`))?.status, 404);
  assert.equal(await call("/v1/agents"), null);
});
