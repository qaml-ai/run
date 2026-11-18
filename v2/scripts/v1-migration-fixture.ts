import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { AgentRuntime, nodeListener, type ToolContext } from "../../clients/node.ts";
import { serveTools } from "../../clients/server.ts";
import { listen, OPERATOR, runtime } from "../../tests/runtime-server.ts";
import { CamelRun } from "../sdk/src/index.ts";
import { migrateHistory } from "./migrate-history.ts";
import { migrateVolume } from "./migrate-volume.ts";

export async function rehearseSignedTools(t: TestContext, workerUrl: string, adminKey: string) {
  const { tenantId, apiKey } = await CamelRun.createTenant({ baseUrl: workerUrl, adminKey, name: "Signed tools", initialCreditsUsd: 10 });
  const target = new CamelRun({ baseUrl: workerUrl, apiKey });
  t.after(() => target.close());
  const audience = "camel-bots:canary:bot";
  const calls: ToolContext[] = [];
  const url = await listen(t, nodeListener(serveTools({
    listTools: () => ["echo", "restricted"].map(name => ({ name, inputSchema: { type: "object" } })),
    async callTool(name, args, context) {
      assert.equal(name, "echo");
      assert.deepEqual(args, { text: "hello" });
      calls.push(context);
      return { content: [{ type: "text", text: "verified tool response" }] };
    },
  }, { runtime: `${workerUrl}/v2`, tenant: tenantId, audience, metadata: false })));
  const toolIdentity = { subject: "owner", context: { bot: "canary", agent: "default", key: "test" } };
  const mcp = { name: "bot", url, audience, allowTools: ["echo"], auth: { type: "runtime" as const } };
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
}

export async function rehearseMigration(t: TestContext, workerUrl: string, adminKey: string) {
  const v1 = await runtime(t, () => ({ content: "fixture" }));
  const source = new AgentRuntime({ url: v1.base, apiKey: OPERATOR });
  const { apiKey } = await CamelRun.createTenant({
    baseUrl: workerUrl,
    adminKey,
    name: "Camel Bots migration rehearsal",
    initialCreditsUsd: 10,
  });
  const target = new CamelRun({ baseUrl: workerUrl, apiKey });
  t.after(() => target.close());

  const assistant = { role: "assistant", timestamp: 2, provider: "openrouter", model: "openai/gpt-4o-mini" };
  const seeded = await v1.call("/v1/agents", { body: { initialMessages: [
    { role: "user", content: "Look up my fixture", timestamp: 1 },
    { ...assistant, content: [{ type: "toolCall", name: "lookup", id: "lookup-1", arguments: { id: "fixture" } }] },
    { role: "toolResult", toolName: "lookup", toolCallId: "lookup-1", content: [{ type: "text", text: "fixture result" }], timestamp: 3, isError: false },
    { ...assistant, timestamp: 4, content: [{ type: "text", text: "Found the fixture" }] },
  ] } });
  assert.equal(seeded.status, 201, seeded.text);
  const sourceAgent = seeded.json.id as string;
  const history = await target.agents.upsert("migrated-history", { model: "mock/default" });
  const copy = (previous?: string) => migrateHistory(v1.base, OPERATOR, sourceAgent, history, previous);
  const firstCopy = await copy();
  assert.equal(firstCopy.count, 4);
  assert.deepEqual(await copy(), firstCopy);
  assert.deepEqual((await history.history()).map(m => (m.content as { meta: { v1: unknown } }).meta.v1),
    (await v1.call(`/v1/agents/${sourceAgent}/history`)).json.messages);
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
