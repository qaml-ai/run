import assert from "node:assert/strict";
import test from "node:test";
import { startFixture } from "./fixture.ts";

test("a recovered host execution bills only through its durable finish, once", { timeout: 90000 }, async t => {
  const f = await startFixture({ vars: { AGENT_PRICE_AGENT_HOUR_USD: "3600" } });
  t.after(() => f.stop());
  const headers = { authorization: `Bearer ${f.token}`, "content-type": "application/json" };
  const call = async (path: string, input?: unknown) => {
    const response = await fetch(f.url + path, { headers, method: input === undefined ? "GET" : "POST",
      ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    const body = await response.json() as any;
    assert.ok(response.ok, `${response.status} ${path}: ${JSON.stringify(body)}`);
    return body;
  };
  const agent = (await call("/v1/agents", { model: "test/echo" })).id;
  const experimental = `/experimental/agents/${agent}`;
  const request = { id: "host_finish_recovery", method: "execute", params: { code: 'return "finished"' } };
  await call(`${experimental}/__test/crash-next-settlement`, { beforeReceipt: true });
  await call(`/v1/agents/${agent}/requests`, request);
  let finishedAt: number | undefined;
  for (let n = 0; n < 150 && finishedAt === undefined; n++) {
    finishedAt = (await call(`${experimental}/__test/settlement-state`)).hostFinishedAt;
    if (finishedAt === undefined) await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(typeof finishedAt, "number", "the native task finished before the adapter's receipt");
  assert.equal((await call(`/v1/agents/${agent}/requests/${request.id}`)).state, "running");
  const ledger = async () => (await f.db.query("select amount, metadata from credit_ledger where tenant=$1 and kind='usage'", ["camelrun-proto-local"])).rows;
  assert.deepEqual(await ledger(), [], "no receipt was posted before the interrupted settlement");

  await f.worker.stop(true);
  await new Promise(resolve => setTimeout(resolve, 300));
  await f.worker.start();
  let completed: any;
  for (let n = 0; n < 100; n++) {
    completed = await call(`/v1/agents/${agent}/requests/${request.id}?wait=1`);
    if (completed.state === "completed") break;
  }
  assert.equal(completed.state, "completed");
  assert.equal(completed.endedAt, finishedAt, "recovery does not move the durable completion time");
  assert.ok(Date.now() - completed.endedAt >= 300, "the observed recovery was later than the actual finish");
  assert.equal(completed.outcome.error, undefined);
  assert.deepEqual(completed.outcome.result.output, ["finished"]);
  assert.equal(Object.hasOwn(completed.outcome.result, "endedAt"), false, "internal billing time is not added to the public result");
  const activeMs = completed.endedAt - completed.began;
  assert.ok(Number.isSafeInteger(activeMs) && activeMs >= 0);
  const charged = await ledger();
  assert.equal(charged.length, 1);
  assert.equal(charged[0].metadata.activeMs, activeMs, "the receipt excludes time after the task finished");
  assert.equal(Number(charged[0].amount), -activeMs * 1000, "$1 per second is charged through the durable finish");

  await Promise.all([
    call(`/v1/agents/${agent}/requests/${request.id}`),
    call(`/v1/agents/${agent}/requests`, request),
    call(`${experimental}/__test/flush-billing`, {}),
  ]);
  assert.deepEqual(await ledger(), charged, "polling, request replay and receipt flushing do not charge twice");
});

test("cancelling a host execution whose acceptance was interrupted still bills its committed work once", { timeout: 90000 }, async t => {
  const f = await startFixture({ vars: { AGENT_PRICE_AGENT_HOUR_USD: "3600" } });
  t.after(() => f.stop());
  const headers = { authorization: `Bearer ${f.token}`, "content-type": "application/json" };
  const call = async (path: string, input?: unknown, status?: number) => {
    const response = await fetch(f.url + path, { headers, method: input === undefined ? "GET" : "POST",
      ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    const body = await response.json() as any;
    if (status !== undefined) assert.equal(response.status, status, JSON.stringify(body));
    else assert.ok(response.ok, `${response.status} ${path}: ${JSON.stringify(body)}`);
    return body;
  };
  const agent = (await call("/v1/agents", { model: "test/echo" })).id;
  const experimental = `/experimental/agents/${agent}`;
  const request = { id: "host_lost_acceptance", method: "execute", params: { code: 'return "committed"' } };
  await call(`${experimental}/__test/crash-next-settlement`, { beforeAcceptance: true });
  await call(`/v1/agents/${agent}/requests`, request, 503);
  const { unacceptedFinishedAt } = await call(`${experimental}/__test/settlement-state`);
  assert.equal(typeof unacceptedFinishedAt, "number", "Pi committed the task before the interrupted acceptance write");
  const before = await call(`/v1/agents/${agent}/requests/${request.id}`);
  assert.equal(before.state, "running");
  const ledger = async () => (await f.db.query("select amount, metadata from credit_ledger where tenant=$1 and kind='usage'", ["camelrun-proto-local"])).rows;
  assert.deepEqual(await ledger(), [], "the unaccepted task has no posted receipt yet");

  await call(`/v1/agents/${agent}/requests`, { id: "cancel_lost_acceptance", method: "abort", params: {} });
  const completed = await call(`/v1/agents/${agent}/requests/${request.id}`);
  assert.equal(completed.state, "completed");
  assert.equal(completed.endedAt, unacceptedFinishedAt);
  assert.deepEqual(completed.outcome.result.output, ["committed"], "cancellation preserves the already completed native result");
  assert.equal(Object.hasOwn(completed.outcome.result, "endedAt"), false);
  const activeMs = unacceptedFinishedAt - before.began;
  assert.ok(Number.isSafeInteger(activeMs) && activeMs >= 0);
  const charged = await ledger();
  assert.equal(charged.length, 1);
  assert.equal(charged[0].metadata.activeMs, activeMs);
  assert.equal(Number(charged[0].amount), -activeMs * 1000);
  const [retry] = await Promise.all([
    call(`/v1/agents/${agent}/requests`, request, 409),
    call(`${experimental}/__test/flush-billing`, {}),
  ]);
  assert.equal(retry.code, "aborted", "a cancelled request cannot be dispatched again");
  assert.deepEqual(await ledger(), charged, "replaying an interrupted admission cannot add or drop its charge");
});
