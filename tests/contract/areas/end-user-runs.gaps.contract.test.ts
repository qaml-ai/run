import {portedTest} from '../ported.ts';
const test = portedTest("credits", "tests/end-user-runs.test.ts");
import assert from 'node:assert/strict';
import {runtime,sleep,until} from '../support.ts';

const AT_COST = { AGENT_OPENROUTER_CREDIT_MULTIPLIER: "1" };

const settings = (r: Awaited<ReturnType<typeof runtime>>, body: Record<string, unknown>) => r.call("/v1/end-user-settings", { method: "PUT", body: { enabled: true, ...body } });

const grant = (r: Awaited<ReturnType<typeof runtime>>, user: string, amount: number, key: string) =>
  r.call(`/v1/end-users/${encodeURIComponent(user)}/entries`, { body: { kind: amount > 0 ? "grant" : "adjustment", amount, key } });

const usage = async (r: Awaited<ReturnType<typeof runtime>>, user: string) =>
  (await r.call(`/v1/end-users/${encodeURIComponent(user)}/ledger?limit=200`)).json.entries.filter((entry: any) => entry.kind === "usage");

const settled = (r: Awaited<ReturnType<typeof runtime>>, path: string) => until(async () => {
  const record = (await r.call(path)).json;
  return record.state === "completed" && record;
}, "the run to end", 30_000);

test("a run's own bucket is what its start is checked against, and the runs after it that name none (the runtime's own too) inherit it, never \"default\"", async t => {
  // camel-bots' bot agents: no bucket of their own ("default", $0 under "*": 0), each prompt naming the bot's. The
  // queued run's start once checked the agent's bucket, and every such run failed before it began.
  const r = await runtime(t, (_body: any) => ({ content: "done", usage: { prompt_tokens: 10, completion_tokens: 10, cost: 0.01 } }), { ...AT_COST, AGENT_MODEL: "openai/gpt-4.1" });
  await settings(r, { allowances: { "bot:*": 1_000_000, "*": 0 } });
  const { id } = (await r.call("/v1/agents", { body: { subject: "owner" } })).json;
  const accepted = await r.call(`/v1/agents/${id}/prompt`, { body: { text: "hi", requestId: "own-bucket", bucket: "bot:7", spendLimit: { usd: 0.25 } } });
  assert.equal(accepted.status, 202, accepted.text);
  const record = await settled(r, `/v1/agents/${id}/requests/own-bucket`);
  assert.equal(record.outcome.error, undefined, JSON.stringify(record.outcome));
  assert.equal(record.outcome.result.reply, "done");
  assert.deepEqual((await usage(r, "owner")).map((entry: any) => entry.bucket), ["bot:7"]);
  // A run that names none spends from the bucket the agent's runs were last given, never "default" (no allowance).
  await r.prompt(id, "hi");
  // So does a run the runtime starts for it: a schedule's wake-up.
  const now = Date.now();
  const schedule = await r.call(`/v1/agents/${id}/schedules`, {body:{text:"wake up",inSeconds:3600}});
  assert.equal(schedule.status,201,schedule.text);
  await r.setScheduleDueAt(id,schedule.json.id,now-10);
  await until(async () => (await usage(r, "owner")).length === 3, "the schedule's run to spend");
  assert.deepEqual((await usage(r, "owner")).map((entry: any) => entry.bucket), ["bot:7", "bot:7", "bot:7"]);
  // An agent no run named a bucket for still has the default's (no allowance): refused at accept, saying which.
  const other = (await r.call("/v1/agents", { body: { subject: "owner" } })).json.id;
  const refused = await r.call(`/v1/agents/${other}/prompt`, { body: { text: "hi" } });
  assert.deepEqual([refused.status, refused.json.code, refused.json.bucket], [402, "END_USER_CREDIT", "default"], refused.text);
});

test("concurrent replies for one end user share their credit: all admitted replies settle in full", async t => {
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const r = await runtime(t, () => ({ content: "ok", wait: barrier, usage: { prompt_tokens: 10, completion_tokens: 10, cost: 0.01 } }), { ...AT_COST, AGENT_MODEL: "openai/gpt-4.1" });
  await settings(r, {});
  await grant(r, "shared", 1, "pay");
  const agents: string[] = [];
  for (let index = 0; index < 4; index++) {
    const made = await r.call("/v1/agents", { body: { subject: "shared" } });
    assert.equal(made.status, 201, made.text);
    agents.push(made.json.id);
  }
  const accepted = await Promise.all(agents.map(agent => r.call(`/v1/agents/${agent}/prompt`, { body: { text: "go" } })));
  assert.ok(accepted.every(answer => answer.status === 202), accepted.map(answer => answer.text).join("\n"));
  await until(() => r.model.bodies.length === 4, "all admitted calls to reach the provider");
  release();
  await Promise.all(agents.map((agent, index) => settled(r, `/v1/agents/${agent}/requests/${accepted[index].json.id}`)));
  const person = (await r.call("/v1/end-users/shared")).json;
  assert.deepEqual([person.balance, person.held], [-39_999, 0]);
});
