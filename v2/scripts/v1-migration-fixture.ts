import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import { Type } from "typebox";
import { AgentRuntime, nodeListener, tool, type ToolContext } from "../../clients/node.ts";
import { serveTools } from "../../clients/server.ts";
import { fenceV1Agent, publishV2AgentRoute, unfenceV1Agent } from "../../src/agent-v2-cutover.ts";
import { listen, OPERATOR, OTHER_OPERATOR, runtime, until } from "../../tests/runtime-server.ts";
import { CamelRun, parseSSE } from "../sdk/src/index.ts";
import { migrateHistory } from "./migrate-history.ts";
import { migrateVolume } from "./migrate-volume.ts";
import { stageAgent } from "./stage-agent.ts";

export async function rehearseSignedTools(t: TestContext, workerUrl: string, adminKey: string) {
  const { tenantId, apiKey } = await CamelRun.createTenant({ baseUrl: workerUrl, adminKey, name: "Signed tools", initialCreditsUsd: 10 });
  const target = new CamelRun({ baseUrl: workerUrl, apiKey });
  t.after(() => target.close());
  const audience = "camel-bots:canary:bot";
  const calls: ToolContext[] = [];
  const formCalls: ToolContext[] = [];
  const echo = tool({
    description: "Echo the fixture", input: Type.Object({ text: Type.String() }),
    async execute(args, context) {
      assert.deepEqual(args, { text: "hello" });
      calls.push(context);
      return "verified tool response";
    },
  });
  const url = await listen(t, nodeListener(serveTools({
    echo,
    guarded: { ...echo, needsApproval: args => args.text === "hello" },
    restricted: echo,
    settings: tool({
      description: "Configure a fixture", input: Type.Object({}), needsApproval: true,
      async execute(_args, context) {
        formCalls.push(context);
        assert.ok(context.identity?.approval);
        const form = await context.ask("Pick a bot name", {
          type: "object", properties: { name: { type: "string" } }, required: ["name"],
        });
        const done = form && await context.requireUrl("https://bots.camelai.com/connect/fixture", "Finish setup");
        return done ? `Configured ${form.name}` : "Skipped settings";
      },
    }),
  }, { runtime: `${workerUrl}/v2`, tenant: tenantId, audience, metadata: false })));
  const toolIdentity = { subject: "owner", context: { bot: "canary", agent: "default", key: "test" } };
  const mcp = { name: "bot", url, audience, allowTools: ["echo", "guarded", "settings"], auth: { type: "runtime" as const } };
  const agent = await target.agents.upsert("tool-canary", { model: "mock/default", toolIdentity, mcpServers: [mcp] });
  const run = await agent.run('Call the signed tool [CALL:bot__echo {"text":"hello"}]');
  assert.match(run.text, /verified tool response/);
  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.equal(call.identity?.agent, agent.id);
  assert.equal(call.identity?.tenant, tenantId);
  assert.equal(call.identity?.subject, toolIdentity.subject);
  assert.deepEqual(call.identity?.context, toolIdentity.context);
  assert.equal(call.identity?.requestId, run.id);
  assert.equal(call.identity?.toolCallId, call.toolCallId);
  assert.deepEqual(JSON.parse(call.idempotencyKey), [agent.id, run.id, call.toolCallId]);
  const restricted = await agent.run('Call the restricted tool [CALL:bot__restricted {}]');
  assert.equal(restricted.toolCalls.some((tool) => tool.ok), false);

  const wrongAudience = await target.agents.upsert("wrong-audience", { model: "mock/default", toolIdentity, mcpServers: [{ ...mcp, audience: "other" }] });
  await assert.rejects(wrongAudience.run("Start a run"), /another server/);
  const foreign = await CamelRun.createTenant({ baseUrl: workerUrl, adminKey, name: "Other tenant", initialCreditsUsd: 10 });
  const foreignClient = new CamelRun({ baseUrl: workerUrl, apiKey: foreign.apiKey });
  t.after(() => foreignClient.close());
  const forgedIdentity = await foreignClient.agents.upsert("forged-owner", { model: "mock/default", toolIdentity, mcpServers: [mcp] });
  await assert.rejects(forgedIdentity.run("Start a run"), /another tenant/);
  assert.equal(calls.length, 1);
  const jwks = await (await fetch(`${workerUrl}/v2/.well-known/jwks.json`)).json() as { keys: { kid: string; d?: string }[] };
  assert.equal(jwks.keys[0]?.kid, "tool-fixture");
  assert.equal(jwks.keys[0]?.d, undefined);

  const guarded = await target.agents.upsert("guarded-tool", { model: "mock/default", toolIdentity, mcpServers: [mcp] });
  const guardedPrompt = 'Call the signed tool [CALL:bot__guarded {"text":"hello"}]';
  const waiting = await guarded.run(guardedPrompt);
  assert.equal(waiting.status, "input_required");
  const inputId = waiting.inputs[0]!.id;
  assert.equal(calls.length, 1);
  await assert.rejects(guarded.answerInput(inputId, { answer: "yes" }), /explicitly/);
  const agentClient = new CamelRun({ baseUrl: workerUrl, apiKey: guarded.agentToken! });
  t.after(() => agentClient.close());
  const untrusted = await agentClient.agents.get(guarded.id);
  await assert.rejects(untrusted.answerInput(inputId, { approved: true }), /tenant credential/);
  assert.equal((await guarded.answerInput(inputId, { approved: false })).status, "completed");
  assert.equal(calls.length, 1);
  const another = await guarded.run(guardedPrompt);
  assert.equal(another.status, "input_required");
  const approvedInput = another.inputs[0]!.id;
  const allowed = await guarded.answerInput(approvedInput, { approved: true });
  assert.match(allowed.text, /verified tool response/);
  assert.equal(calls.length, 2);
  assert.equal(calls[1]?.identity?.approval?.input, approvedInput);
  assert.equal(calls[1]?.identity?.approval?.by.id, toolIdentity.subject);

  const settings = await target.agents.upsert("tool-forms", {
    model: "mock/default", toolIdentity, mcpServers: [mcp],
  });
  const approval = (await settings.run("Set up a bot [CALL:bot__settings {}]")).inputs[0]!;
  assert.equal(formCalls.length, 0);
  const form = (await settings.answerInput(approval.id, { approved: true })).inputs.find(input => input.status === "pending")!;
  assert.equal(form.kind, "question");
  assert.ok(form.prompt && typeof form.prompt === "object");
  assert.equal(form.prompt.question, "Pick a bot name");
  await assert.rejects(settings.answerInput(form.id, { answer: "bad form" }), /with an object/);
  const link = (await settings.answerInput(form.id, { answer: { name: "Kelpie" } })).inputs.find(input => input.status === "pending")!;
  assert.ok(link.prompt && typeof link.prompt === "object");
  assert.equal(link.prompt.question, "Finish setup");
  assert.equal("requestState" in link.prompt, false);
  const configured = await settings.answerInput(link.id, { approved: true });
  assert.match(configured.text, /Configured Kelpie/);
  assert.equal(formCalls.length, 3);
  assert.equal(new Set(formCalls.map(call => call.idempotencyKey)).size, 1);
  assert.equal(new Set(formCalls.map(call => call.callId)).size, 3);
  assert.ok(formCalls.every(call => call.identity?.approval?.input === approval.id));
}

export async function rehearseMigration(t: TestContext, workerUrl: string, adminKey: string) {
  const { tenantId, apiKey } = await CamelRun.createTenant({
    baseUrl: workerUrl,
    adminKey,
    name: "Camel Bots migration rehearsal",
    initialCreditsUsd: 10,
  });
  const v1 = await runtime(t, () => ({ content: "fixture" }), {
    AGENT_IDLE_MS: "1000",
    AGENT_IDLE_COMPACTION: "0",
    AGENT_V2_COMPAT_URL: `${workerUrl}/v2`,
    AGENT_V2_COMPAT_API_KEYS: JSON.stringify({ [tenantId]: apiKey }),
  });
  const source = new AgentRuntime({ url: v1.base, apiKey: OPERATOR });
  const token = await v1.call("/v1/tokens", { body: { name: "Existing v1 client" } });
  assert.equal(token.status, 201);
  const originalKey = token.json.token as string;
  const target = new CamelRun({ baseUrl: workerUrl, apiKey });
  t.after(() => target.close());

  const assistant = { role: "assistant", timestamp: 2, provider: "openrouter", model: "openai/gpt-4o-mini" };
  const seeded = await v1.call("/v1/agents", { body: { initialMessages: [
    { role: "user", content: "Look up my fixture in /workspace/uploads/web/notes.txt", timestamp: 1 },
    { ...assistant, content: [{ type: "toolCall", name: "lookup", id: "lookup-1", arguments: { id: "fixture" } }] },
    { role: "toolResult", toolName: "lookup", toolCallId: "lookup-1", content: [{ type: "text", text: "fixture result" }], timestamp: 3, isError: false },
    { ...assistant, timestamp: 4, content: [{ type: "text", text: "Found the fixture" }] },
  ] } });
  assert.equal(seeded.status, 201, seeded.text);
  const sourceAgent = seeded.json.id as string;
  const workspace = await target.repos.create({ name: "v1-builder-workspace" });
  const path = "uploads/web/notes.txt";
  const { commit } = await target.repos.write(workspace.repoId, { path, content: "v1 attachment bytes" });
  await target.repos.write(workspace.repoId, { path, content: "changed after attachment" });
  const history = await target.agents.upsert("migrated-history", { model: "mock/default", repoId: workspace.repoId });
  const copy = (previous?: string, at = commit) => migrateHistory(v1.base, OPERATOR, sourceAgent, history, previous, [
    { messageIndex: 0, files: [{ path: `/workspace/${path}`, commit: at, contentType: "text/plain" }] },
  ]);
  await assert.rejects(copy(undefined, workspace.commit), /is missing at the specified commit/);
  assert.deepEqual(await history.history(), []);
  const firstCopy = await copy();
  assert.equal(firstCopy.count, 4);
  assert.deepEqual(await copy(), firstCopy);
  const imported = await history.history();
  assert.deepEqual(imported.map(m => (m.content as { meta: { v1: unknown } }).meta.v1),
    (await v1.call(`/v1/agents/${sourceAgent}/history`)).json.messages);
  assert.deepEqual((imported[0]?.content as { files?: unknown } | undefined)?.files, [{ lineage: workspace.lineage, path, commit, contentType: "text/plain", size: 19 }]);
  assert.equal((await target.repos.read(workspace.repoId, { path, at: commit })).content, "v1 attachment bytes");
  await v1.prompt(sourceAgent, "One turn while the v1 bot is still serving");
  await assert.rejects(copy(), /history import has changed/);
  const finalCopy = await copy(firstCopy.receipt);
  assert.equal(finalCopy.count, 6);
  const agentCredentials = new CamelRun({ baseUrl: workerUrl, apiKey: history.agentToken! });
  t.after(() => agentCredentials.close());
  await assert.rejects((await agentCredentials.agents.get(history.id)).importV1History({ source: sourceAgent, messages: [] }), /cannot perform admin/);
  const newTurn = await history.run("Continue in v2");
  assert.equal(newTurn.status, "completed");
  assert.equal((await history.history()).length, 8);
  await assert.rejects(copy(finalCopy.receipt), /already has activity/);

  const stagedVolume = source.volume((await source.createVolume({ name: "agent-staging" })).id);
  await stagedVolume.write("notes.md", "kept on v2");
  const stagedSnapshot = await stagedVolume.snapshot({ name: "saved" });
  const agentToStage = await v1.call("/v1/agents", { headers: { "Idempotency-Key": "legacy-staged-agent" }, body: {
    mounts: [{ volumeId: stagedVolume.id, path: "/workspace", mode: "rw" }],
  } });
  assert.equal(agentToStage.status, 201, agentToStage.text);
  const stagedAgentId = agentToStage.json.id as string;
  await v1.prompt(stagedAgentId, "An existing agent turn");
  const stagingRepo = await target.repos.create({ name: "agent-staging" });
  const stagingAgent = await target.agents.upsert("staged-agent", { model: "mock/default", repoId: stagingRepo.repoId });
  const from = { url: v1.base, apiKey: OPERATOR, agentId: stagedAgentId };
  const stage = (previous?: string) => stageAgent(from, target, stagingAgent.id, { initialCommit: stagingRepo.commit, previous });
  const firstStage = await stage();
  assert.equal(firstStage.history.count, 2);
  assert.ok(firstStage.workspace?.snapshotCommits[stagedSnapshot.id]);
  assert.equal((await target.repos.read(stagingRepo.repoId, { path: "notes.md" })).content, "kept on v2");
  assert.deepEqual(await stage(), firstStage);
  const lastV1Prompt = "A turn before cutover";
  const lastV1RequestId = "last-v1-request";
  const lastV1Record = await v1.prompt(stagedAgentId, lastV1Prompt, originalKey, { requestId: lastV1RequestId });
  await stagedVolume.write("notes.md", "updated before cutover");
  let receiptAfterLateEdit: string | undefined;
  const lateEditTarget = new CamelRun({
    baseUrl: workerUrl,
    apiKey,
    fetch: async (url, init) => {
      const response = await fetch(url, { ...init, body: typeof init?.body === "string" ? init.body : undefined });
      if (init?.method === "PUT" && url.endsWith("/history/import") && response.ok) {
        ({ receipt: receiptAfterLateEdit } = await response.clone().json() as { receipt: string });
        await stagedVolume.write("notes.md", "late edit during staging");
      }
      return response;
    },
  });
  t.after(() => lateEditTarget.close());
  await assert.rejects(stageAgent(from, lateEditTarget, stagingAgent.id, {
    initialCommit: stagingRepo.commit, previous: firstStage.history.receipt,
  }), /v1 agent changed during staging.*written with receipt [0-9a-f]+/);
  assert.ok(receiptAfterLateEdit);
  const operation = randomUUID();
  await until(() => fenceV1Agent(v1.db, "alice", stagedAgentId, operation), "the source to become durably idle");
  const refused = await v1.call(`/v1/agents/${stagedAgentId}/prompt`, { body: { text: "A prompt that raced the cutover" } });
  assert.match(refused.json.error, /^AGENT_V2_CUTOVER:/);
  const secondStage = await stage(receiptAfterLateEdit);
  assert.equal(secondStage.history.count, 4);
  assert.ok(secondStage.workspace!.seq > firstStage.workspace!.seq);
  assert.equal((await target.repos.read(stagingRepo.repoId, { path: "notes.md" })).content, "late edit during staging");
  const sourceHistory = await v1.call(`/v1/agents/${stagedAgentId}/history`);
  assert.equal(sourceHistory.status, 200, sourceHistory.text);
  const fenced = { tenant: "alice", agent: stagedAgentId, operation };
  const destination = { tenant: tenantId, agent: stagingAgent.id };
  assert.equal(await publishV2AgentRoute(v1.db, { ...fenced, operation: randomUUID() }, destination), false);
  assert.equal(await publishV2AgentRoute(v1.db, fenced, destination), true);
  assert.equal(await publishV2AgentRoute(v1.db, fenced, destination), true);
  assert.equal(await publishV2AgentRoute(v1.db, fenced, { ...destination, agent: history.id }), false);
  assert.equal(await unfenceV1Agent(v1.db, "alice", stagedAgentId, operation), false);

  const pathV1 = `/v1/agents/${stagedAgentId}`;
  const routePrompt = (text: string, requestId: string, token = originalKey) =>
    v1.call(`${pathV1}/prompt`, { body: { text, requestId }, token });
  const previous = await routePrompt(lastV1Prompt, lastV1RequestId);
  assert.equal(previous.status, 202);
  assert.deepEqual(previous.json, lastV1Record);
  assert.equal((await routePrompt("Changed arguments", lastV1RequestId)).status, 409);
  assert.equal((await routePrompt("Cross-tenant attempt", "other-tenant", OTHER_OPERATOR)).status, 404);
  assert.equal((await routePrompt("Rejected credential", "bad-key", "invalid")).status, 401);
  const unsupported = await v1.call(`${pathV1}/prompt`, {
    token: originalKey, body: { text: "Skip this turn", endUser: "another-payer", requestId: "unmapped-option" },
  });
  assert.equal(unsupported.status, 501);
  assert.equal(unsupported.json.code, "V1_COMPAT_UNSUPPORTED");

  const requestId = "first-v2-request";
  const firstV2Prompt = "Continue from the copied history";
  const [a, b] = await Promise.all([routePrompt(firstV2Prompt, requestId), routePrompt(firstV2Prompt, requestId)]);
  assert.equal(a.status, 202, a.text);
  assert.equal(b.status, 202, b.text);
  const received = await v1.call(`${pathV1}/requests/${requestId}?wait=10`, { token: originalKey });
  assert.equal(received.status, 200, received.text);
  assert.equal(received.json.id, requestId);
  assert.equal(received.json.status, "completed");
  assert.ok(received.json.outcome.result.reply);
  assert.equal((await routePrompt("Changed arguments", requestId)).status, 409);
  assert.deepEqual((await routePrompt(firstV2Prompt, requestId)).json, received.json);
  assert.equal((await stagingAgent.history()).length, 6);

  const originalAgentToken = agentToStage.json.token as string;
  const scopedPath = `/clients/${stagedAgentId}/requests`;
  const scopedId = "existing-agent-token";
  const scoped = await v1.call(scopedPath, {
    token: originalAgentToken, body: { id: scopedId, method: "prompt", params: { text: "Continue with the original agent token" } },
  });
  assert.equal(scoped.status, 202, scoped.text);
  const scopedSettled = await v1.call(`${scopedPath}/${scopedId}?wait=10`, { token: originalAgentToken });
  assert.equal(scopedSettled.status, 200, scopedSettled.text);
  assert.equal(scopedSettled.json.status, "completed");
  assert.equal((await stagingAgent.history()).length, 8);
  const compatibleState = await v1.call(`${pathV1}/state`, { token: originalKey });
  assert.equal(compatibleState.status, 200, compatibleState.text);
  assert.equal(compatibleState.json.busy, false);
  assert.equal(compatibleState.json.queuedRuns, 0);
  assert.equal(compatibleState.json.activeRun, null);
  for (const id of [lastV1RequestId, requestId, scopedId]) {
    assert.equal(compatibleState.json.requests.find((row: { id: string }) => row.id === id)?.state, "completed");
  }
  const originalState = await v1.call(`/clients/${stagedAgentId}/state`, { token: originalAgentToken });
  assert.deepEqual(originalState.json, compatibleState.json);
  const streamId = "streamed-v2-request";
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]);
  try {
    const stream = await fetch(`${v1.base}${pathV1}/events?request=${streamId}`, {
      headers: { Authorization: `Bearer ${originalKey}`, "Last-Event-ID": String(compatibleState.json.cursor) }, signal,
    });
    assert.equal(stream.status, 200);
    assert.ok(stream.body);
    const accepted = await routePrompt("Stream this reply", streamId);
    assert.equal(accepted.status, 202, accepted.text);
    let text = "", terminal = false, cursor = compatibleState.json.cursor;
    for await (const message of parseSSE(stream.body, signal)) {
      if (message.event === "ready") continue;
      const id = Number(message.id);
      assert.ok(id > cursor);
      cursor = id;
      const event = JSON.parse(message.data);
      if (event.type === "event" && event.event.type === "message_update") {
        assert.equal(event.requestId, streamId);
        text += event.event.assistantMessageEvent.delta;
      }
      if (event.type === "response") {
        assert.equal(event.id, streamId);
        assert.equal(event.outcome.result.reply, text);
        terminal = true;
        break;
      }
    }
    assert.ok(text);
    assert.ok(terminal);
    const replay = await v1.call(`${pathV1}/events?poll=1&request=${streamId}`, {
      token: originalKey, headers: { "Last-Event-ID": String(compatibleState.json.cursor) },
    });
    assert.equal(replay.status, 200, replay.text);
    assert.ok(replay.json.events.some((entry: { data: { type: string; id?: string } }) => entry.data.type === "response" && entry.data.id === streamId));
  } finally {
    controller.abort();
  }
  // The existing SDK uses the v1 tenant key to recover the original agent credential
  // and consumes the legacy event protocol with that credential.
  const legacy = new AgentRuntime({ url: v1.base, apiKey: originalKey });
  const credentials = await legacy.agentCredentials(stagedAgentId);
  assert.equal(credentials.id, stagedAgentId);
  assert.equal(credentials.token, originalAgentToken);
  const sdkRequestId = "legacy-sdk-prompt";
  const sdkEvents: string[] = [];
  const legacyAgent = await legacy.connectAgent(credentials, {
    attach: false,
    onEvent(event, requestId) {
      if (requestId === sdkRequestId) sdkEvents.push(event.type);
    },
  });
  try {
    const result = await legacyAgent.prompt("Run through the existing v1 SDK", { idempotencyKey: sdkRequestId, timeoutMs: 15_000 });
    const record = await v1.call(`${pathV1}/requests/${sdkRequestId}`, { token: originalKey });
    assert.equal(record.status, 200, record.text);
    assert.equal(record.json.status, "completed");
    assert.deepEqual(result, record.json.outcome.result);
    await until(() => sdkEvents.includes("message_update"), "Legacy SDK receives streamed text");
  } finally {
    await legacyAgent.close();
  }
  await assert.rejects(stagingAgent.importV1History({
    source: stagedAgentId, previous: secondStage.history.receipt, messages: sourceHistory.json.messages,
  }), /destination already has activity/);

  const attachmentHistory = await target.agents.upsert("attachment-check", { model: "mock/default" });
  await assert.rejects(attachmentHistory.importV1History({ source: sourceAgent, messages: [{
    role: "user", timestamp: 1, content: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
  }] }), /unsupported role, attachment, or content block/);
  assert.deepEqual(await attachmentHistory.history(), []);

  // A successful v2 write can lose its response. Recover its commit on an explicit rerun.
  let lostResponse = false;
  const interruptedTarget = new CamelRun({
    baseUrl: workerUrl,
    apiKey,
    fetch: async (url, init) => {
      const response = await fetch(url, { ...init, body: typeof init?.body === "string" ? init.body : undefined });
      if (!lostResponse && url.endsWith("/write") && response.ok) {
        lostResponse = true;
        await response.text();
        throw new Error("lost v2 write response");
      }
      return response;
    },
  });
  t.after(() => interruptedTarget.close());

  for (const bot of ["released", "saved", "new-draft"]) {
    const volume = source.volume((await source.createVolume({ name: bot })).id);
    const repo = await target.repos.create({ name: bot });
    const released = bot === "released" ? await volume.snapshot({
      name: "release:v1", pinned: true, labels: { release: "v1" },
      files: { "bot.ts": "export const version = 1;", "notes/old.md": "only in the release", "empty": "" },
    }) : null;
    const logo = new Uint8Array([0, 137, 255, 9]);
    await volume.write("assets/logo.bin", logo);
    await volume.write("notes/current.md", new Uint8Array([239, 187, 191, 97, 10]));
    await volume.write("bot.ts", "export const saved = true;");
    const saved = bot !== "new-draft" ? await volume.snapshot({ name: "published" }) : null;
    await volume.write("bot.ts", "export const draft = true;");

    if (bot === "released") {
      await assert.rejects(migrateVolume(volume, interruptedTarget, repo.repoId, repo.commit), /lost v2 write response/);
    }
    const first = await migrateVolume(volume, target, repo.repoId, repo.commit);
    assert.equal(first.seq, (await volume.info()).seq);
    assert.deepEqual(await migrateVolume(volume, target, repo.repoId, repo.commit), first);
    assert.equal((await target.repos.history(repo.repoId)).commits.length, (released ? 1 : 0) + (saved ? 1 : 0) + 2);
    assert.equal((await target.repos.read(repo.repoId, { path: "bot.ts" })).content, "export const draft = true;");

    // Simulate v1 remaining live after the first copy, including a save with an unchanged draft sequence.
    const newer = await volume.snapshot({ name: "new save" });
    const second = await migrateVolume(volume, target, repo.repoId, repo.commit);
    assert.equal(second.seq, first.seq);
    assert.ok(second.snapshotCommits[newer.id]);
    assert.notEqual(second.head, second.snapshotCommits[newer.id]);
    assert.deepEqual(await migrateVolume(volume, target, repo.repoId, repo.commit), second);
    await volume.write("bot.ts", "export const finalV1 = true;");
    await volume.remove("notes/current.md");
    const ready = await migrateVolume(volume, target, repo.repoId, repo.commit);
    assert.ok(ready.seq > first.seq);
    assert.equal(ready.seq, (await volume.info()).seq);
    if (released) assert.equal(ready.snapshotCommits[released.id], first.snapshotCommits[released.id]);
    if (saved) assert.equal((await target.repos.read(repo.repoId, { at: ready.snapshotCommits[saved.id], path: "bot.ts" })).content, "export const saved = true;");
    assert.deepEqual(Buffer.from((await target.repos.read(repo.repoId, { path: "assets/logo.bin" })).base64!, "base64"), Buffer.from(logo));

    const agent = await target.agents.upsert(bot, { repoId: repo.repoId, model: "mock/default", builtins: ["files"] });
    const read = await agent.run('Read the migrated draft [CALL:read_file {"path":"bot.ts"}]');
    assert.equal(read.status, "completed");
    assert.match(read.text, /finalV1/);

    // Once v2 accepts writes, a stale import must fail instead of overwriting the live repo.
    const edit = await agent.run('Edit the migrated draft [CALL:edit_file {"path":"bot.ts","oldString":"finalV1","newString":"firstV2"}]');
    assert.equal(edit.status, "completed");
    await assert.rejects(migrateVolume(volume, target, repo.repoId, repo.commit), /outside this import/);
    assert.equal((await target.repos.read(repo.repoId, { path: "bot.ts" })).content, "export const firstV2 = true;");
    assert.equal(await volume.readText("bot.ts"), "export const finalV1 = true;");

    if (released) {
      await target.repos.restore(repo.repoId, { targetCommit: ready.snapshotCommits[released.id]! });
      assert.equal((await target.repos.read(repo.repoId, { path: "bot.ts" })).content, "export const version = 1;");
      assert.equal((await target.repos.read(repo.repoId, { path: "empty" })).content, "");
      assert.equal((await target.repos.read(repo.repoId, { at: ready.head, path: "bot.ts" })).content, "export const finalV1 = true;");
    }
  }
}
