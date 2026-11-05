import {contractTest, createContractFixture} from '../support.ts';
import type {ModelReply, ContractFixture} from '../fixture.ts';
import type {T} from '../http.ts';
async function runtime(t:T,respond:ModelReply,env:Record<string,string>={},tenants?:object):Promise<ContractFixture>{return createContractFixture(t,{respond,env,tenants});}

import assert from "node:assert/strict";

import {createHash} from "node:crypto";

import {readFileSync} from "node:fs";

import {toolCallStreaming} from "../../../src/catalog.ts";

import {OPERATOR} from "../support.ts";

const measured: Record<string, boolean> = JSON.parse(readFileSync(new URL("../../../src/tool-streaming.json", import.meta.url), "utf8")).models;

contractTest("models", "tests/tool-streaming.test.ts:42", "GET /v1/models carries toolCallStreaming; a model on an operator's endpoint has its upstream model's", async t => {
  const [streams] = Object.entries(measured).find(([id, value]) => value && id.startsWith("openrouter/"))!;
  const [single] = Object.entries(measured).find(([id, value]) => !value && id.startsWith("openrouter/"))!;
  const tenants = { tenants: { alice: {
    tokenSha256: createHash("sha256").update(OPERATOR).digest("hex"),
    modelEndpoints: { gw: { baseUrl: "https://gateway.example.com", models: { [streams]: { contextWindow: 8_000, maxTokens: 1_000 }, [single]: { contextWindow: 8_000, maxTokens: 1_000 }, "openrouter/free/tiny": { contextWindow: 4_000, maxTokens: 1_000 } } } },
  } } };
  const r = await runtime(t, () => ({ role: "assistant", content: "unused" }), {}, tenants);
  const own = Object.fromEntries((await r.call("/v1/models?provider=gw")).json.map((model: any) => [model.id, model.toolCallStreaming]));
  assert.deepEqual(own, { [`gw/${streams}`]: true, [`gw/${single}`]: false, "gw/openrouter/free/tiny": "unknown" });
  const catalog = (await r.call("/v1/models?provider=openrouter")).json;
  assert.equal(catalog.find((model: any) => model.id === streams).toolCallStreaming, true);
  assert.equal(catalog.find((model: any) => model.id === single).toolCallStreaming, false);
});
