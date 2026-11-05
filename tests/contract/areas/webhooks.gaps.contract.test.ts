import {portedTest} from '../ported.ts';
const test = portedTest("webhooks", "tests/webhooks.test.ts");
import assert from 'node:assert/strict';
import {listen,runtime,sleep,until} from '../support.ts';

const LOCAL = { AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32", AGENT_USAGE_WEBHOOK_RETRY_MS: "100" };

async function receiver(t: { after(fn: () => void): void }, status = 204) {
  const received: { headers: Record<string, any>; body: string; json: any }[] = [];
  const url = await listen(t, async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    received.push({ headers: req.headers, body, json: JSON.parse(body) });
    res.writeHead(status).end();
  });
  const find = (type: string, requestId?: string) => received.find(entry => entry.json.type === type && (requestId === undefined || entry.json.data?.requestId === requestId))?.json;
  return { url, received, find };
}

test("a run whose event could not be written when it ended has it written with the agent's next load or run, once", async t => {
  const hook = await receiver(t);
  const r = await runtime(t, () => ({ role: "assistant", content: "done" }), { ...LOCAL, AGENT_IDLE_MS: "1000" });
  await r.call("/v1/webhooks", { body: { url: hook.url, events: ["run.completed"] } });
  const agent = (await r.call("/v1/agents", { body: {} })).json.id as string;
  const unloaded = () => until(async () => !(await r.call("/v1/agents")).json.find((entry: any) => entry.id === agent).running, "the idle agent to unload");

  // Fail the run-event write specifically; model billing also uses this outbox transactionally.
  await r.setRejectRunEvents(true);
  const lost = await r.prompt(agent, "first");
  await sleep(300);
  await r.setRejectRunEvents(false);
  assert.equal(hook.find("run.completed", lost.id), undefined);
  await unloaded();

  const next = await r.prompt(agent, "second");
  await until(() => hook.find("run.completed", lost.id) && hook.find("run.completed", next.id), "both runs' events");
  assert.equal(hook.find("run.completed", lost.id).data.replyIndex, 1);
  await unloaded();
  const third = await r.prompt(agent, "third");
  await until(() => hook.find("run.completed", third.id), "the third run's event");
  await sleep(500);
  assert.equal(hook.received.filter(entry => entry.json.data.requestId === lost.id).length, 1, "written once, not at every load");
});

test("in a rolling deploy, nodes of the previous release see only usage webhook deliveries, and their usage webhook changes take effect", async t => {
  const hook = await receiver(t, 500);
  const legacy = await receiver(t, 500);
  const moved = await receiver(t, 500);
  // Refused deliveries wait an hour, where the test can read them.
  const r = await runtime(t, () => ({ role: "assistant", content: "hi", usage: { prompt_tokens: 10, completion_tokens: 1 } }), { ...LOCAL, AGENT_USAGE_WEBHOOK_RETRY_MS: "3600000" });
  await r.call("/v1/webhooks", { body: { url: hook.url, events: ["run.completed", "usage.recorded"] } });
  await r.call("/v1/usage-webhook", { method: "PUT", body: { url: legacy.url } });
  // A node of the previous release moves the usage webhook, as its PUT did: in usage_webhooks alone.
  await r.updateLegacyUsageWebhook(moved.url);
  const agent = (await r.call("/v1/agents", { body: {} })).json.id as string;
  const done = await r.prompt(agent, "Hi");
  await r.call("/v1/usage");
  await until(() => moved.received.length && hook.find("run.completed", done.id) && hook.find("usage.recorded", done.id), "every delivery attempted");
  assert.equal(legacy.received.length, 0, "sent where the usage webhook now points");
  // The previous release's outbox, which its nodes send from, holds usage webhook bodies alone.
  // Legacy private outbox row shape is retained in the original suite.
});
