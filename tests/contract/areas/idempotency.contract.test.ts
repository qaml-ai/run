import {contractTest, createContractFixture} from '../support.ts';
import type {ModelReply, ContractFixture} from '../fixture.ts';
import type {T} from '../http.ts';
async function runtime(t:T,respond:ModelReply,env:Record<string,string>={},tenants?:object):Promise<ContractFixture>{return createContractFixture(t,{respond,env,tenants});}

import assert from "node:assert/strict";

import {until} from "../support.ts";

const LOCAL = { AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32" };

contractTest("agents", "tests/idempotency.test.ts:7", "an Idempotency-Key header on any POST replays its first success, refuses other parameters, and names a prompt's request", async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "ok" }), LOCAL);
  const key = { "Idempotency-Key": "create-volume-1" };
  const body = { name: "shared" };
  const first = await r.call("/v1/volumes", { body, headers: key });
  assert.equal(first.status, 201, first.text);
  const again = await r.call("/v1/volumes", { body, headers: key });
  assert.equal(again.status, 201);
  assert.deepEqual(again.json, first.json, "the first response, replayed");
  assert.equal((await r.call("/v1/volumes")).json.filter((volume: any) => volume.name === "shared").length, 1, "made once");
  const other = await r.call("/v1/volumes", { body: { name: "other" }, headers: key });
  assert.deepEqual([other.status, other.json.code], [409, "IDEMPOTENCY_CONFLICT"]);
  // Keys are the tenant's own.
  assert.equal((await r.call("/v1/volumes", { body, headers: key, token: "other-operator-token-at-least-24-chars" })).status, 201);
  // A failure is not kept: the retry runs again.
  const bad = { "Idempotency-Key": "bad-then-good" };
  assert.equal((await r.call("/v1/volumes", { body: { name: 42 }, headers: bad })).status, 400);
  assert.equal((await r.call("/v1/volumes", { body: { name: 42 }, headers: bad })).status, 400);

  // A prompt takes the key as its request's id.
  const agent = (await r.call("/v1/agents", { body: {} })).json.id as string;
  const prompt = await r.call(`/v1/agents/${agent}/prompt`, { body: { text: "hi" }, headers: { "Idempotency-Key": "prompt-1" } });
  assert.equal(prompt.status, 202, prompt.text);
  assert.equal(prompt.json.id, "prompt-1");
  assert.equal((await r.call(`/v1/agents/${agent}/prompt`, { body: { text: "hi" }, headers: { "Idempotency-Key": "prompt-1" } })).json.startedAt, prompt.json.startedAt);
  await until(async () => (await r.call(`/v1/agents/${agent}/requests/prompt-1`)).json.state === "completed", "the prompt");
});
