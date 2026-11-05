import { contractTest, OPERATOR, OTHER_OPERATOR, free, lastUser, toolCall, toolResults, until, sleep, listen, watchEvents, type T } from '../support.ts';
import type { ContractFixture, ModelReply } from '../fixture.ts';

async function useFixture(f: ContractFixture, respond?: ModelReply, _env?: Record<string,string>, _tenants?: object) { if(respond) f.setModel(respond); return f; }

import assert from "node:assert/strict";

import { AgentRuntime } from "../../../clients/typescript.ts";

contractTest("history", "tests/history-pages.test.ts:266", "history comes in pages of whole turns, newest first, from Pi storage wherever the agent runs or not", async (t, f) => {
  const r = await useFixture(f, body => {
    const last = body.messages.at(-1);
    if (last.role === "tool") return { content: `done ${lastUser(body)}` };
    return lastUser(body).startsWith("tool") ? toolCall("codemode", { code: "return 1" }, `call_${body.messages.length}`) : { content: `reply ${lastUser(body)}` };
  }, { AGENT_IDLE_MS: "1000" });
  const session = (await r.call("/v1/agents", { body: {} })).json;
  const agent = session.id as string;
  const prompts = ["one", "tool two", "three", "tool four", "five", "six"];
  for (const text of prompts) assert.equal((await r.prompt(agent, text)).outcome.error, undefined);
  const whole = (await r.call(`/v1/agents/${agent}/history`)).json.messages;
  assert.equal(whole.length, 16);

  const pages = async (limit: number, token?: string) => {
    const seen: any[] = [];
    for (let before: number | null | undefined; before !== null;) {
      const page = await r.call(`/v1/agents/${agent}/history?limit=${limit}${before !== undefined ? `&before=${before}` : ""}`, { token });
      assert.equal(page.status, 200, page.text);
      assert.equal(page.json.total, 16);
      assert.equal(page.json.entries[0].message.role, "user", "a page starts at a turn");
      assert.ok(page.json.entries.length >= Math.min(limit, page.json.entries.at(-1).index + 1));
      seen.unshift(page.json);
      before = page.json.next;
    }
    return seen;
  };
  const check = async () => {
    const byThree = await pages(3);
    assert.deepEqual(byThree.flatMap(page => page.entries.map((entry: any) => entry.index)), whole.map((_: unknown, index: number) => index));
    assert.deepEqual(byThree.flatMap(page => page.entries.map((entry: any) => entry.message)), whole);
    // Turns of 2 and 4 messages alternate: newest first, a page of 3 takes whole turns until it has 3.
    assert.deepEqual(byThree.map(page => page.entries.length), [2, 6, 4, 4]);
    assert.deepEqual((await pages(1)).map(page => page.entries.length), [2, 4, 2, 4, 2, 2]);
  };
  await check();
  // The same once the idle agent has stopped: nothing is indexed, pages are read from Pi storage.
  await until(async () => !(await r.call("/v1/agents")).json.find((entry: any) => entry.id === agent).running, "the idle agent to stop", 20_000);
  await check();

  // The SDK pages the same way, with the agent's own token.
  const client = await new AgentRuntime({ url: r.base, apiKey: OPERATOR }).connectAgent(session, { tools: {} });
  t.after(() => client.close());
  const newest = await client.historyPage({ limit: 3 });
  assert.deepEqual(newest.entries.map(entry => entry.index), [12, 13, 14, 15]);
  assert.deepEqual((await client.historyPage({ before: newest.next!, limit: 3 })).entries.map(entry => entry.index), [8, 9, 10, 11]);

  // A fork holds the history it copied (archived before its base), then its own.
  const fork = (await r.call(`/v1/agents/${agent}/fork`, { body: { key: "pages-fork" } })).json;
  assert.deepEqual((await r.call(`/v1/agents/${fork.id}/history`)).json.messages, whole);
  assert.deepEqual((await r.call(`/v1/agents/${fork.id}/history?limit=1`)).json.entries.map((entry: any) => entry.index), [14, 15]);

  // Another tenant's token gets no page.
  assert.equal((await r.call(`/v1/agents/${agent}/history?limit=3`, { token: OTHER_OPERATOR })).status, 404);

}, {env:{ AGENT_IDLE_MS: "1000" }});

contractTest("history", "tests/history-pages.test.ts:321", "history maxBytes works alone on the API and through the SDK, with validated bounds", async (t, f) => {
  const r = await useFixture(f, () => ({ content: "界".repeat(2000) }));
  const session = (await r.call("/v1/agents", { body: {} })).json;
  for (let turn = 0; turn < 3; turn++) await r.prompt(session.id, `question ${turn}`);
  const whole = (await r.call(`/v1/agents/${session.id}/history`)).json.messages;
  const normal = await r.call(`/v1/agents/${session.id}/history?limit=50`);
  assert.deepEqual(normal.json.entries.map((entry: any) => entry.message), whole);
  const bounded = await r.call(`/v1/agents/${session.id}/history?maxBytes=16384`);
  assert.equal(bounded.status, 200);
  assert.ok(Buffer.byteLength(bounded.text) <= 16_384);
  assert.ok(bounded.json.entries.length < normal.json.entries.length);
  assert.equal(bounded.json.entries.at(-1).index, whole.length - 1);
  const client = await new AgentRuntime({ url: r.base, apiKey: OPERATOR }).connectAgent(session, { tools: {} });
  t.after(() => client.close());
  assert.deepEqual(await client.historyPage({ maxBytes: 16_384 }), bounded.json);
  const older = await client.historyPage({ maxBytes: 16_384, before: bounded.json.next });
  assert.deepEqual([...older.entries, ...bounded.json.entries].map(entry => entry.message), whole);
  for (const value of ["0", "16383", "4000001", "16384.5", "NaN", "Infinity", ""]) {
    const invalid = await r.call(`/v1/agents/${session.id}/history?maxBytes=${value}`);
    assert.equal(invalid.status, 400, value);
    await assert.rejects(client.historyPage({ maxBytes: Number(value) }), /maxBytes/);
  }
  assert.equal((await r.call(`/v1/agents/${session.id}/history?maxBytes=4000000`)).status, 200);

});

contractTest("history", "tests/history-pages.test.ts:346", "history after pages forward on the API and through the SDK; after with before is a 400", async (t, f) => {
  const r = await useFixture(f, () => ({ content: "reply" }));
  const session = (await r.call("/v1/agents", { body: {} })).json;
  const agent = session.id as string;
  for (const text of ["one", "two"]) await r.prompt(agent, text);
  const whole = (await r.call(`/v1/agents/${agent}/history`)).json.messages;
  assert.equal(whole.length, 4);
  const seen: any[] = [];
  for (let after = 0;;) {
    const page = await r.call(`/v1/agents/${agent}/history?limit=1&after=${after}`);
    assert.equal(page.status, 200, page.text);
    assert.equal(page.json.total, 4);
    if (page.json.entries.length) assert.equal(page.json.entries[0].message.role, "user", "a page starts at a turn");
    seen.push(...page.json.entries);
    if (page.json.nextAfter === page.json.total) break;
    assert.ok(page.json.nextAfter > after);
    after = page.json.nextAfter;
  }
  assert.deepEqual(seen.map(entry => entry.index), [0, 1, 2, 3]);
  assert.deepEqual(seen.map(entry => entry.message), whole);
  const firstPage = await r.call(`/v1/agents/${agent}/history?after=0&limit=1`);
  assert.deepEqual(firstPage.json.entries.map((entry: any) => entry.index), [0, 1]);
  assert.deepEqual([firstPage.json.next, firstPage.json.nextAfter, firstPage.json.total], [null, 2, 4]);
  assert.equal(firstPage.json.truncated, undefined);
  const caught = await r.call(`/v1/agents/${agent}/history?after=4`);
  assert.equal(caught.status, 200);
  assert.equal(caught.json.nextAfter, 4);
  assert.deepEqual(caught.json.entries, []);
  const past = await r.call(`/v1/agents/${agent}/history?after=9`);
  assert.equal(past.status, 200);
  assert.deepEqual(past.json.entries, []);
  assert.equal(past.json.total, 4);
  assert.equal(past.json.nextAfter, 4);
  assert.equal(past.json.truncated, true);
  assert.equal((await r.call(`/v1/agents/${agent}/history?after=4&maxBytes=16384`)).status, 200, "a byte bound alone pages too");

  const both = await r.call(`/v1/agents/${agent}/history?after=0&before=2`);
  assert.equal(both.status, 400, both.text);
  assert.match(both.json.error, /after or before/);
  for (const value of ["-1", "1.5", "NaN", "Infinity"])
    assert.equal((await r.call(`/v1/agents/${agent}/history?after=${value}`)).status, 400, value);

  const client = await new AgentRuntime({ url: r.base, apiKey: OPERATOR }).connectAgent(session, { tools: {} });
  t.after(() => client.close());
  assert.deepEqual((await client.historyPage({ after: 2, limit: 1 })).entries.map(entry => entry.index), [2, 3]);
  assert.deepEqual(await client.historyPage({ after: 0, limit: 1 }), (await r.call(`/v1/agents/${agent}/history?after=0&limit=1`)).json);
  await assert.rejects(client.historyPage({ after: 0, before: 2 }), /after or before/);
  // The backward page is unchanged: its next is still the older page's before.
  const newest = await client.historyPage({ limit: 1 });
  assert.equal(newest.next, 2);
  assert.equal(newest.nextAfter, undefined);
  assert.deepEqual((await client.historyPage({ limit: 1, before: newest.next! })).entries.map(entry => entry.index), [0, 1]);

});
