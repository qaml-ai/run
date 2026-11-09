import assert from "node:assert/strict";
import { contractTest, createContractFixture, OTHER_OPERATOR, toolCall, toolResults, until } from "../support.ts";
import { fakeBoatServer } from "../../fake-boat.ts";

// Forked computers on both backends, through a bring-your-own Boat connection against a fake Boat API whose sandboxes
// are real directories (tests/fake-boat.ts). Node reaches it with AGENT_BOAT_API_URL; the Workers fixture maps that to
// TEST_COMPUTER_ENDPOINT. Cloudflare's native computer forks are covered by the Workers integration suite (Docker).
const SOURCE = "tests/computers-fork.test.ts";
const text = (message: any) => typeof message.content === "string" ? message.content : (message.content ?? []).map((part: any) => part.text ?? "").join("");
const systemText = (body: any) => body.messages.filter((m: any) => m.role === "system" || m.role === "developer").map(text).join("\n");
const firstUser = (body: any) => text(body.messages.find((m: any) => m.role === "user") ?? { content: "" });
/** The tool results of this turn: after the latest user message (an agent's earlier runs are in its history). */
const turnResults = (body: any) => toolResults({ messages: body.messages.slice(body.messages.map((m: any) => m.role).lastIndexOf("user") + 1) });
const toolCalls = (...calls: [string, unknown, string][]) => ({ role: "assistant", tool_calls: calls.map(([name, args, id], index) => ({ index, id, type: "function", function: { name, arguments: JSON.stringify(args) } })) });
const boatEnv = (url: string) => ({ AGENT_BOAT_API_URL: url, AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32" });
const connect = (r: any, agent: string, provider = "boat", forkable = provider === "boat") => r.call("/v1/computers", { body: { agent, provider, credentials: { apiKey: "byo-fixture-key" }, leaseSeconds: 600, dailySeconds: 3600, ...forkable ? { forkable: true } : {} } });

contractTest("computers", SOURCE, "delegate with computer fork: each child starts from the parent's files, writes stay apart, and one snapshot serves the call", async t => {
  const boat = await fakeBoatServer();
  t.after(() => boat.close());
  const r = await createContractFixture(t, { env: boatEnv(boat.url), respond: body => {
    const results = turnResults(body), user = firstUser(body);
    if (systemText(body).includes("FORK_PARENT")) {
      if (results.length === 0) return toolCall("computer_start", {}, "start");
      if (results.length === 1) return toolCall("computer_exec", { command: "echo parent-v1 > notes.txt" }, "write");
      if (results.length === 2) return toolCalls(["delegate", { instructions: "FORK_CHILD", task: "A", computer: "fork" }, "fork_a"], ["delegate", { instructions: "FORK_CHILD", task: "B", computer: "fork" }, "fork_b"]);
      if (results.length === 4) return toolCall("computer_exec", { command: "cat notes.txt; ls" }, "check");
      // The two children's answers, then what the parent's own disk holds after them.
      return { role: "assistant", content: results.slice(2).join("\n---\n") };
    }
    if (user.includes("FORK_CHILD")) {
      const task = user.includes("Your task:\nA") ? "A" : "B";
      if (results.length === 0) return toolCall("computer_start", {}, "child_start");
      if (results.length === 1) return toolCall("computer_exec", { command: `cat notes.txt; ls; echo ${task} > mine-${task}.txt; echo changed-${task} > notes.txt` }, "child_work");
      return { role: "assistant", content: `child ${task} saw: ${results[1]}` };
    }
    return { role: "assistant", content: "ok" };
  } });
  const parent = (await r.call("/v1/agents", { body: { systemPrompt: "FORK_PARENT", builtins: ["delegate"], delegate: { instructions: true } } })).json.id;
  assert.equal((await connect(r, parent)).status, 201);
  const run = await r.prompt(parent, "Fork your computer for two tasks");
  assert.equal(run.status, "completed", JSON.stringify(run.outcome));
  const calls = run.outcome.result.toolCalls.filter((call: any) => call.agentId);
  assert.equal(calls.length, 2);
  const [childA, childB, check] = run.outcome.result.reply.split("\n---\n");
  // Each child read the parent's file, and never its sibling's.
  assert.match(childA, /child A saw: .*parent-v1/s);
  assert.doesNotMatch(childA, /mine-B|changed-B/);
  assert.match(childB, /child B saw: .*parent-v1/s);
  assert.doesNotMatch(childB, /mine-A|changed-A/);
  // The parent's disk is untouched by its forks.
  assert.match(check, /parent-v1/);
  assert.doesNotMatch(check, /changed-|mine-/);
  // One snapshot for the call's two children, each child's own connection forked from it.
  assert.equal(boat.state.snapshots.length, 1);
  const statuses = await Promise.all(calls.map((call: any) => r.call(`/v1/agents/${call.agentId}/computer`)));
  const parentConnection = (await r.call(`/v1/agents/${parent}/computer`)).json.connection;
  for (const status of statuses) {
    assert.equal(status.status, 200, status.text);
    assert.notEqual(status.json.connection.id, parentConnection.id);
    assert.equal(status.json.connection.forkedFrom.agent, parent);
    assert.equal(status.json.connection.forkedFrom.provider, "boat");
  }
  assert.equal(statuses[0].json.connection.forkedFrom.snapshot, statuses[1].json.connection.forkedFrom.snapshot);
  assert.equal(boat.state.sandboxes.size >= 1, true);
  // A delegate child that answered has its session stopped.
  for (const call of calls) await until(async () => (await r.call(`/v1/agents/${call.agentId}/computer`)).json.session?.state === "closed", "child session released");
  for (const call of calls) assert.equal((await r.call(`/v1/agents/${call.agentId}`, { method: "DELETE" })).status, 200);
});

contractTest("computers", SOURCE, "POST /v1/computers/{id}/fork copies a running computer into other agents with one snapshot", async t => {
  const boat = await fakeBoatServer();
  t.after(() => boat.close());
  const r = await createContractFixture(t, { env: boatEnv(boat.url), respond: () => ({ role: "assistant", content: "ok" }) });
  const agent = async (name: string) => (await r.call("/v1/agents", { body: { name } })).json.id as string;
  const source = await agent("source"), first = await agent("first"), second = await agent("second"), busy = await agent("busy");
  const connection = (await connect(r, source)).json;
  const early = await r.call(`/v1/computers/${connection.id}/fork`, { body: { agents: [first] } });
  assert.equal(early.status, 409, "no session yet");
  assert.equal(early.json.code, "NO_SESSION");
  assert.equal((await r.call(`/v1/agents/${source}/computer/fork`, { body: { agents: [first] } })).json.code, "NO_SESSION");
  // The agent's own tools start its session and write a file.
  const run = await createRun(r, source);
  assert.equal(run.status, "completed");
  assert.equal((await connect(r, busy)).status, 201);
  for (const [body, code] of [[{ agents: [busy] }, 409], [{ agents: ["agt_missing"] }, 404], [{ agents: [source] }, 400], [{ count: 2 }, 400]] as const)
    assert.equal((await r.call(`/v1/computers/${connection.id}/fork`, { body })).status, code, JSON.stringify(body));
  assert.equal((await r.call(`/v1/computers/${connection.id}/fork`, { body: { agents: [first] }, token: OTHER_OPERATOR })).status, 404);
  const forked = await r.call(`/v1/computers/${connection.id}/fork`, { body: { agents: [first, second] } });
  assert.equal(forked.status, 201, forked.text);
  assert.equal(forked.json.forks.length, 2);
  assert.equal(boat.state.snapshots.length, 1);
  for (const fork of forked.json.forks) {
    assert.equal(fork.forkedFrom.snapshot, forked.json.snapshot.id);
    assert.equal(fork.forkedFrom.connection, connection.id);
    assert.equal(fork.provider, "boat");
    assert.equal(fork.session, null);
  }
  assert.equal((await r.call(`/v1/computers/${connection.id}/fork`, { body: { agents: [first] } })).status, 409, "already connected");
  // A fork's first session starts from the source's disk.
  r.setModel((body: any) => {
    const results = turnResults(body);
    if (results.length === 0) return toolCall("computer_start", {}, "start");
    if (results.length === 1) return toolCall("computer_exec", { command: "cat notes.txt" }, "read");
    return { role: "assistant", content: `read: ${results[1]}` };
  });
  assert.match((await r.prompt(first, "Read the notes")).outcome.result.reply, /from-source/);
  for (const id of [first, second]) assert.equal((await r.call(`/v1/agents/${id}`, { method: "DELETE" })).status, 200);
});

// The source agent writes a file on its computer in one run: start, then exec.
async function createRun(r: any, agent: string) {
  r.setModel((body: any) => {
    const results = turnResults(body);
    if (results.length === 0) return toolCall("computer_start", {}, "start");
    if (results.length === 1) return toolCall("computer_exec", { command: "echo from-source > notes.txt" }, "write");
    return { role: "assistant", content: "written" };
  });
  return r.prompt(agent, "Write the notes");
}

contractTest("computers", SOURCE, "computer fork is refused where the provider cannot copy a disk, and computer none gives a child no computer", async t => {
  const boat = await fakeBoatServer();
  t.after(() => boat.close());
  let asked = "fork";
  const r = await createContractFixture(t, { env: boatEnv(boat.url), respond: body => {
    if (!systemText(body).includes("FORK_PARENT")) return { role: "assistant", content: "child done" };
    return turnResults(body).length ? { role: "assistant", content: `parent saw: ${turnResults(body)[0]}` } : toolCall("delegate", { instructions: "FORK_CHILD", task: "work", computer: asked }, "child");
  } });
  const parent = (await r.call("/v1/agents", { body: { systemPrompt: "FORK_PARENT", builtins: ["delegate"], delegate: { instructions: true } } })).json.id;
  const other = (await r.call("/v1/agents", { body: { name: "other" } })).json.id;
  const e2b = await connect(r, parent, "e2b");
  assert.equal(e2b.status, 201, e2b.text);
  const refused = await r.call(`/v1/computers/${e2b.json.id}/fork`, { body: { agents: [other] } });
  assert.equal(refused.status, 409);
  assert.equal(refused.json.code, "FORK_UNSUPPORTED");
  // An own-key Boat connection forks only when made forkable: its machines then take Boat's snapshots.
  const plain = (await r.call("/v1/agents", { body: { name: "plain" } })).json.id;
  const unforkable = await connect(r, plain, "boat", false);
  assert.equal(unforkable.json.forkable, false);
  const notForkable = await r.call(`/v1/computers/${unforkable.json.id}/fork`, { body: { agents: [other] } });
  assert.equal(notForkable.status, 409);
  assert.equal(notForkable.json.code, "FORK_UNSUPPORTED");
  const run = await r.prompt(parent, "Fork for a task");
  assert.match(run.outcome.result.reply ?? JSON.stringify(run.outcome), /cannot be forked/);
  assert.ok(!run.outcome.result.toolCalls.some((call: any) => call.agentId), "nothing was made");
  asked = "none";
  const none = await r.prompt(parent, "A task with no computer");
  const child = none.outcome.result.toolCalls.find((call: any) => call.agentId)?.agentId;
  assert.ok(child);
  assert.equal((await r.call(`/v1/agents/${child}/computer`)).status, 404);
  assert.equal(boat.state.snapshots.length, 0);
});

for (const explicit of [false, true]) contractTest("computers", SOURCE, `shared child uses the parent's session concurrently and cannot control it (${explicit ? 'share' : 'default'})`, async t => {
  const boat = await fakeBoatServer();
  t.after(() => boat.close());
  let childResult = '';
  const r = await createContractFixture(t, { env: boatEnv(boat.url), respond: body => {
    const results = turnResults(body);
    if (systemText(body).includes('SHARE_PARENT')) {
      if (!results.length) return toolCall('computer_start', {}, 'start');
      if (results.length === 1) return toolCall('computer_exec', { command: 'echo parent > shared.txt' }, 'write');
      if (results.length === 2) return toolCall('spawn_agent', { instructions: 'SHARE_CHILD', task: 'Read shared.txt and signal completion', ...(explicit ? { computer: 'share' } : {}) }, 'spawn');
      if (results.length === 3) return toolCall('computer_exec', { command: 'echo ready > parent-ready; for i in $(seq 1 100); do test -f child-done && break; sleep 0.1; done; cat child-done', timeoutSeconds: 30 }, 'concurrent');
      return { role: 'assistant', content: results[3] };
    }
    if (firstUser(body).includes('SHARE_CHILD')) {
      if (!results.length) return toolCall('computer_stop', {}, 'stop');
      if (results.length === 1) return toolCall('computer_start', {}, 'start');
      if (results.length === 2) return toolCall('computer_exec', { command: 'for i in $(seq 1 100); do test -f parent-ready && break; sleep 0.1; done; cat shared.txt; echo child > child-done', timeoutSeconds: 30 }, 'read');
      childResult = results.join('\n');
      return { role: 'assistant', content: childResult };
    }
    return { role: 'assistant', content: 'ok' };
  } });
  const parent = (await r.call('/v1/agents', { body: { systemPrompt: 'SHARE_PARENT', builtins: ['agents'], delegate: { instructions: true } } })).json.id;
  assert.equal((await connect(r, parent)).status, 201);
  const run = await r.prompt(parent, 'Share the computer');
  assert.equal(run.status, 'completed', JSON.stringify(run.outcome));
  assert.match(run.outcome.result.reply, /child/);
  await until(async () => !!childResult, 'shared child finished');
  assert.match(childResult, /belongs to your parent agent/);
  assert.equal((childResult.match(/belongs to your parent agent/g) ?? []).length, 2);
  assert.match(childResult, /parent/);
  const child = run.outcome.result.toolCalls.find((call: any) => call.agentId)?.agentId;
  assert.ok(child);
  const before = (await r.call(`/v1/agents/${parent}/computer`)).json;
  const shared = (await r.call(`/v1/agents/${child}/computer`)).json;
  assert.equal(shared.connection.id, before.connection.id);
  assert.equal(shared.session.id, before.session.id);
  assert.equal(boat.state.creates, 1);
  assert.equal((await r.call(`/v1/agents/${child}`, { method: 'DELETE' })).status, 200);
  assert.equal((await r.call(`/v1/agents/${parent}/computer`)).json.session.state, 'active');
});

for (const connected of [false, true]) contractTest('computers', SOURCE, `code-mode delegate defaults to ${connected ? 'sharing' : 'no attachment'}`, async t => {
  const boat = await fakeBoatServer();
  t.after(() => boat.close());
  const r = await createContractFixture(t, { env: boatEnv(boat.url), respond: body => {
    const results = turnResults(body);
    if (firstUser(body).includes('CODE_SHARE_CHILD')) {
      if (!connected) return { role: 'assistant', content: 'no attachment' };
      return results.length ? { role: 'assistant', content: results[0] } : toolCall('computer_exec', { command: 'cat shared.txt' }, 'read');
    }
    if (connected && !results.length) return toolCall('computer_start', {}, 'start');
    if (connected && results.length === 1) return toolCall('computer_exec', { command: 'echo shared-content > shared.txt' }, 'write');
    if (results.length === (connected ? 2 : 0)) return toolCall('codemode', { code: 'return await tools.delegate({ instructions: "CODE_SHARE_CHILD", task: "Read the shared file" });' }, 'delegate');
    return { role: 'assistant', content: results.at(-1) };
  } });
  const parent = (await r.call('/v1/agents', { body: { builtins: ['delegate'], delegate: { instructions: true } } })).json.id;
  if (connected) assert.equal((await connect(r, parent)).status, 201);
  const run = await r.prompt(parent, 'Delegate in code mode');
  assert.equal(run.status, 'completed', JSON.stringify(run.outcome));
  assert.match(run.outcome.result.reply, connected ? /shared-content/ : /no attachment/);
  const child = run.outcome.result.toolCalls.find((call: any) => call.agentId)?.agentId;
  assert.ok(child);
  const status = await r.call(`/v1/agents/${child}/computer`);
  assert.equal(status.status, connected ? 200 : 404);
  if (connected) assert.equal(status.json.connection.agent, parent);
});

for (const override of [false, true]) contractTest('computers', SOURCE, `tree cap: tenant default, sharing and released slots (${override ? 'agent override' : 'tenant default'})`, async t => {
  const boat = await fakeBoatServer();
  t.after(() => boat.close());
  const r = await createContractFixture(t, { env: boatEnv(boat.url), respond: body => {
    const results = turnResults(body);
    if (firstUser(body).includes('CAP_FRESH')) return results.length ? { role: 'assistant', content: results[0] } : toolCall('computer_start', {}, 'start');
    if (firstUser(body).includes('CAP_SHARE')) return results.length ? { role: 'assistant', content: results[0] } : toolCall('computer_exec', { command: 'echo shared-ok' }, 'exec');
    if (!results.length) return toolCall('computer_start', {}, 'start');
    if (results.length === 1) return toolCall('delegate', { instructions: 'CAP_FRESH', task: 'Start your fresh computer', computer: 'fresh' }, 'fresh1');
    if (results.length === 2) return toolCall('delegate', { instructions: 'CAP_SHARE', task: 'Use the parent computer', computer: 'share' }, 'share');
    if (results.length === 3) return toolCall('delegate', { instructions: 'CAP_FRESH', task: 'Start after the previous child finished', computer: 'fresh' }, 'fresh2');
    return { role: 'assistant', content: results.slice(1).join('\n---\n') };
  } });
  const { token } = await r.seedTenant('cap-test', { config: { computerLimit: 1 } });
  const call = (path: string, args: any = {}) => r.call(path, { ...args, token });
  const definition = await call('/v1/definitions', { body: { name: 'Capped', builtins: ['delegate'], delegate: { instructions: true }, ...(override ? { computerLimit: 1 } : {}) } });
  assert.equal(definition.status, 201, definition.text);
  const made = await call('/v1/agents', { body: { definition: definition.json.id, ...(override ? { computerLimit: 2 } : {}) } });
  assert.equal(made.status, 201, made.text);
  assert.equal((await connect({ call }, made.json.id)).status, 201);
  const run = await r.prompt(made.json.id, 'Check capacity', token);
  assert.equal(run.status, 'completed', JSON.stringify(run.outcome));
  assert.match(run.outcome.result.reply, /shared-ok/);
  if (override) {
    assert.doesNotMatch(run.outcome.result.reply, /reached its concurrent computer limit/);
    assert.equal(boat.state.creates, 3, 'both sequential children start after the prior child releases its slot');
  } else {
    assert.ok(JSON.parse(run.outcome.result.reply.split('\n---\n')[0]).text.includes('This agent tree already runs its limit of machines. Use computer "share" for new sub-agents, or wait until one finishes.'));
    assert.equal(boat.state.creates, 1, 'refused children start no extra machines');
  }
  for (const value of [0, 65, 1.5]) assert.equal((await call('/v1/agents', { body: { computerLimit: value } })).status, 400);
});

contractTest('computers', SOURCE, 'a finished background fork worker retains its machine and files for another message', async t => {
  const boat = await fakeBoatServer(); t.after(() => boat.close());
  let spawned = false, readBack = '';
  const r = await createContractFixture(t, { env: boatEnv(boat.url), respond: body => {
    const results = turnResults(body);
    if (systemText(body).includes('PERSIST_PARENT')) {
      if (body.messages.some((message: any) => message.role === 'user' && text(message) === 'REUSE_WORKER'))
        return results.length ? { role: 'assistant', content: 'sent' } : toolCall('send_message', { to: 'worker', text: 'READ_AGAIN' }, 'reuse');
      if (spawned) return { role: 'assistant', content: 'started' };
      if (!results.length) return toolCall('computer_start', {}, 'start');
      if (results.length === 1) return toolCall('computer_exec', { command: 'echo parent > parent.txt' }, 'write');
      if (results.length === 2) { spawned = true; return toolCall('spawn_agent', { name: 'worker', instructions: 'PERSIST_WORKER', task: 'Save your work', computer: 'fork' }, 'spawn'); }
      return { role: 'assistant', content: 'started' };
    }
    if (JSON.stringify(body.messages).includes('READ_AGAIN')) {
      if (!results.length) return toolCall('computer_exec', { command: 'cat worker.txt' }, 'read');
      readBack = results[0];
      return { role: 'assistant', content: readBack };
    }
    if (!results.length) return toolCall('computer_start', {}, 'start');
    if (results.length === 1) return toolCall('computer_exec', { command: 'echo saved-work > worker.txt' }, 'write');
    return { role: 'assistant', content: 'saved' };
  } });
  const parent = (await r.call('/v1/agents', { body: { systemPrompt: 'PERSIST_PARENT', builtins: ['agents'], delegate: { instructions: true } } })).json.id;
  await connect(r, parent);
  const run = await r.prompt(parent, 'Start a worker');
  const child = run.outcome.result.toolCalls.find((call: any) => call.agentId)?.agentId;
  assert.ok(child);
  await until(async () => (await r.call(`/v1/agents/${parent}/children`)).json.children.some((entry: any) => entry.status === 'completed'), 'background worker completion');
  assert.equal((await r.call(`/v1/agents/${child}/computer`)).json.session.state, 'active');
  await r.prompt(parent, 'REUSE_WORKER');
  await until(async () => readBack.includes('saved-work'), 'worker reads its saved files after send_message');
  assert.match(readBack, /saved-work/);
});
