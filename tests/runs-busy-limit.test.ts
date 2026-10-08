import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { OPERATOR, runtime, until } from "./runtime-server.ts";

// Apart from tests/runs.test.ts: forty stateless runs one at a time, then twenty prompts each restarting an agent's
// process, take a minute and a half with process hosting, which with the rest of runs.test.ts nears the shard's
// per-file limit.

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

test("at a busy limit of 1, the next run starts as soon as one is seen to end: 40 stateless runs, then agent prompts alternating between two agents", { timeout: 120_000 }, async t => {
  const tenants = { tenants: {
    alice: { tokenSha256: sha(OPERATOR), apiKeys: { openrouter: "fixture-model-key" }, maxAgents: 1, maxRunsPerMinute: 10_000, maxAgentCreatesPerMinute: 100 },
  } };
  const r = await runtime(t, () => ({ role: "assistant", content: "done" }), {}, tenants);
  // 40 runs: the race this guards against (about 1 in 14 runs) shows in all but about 5% of runs of the test.
  for (let index = 0; index < 40; index++) {
    const ended = await r.call("/v1/runs", { body: { input: `vote ${index}`, wait: true } });
    // A loaded machine can answer 202 (still running) rather than 200: then it is waited on, as a client would.
    if (ended.status === 202) assert.equal((await r.call(`/v1/runs/${ended.json.id}?wait=25`)).json.status, "completed");
    else assert.equal(ended.status, 200, `run ${index}: ${ended.status} ${ended.text}`);
  }
  // Agent prompts, alternating between two agents: one is seen to end (its request, waited on), then the other's is sent.
  // One agent's process at a time too (maxAgents): the second is made once the first has settled after its creation.
  const agents: string[] = [];
  for (const name of ["one", "two"]) agents.push((await until(async () => { const created = await r.call("/v1/agents", { body: { name } }); return created.status === 201 && created.json; }, `agent ${name}`)).id);
  const prompt = async (agent: string, requestId: string, text: string) => {
    const accepted = await r.call(`/v1/agents/${agent}/prompt`, { body: { text, requestId } });
    assert.equal(accepted.status, 202, `${requestId}: ${accepted.status} ${accepted.text}`);
    let record;
    while ((record = (await r.call(`/v1/agents/${agent}/requests/${requestId}?wait=25`)).json).state !== "completed");
    assert.equal(record.outcome.result?.error, null, JSON.stringify(record));
  };
  // The second agent's process is up once it has run: from then on, each prompt stops the other agent's idle one.
  await prompt(agents[1], "warm-up", "warm up");
  // Fewer than the runs: each restarts its agent's process (tests/busy-release.test.ts has 200 prompts, against a slow release).
  for (let index = 0; index < 20; index++) await prompt(agents[index % 2], `prompt-${index}`, `turn ${index}`);
});
