import assert from "node:assert/strict";
import test from "node:test";
import { startFixture } from "./fixture.ts";

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test("HTTP host scripts keep separate human inputs across restart and cancellation", { timeout: 120_000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.stop());
  const call = async (path: string, input?: unknown) => {
    const response = await fetch(fixture.url + path, {
      method: input === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${fixture.token}`, "content-type": "application/json" },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
    return { status: response.status, value: await response.json() as any };
  };
  const agent = (await call("/v1/agents", { model: "test/echo", builtins: ["ask_human"] })).value;
  const base = `/v1/agents/${agent.id}`;
  const result = async (id: string) => {
    for (let attempt = 0; attempt < 150; attempt++) {
      const record = (await call(`${base}/requests/${id}?wait=1`)).value;
      if (record.state === "completed") return record;
      await delay(20);
    }
    throw new Error(`Request ${id} did not finish`);
  };
  const inputs = async (count: number) => {
    for (let attempt = 0; attempt < 150; attempt++) {
      const found = (await call(`${base}/inputs?state=pending`)).value;
      if (found.length === count) return found as any[];
      await delay(20);
    }
    throw new Error(`Expected ${count} pending inputs`);
  };
  assert.equal((await call(`${base}/requests`, { id: "model", method: "prompt", params: { text: "slow:1500:model remains healthy" } })).status, 202);
  for (const id of ["first", "second"]) {
    assert.equal((await call(`${base}/requests`, { id, method: "execute", params: { code: `return await tools.ask_human({question:${JSON.stringify(id)}})` } })).status, 202);
  }
  const pending = await inputs(2);
  assert.deepEqual(pending.map(input => input.requestId).sort(), ["first", "second"]);
  assert.equal((await result("model")).status, "completed", "host inputs must not pause the concurrent model run");
  for (const id of ["first", "second"]) assert.equal((await call(`${base}/requests/${id}`)).value.state, "running");
  await fixture.worker.stop(true);
  await fixture.worker.start();
  for (const input of pending) {
    const answer = `${input.requestId} answer`;
    const answered = await call(`${base}/inputs/${input.id}`, { answer });
    assert.equal(answered.status, 202, JSON.stringify(answered.value));
    assert.equal(answered.value.request.id, input.requestId, "host resumes its ToolTask, not a model submission alias");
    assert.deepEqual((await result(input.requestId)).outcome.result.output, [answer]);
  }
  assert.equal((await call(`${base}/history`)).value.messages.length, 2, "host scripts do not append to model history");

  await call(`${base}/requests`, { id: "batch-host", method: "execute", params: { code: 'return await Promise.all([tools.ask_human({question:"First?"}), tools.ask_human({question:"Second?"})])' } });
  const batchInputs = (await inputs(2)).sort((a, b) => a.question.localeCompare(b.question));
  assert.deepEqual((await call("/v1/inputs?state=pending")).value.map((item: any) => item.id).sort(), batchInputs.map(item => item.id).sort());
  const batch = { answers: batchInputs.map((item, index) => ({ id: item.id, answer: `answer-${index}` })) };
  assert.equal((await call(`${base}/inputs`, { answers: [batch.answers[0], { id: batchInputs[1].id, action: "invalid" }] })).status, 400);
  assert.equal((await inputs(2)).length, 2, "a bad batch does not record its valid first answer");
  const batchAnswer = await call(`${base}/inputs`, batch);
  assert.equal(batchAnswer.status, 202, JSON.stringify(batchAnswer.value));
  assert.deepEqual(batchAnswer.value.requests.map((item: any) => item.id), ["batch-host"]);
  assert.deepEqual((await result("batch-host")).outcome.result.output, ['["answer-0","answer-1"]']);
  const retry = await call(`${base}/inputs`, batch);
  assert.equal(retry.status, 200);
  assert.deepEqual(retry.value.inputs.map((item: any) => item.answer.at), batchAnswer.value.inputs.map((item: any) => item.answer.at));
  assert.deepEqual((await call("/v1/inputs?state=pending")).value, []);

  await call(`${base}/requests`, { id: "abort-host", method: "execute", params: { code: 'return await tools.ask_human({question:"Cancel host?"})' } });
  const [hostInput] = await inputs(1);
  await call(`${base}/requests`, { id: "abort-host-now", method: "abort", params: {} });
  assert.equal((await call(`${base}/inputs/${hostInput.id}`, { answer: "too late" })).status, 409);
  assert.equal((await call(`${base}/inputs?state=cancelled`)).value.some((input: any) => input.id === hostInput.id), true);
  assert.equal((await result("abort-host")).status, "failed");

  await call(`${base}/requests`, { id: "abort-model", method: "prompt", params: { text: "ask:Cancel model?" } });
  const [modelInput] = await inputs(1);
  await call(`${base}/requests`, { id: "abort-model-now", method: "abort", params: {} });
  assert.equal((await call(`${base}/inputs/${modelInput.id}`, { answer: "too late" })).status, 409);
  assert.equal((await call(`${base}/inputs?state=pending`)).value.length, 0);
  await call(`${base}/requests`, { id: "after-abort", method: "prompt", params: { text: "still usable" } });
  assert.equal((await result("after-abort")).status, "completed");
});
