import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, type Model } from "@earendil-works/pi-ai";
import { stream, streamSimple } from "@earendil-works/pi-ai/api/anthropic-messages";
import { Harness, createRegistry, type TaskId } from "@earendil-works/pi-durable";
import { stream as streamResponses, streamSimple as simpleResponses } from "@earendil-works/pi-ai/api/openai-responses";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { AgentRuntime } from "../src/agent-runtime.ts";
import { abortIdleCompaction, IDLE_COMPACTION_KEY, IdleCompactionDoc, idleCompactionDeadline, wakeIdleCompaction } from "../src/idle-compaction-schedule.ts";
import { IDLE_SUMMARY_PROMPT, idleCompaction } from "../src/idle-compaction.ts";
import { withCompactionPrompt } from "../src/model-compaction.ts";
import { getModel } from "../src/model-catalog.ts";
import { virtualChain } from "../src/model-policy.ts";
import { readIdleCompactionCache } from "../src/model-idle-compaction-payload.ts";
import { withSettings } from "../src/model-settings.ts";
import { senderExtension } from "../src/sender-extension.ts";

function anthropicResponse(id: string, model: string, text: string) {
  const events = [
    { type: "message_start", message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null,
      usage: { input_tokens: 50, output_tokens: 0, cache_read_input_tokens: 64_000, cache_creation_input_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } },
    { type: "message_stop" },
  ];
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "Content-Type": "text/event-stream" },
  });
}

function responses(id: string, text: string) {
  const item = { id: `msg_${id}`, type: "message", role: "assistant", content: [{ type: "output_text", text }] };
  const events = [
    { type: "response.created", response: { id, status: "in_progress" } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
    { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id, status: "completed", usage: {
      input_tokens: 64_050, input_tokens_details: { cached_tokens: 64_000 }, output_tokens: 7, total_tokens: 64_057,
    } } },
  ];
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "Content-Type": "text/event-stream" },
  });
}

async function fixture(t: TestContext, { beforeSummary, existingPrompt, provider = "anthropic", providerOrder }: {
  beforeSummary?: (signal: AbortSignal) => Promise<void | Response>;
  existingPrompt?: string;
  provider?: "anthropic" | "openai" | "openrouter";
  providerOrder?: string[];
} = {}) {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const configuration = { revision: 1, expiresAt: null, config: {} as { idleCompaction?: boolean } };
  const kv = new Map<string, unknown>([["configuration", configuration]]);
  const access = {
    get: async (key: string) => kv.get(key),
    put: async (key: string, value: unknown) => kv.set(key, value),
    delete: async (key: string) => kv.delete(key),
  };
  let pi: Harness;
  const runtime = {
    env: {}, admission: Promise.resolve(), arm: async () => {},
    gone: async () => false, records: async () => [], harness: { pi: async () => pi },
    ctx: { storage: { ...access, transaction: async (action: (tx: typeof access) => unknown) => action(access) }, waitUntil() {} },
  } as unknown as AgentRuntime;
  const idle = idleCompaction(runtime);
  const registry = createRegistry();
  registry.install(senderExtension());
  const model = provider === "openrouter" ? virtualChain("camelrun/default")?.[0] :
    getModel(provider, provider === "openai" ? "gpt-5.4" : "claude-opus-4-8");
  assert.ok(model);
  assert.equal(model.api, provider === "anthropic" ? "anthropic-messages" : "openai-responses");
  const reference = provider === "openrouter" ? "camelrun/default" : `${provider}/${model.id}`;
  let apiKey = "sk-test-fixture";
  let optOutDuringCredentials = false;
  let projectedEvents = 0;
  const calls: Record<string, unknown>[] = [];
  const sessionHeaders: (string | null)[] = [];
  const checkpoint = "Keep the project name and continue the pending work.";
  const fakeFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    assert.equal(new URL(request.url).origin, new URL(model.baseUrl).origin);
    const body = await request.json() as Record<string, unknown>;
    calls.push(body);
    sessionHeaders.push(request.headers.get("x-session-id"));
    const index = calls.length;
    const summary = JSON.stringify(body.messages ?? body.input).includes(IDLE_SUMMARY_PROMPT);
    if (summary) {
      const response = await beforeSummary?.(request.signal);
      if (response) return response;
    }
    const answer = summary ? checkpoint : "Okay.";
    return provider === "anthropic" ? anthropicResponse(`msg_${index}`, model.id, answer) : responses(`resp_${index}`, answer);
  };
  const models = createModels();
  models.setProvider(withSettings({
    id: provider, name: provider, getModels: () => [model],
    auth: { apiKey: { name: provider, resolve: async () => ({ auth: {} }) } },
    stream: (model, transcript, options) => provider === "anthropic"
      ? stream(model as Model<"anthropic-messages">, transcript, { ...options, fetch: fakeFetch })
      : streamResponses(model as Model<"openai-responses">, transcript, { ...options, fetch: fakeFetch }),
    streamSimple: (model, transcript, options) => provider === "anthropic"
      ? streamSimple(model as Model<"anthropic-messages">, transcript, { ...options, fetch: fakeFetch })
      : simpleResponses(model as Model<"openai-responses">, transcript, {
        ...options, fetch: fakeFetch,
        onPayload: providerOrder ? (payload, target) => options?.onPayload?.({
          ...(payload as Record<string, unknown>), provider: { order: providerOrder },
        }, target) : options?.onPayload,
      }),
  }, {
    credentials: async () => {
      if (optOutDuringCredentials) {
        optOutDuringCredentials = false;
        configuration.revision++;
        configuration.config.idleCompaction = false;
      }
      return { apiKey };
    },
    settings: async () => ({ model: reference, idleCompactionEligible: configuration.config.idleCompaction !== false }),
    onStreamEvent: () => { projectedEvents++; },
  }, {}));
  const compaction = { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20, backgroundTokens: 0 };
  const options = { models, now: () => now, settings: { compaction } };
  const directory = existingPrompt === undefined ? undefined : await mkdtemp(join(tmpdir(), "camelrun-idle-compaction-"));
  const storage = () => directory ? openNodeSqliteStorage(join(directory, "conversation.sqlite")) : new MemoryStorage();
  t.after(async () => {
    try { await pi?.close(context); }
    finally { if (directory) await rm(directory, { recursive: true, force: true }); }
  });
  const send = async (root: Awaited<ReturnType<Harness["root"]>>, content: string) => {
    const request = await root.submit({ type: "input", content, entry: { kind: "camel.prompt", data: { from: { id: "user" } } } }, context);
    assert.equal((await request.wait(context)).status, "done");
    await root.waitForIdle(context);
  };

  if (existingPrompt !== undefined) {
    const previous = await Harness.open(await storage(), { ...options, registry }, context);
    try {
      const root = await previous.root(context, { agent: { model: { provider: model.provider, modelId: model.id } } });
      await send(root, existingPrompt);
    } finally { await previous.close(context); }
  }
  registry.install(idle.extension);
  pi = await Harness.open(await storage(), { ...options, registry: withCompactionPrompt(registry, () => compaction, idle) }, context);
  const root = await pi.root(context, { agent: { model: { provider: model.provider, modelId: model.id } } });
  const startIdle = async () => {
    const dueAt = await idleCompactionDeadline(runtime);
    assert.equal(dueAt, now + 240_000);
    now = dueAt;
    await wakeIdleCompaction(runtime);
    const claim = await pi.snapshot(IdleCompactionDoc, root.id, context);
    assert.ok(claim?.taskId);
    return claim.taskId as TaskId;
  };
  return {
    runtime, pi, root, send: (content: string) => send(root, content), startIdle, kv, calls, sessionHeaders, checkpoint, modelKey: `${provider}/${model.id}`,
    advance: (ms: number) => { now += ms; },
    rotateKey: () => { apiKey = "sk-test-rotated"; },
    optOutBeforePayload: () => { optOutDuringCredentials = true; },
    projectedEvents: () => projectedEvents,
  };
}

test("an existing agent compacts after its next eligible turn and preserves full history", { timeout: 5_000 }, async t => {
  const early = "Remember the project called Cedar.";
  const { runtime, pi, root, send, startIdle, kv, calls, checkpoint, modelKey, advance, rotateKey, projectedEvents } = await fixture(t, { existingPrompt: early });
  const latest = "Continue with the prompt discussed in the previous turn.";
  assert.equal(calls.length, 1);
  assert.equal(await idleCompactionDeadline(runtime), Infinity);
  assert.deepEqual(kv.get("configuration"), { revision: 1, expiresAt: null, config: {} });
  advance(1_000);
  await send(latest);
  assert.equal(calls.length, 2);
  const before = await root.context(context);
  const cacheReadBefore = (await pi.usage(context)).models[modelKey].cacheRead;
  const eventsBefore = projectedEvents();
  assert.ok(JSON.stringify(before.messages).includes(early));
  assert.ok(JSON.stringify(calls[1]).includes("<<<RUNTIME_CONTEXT>>>"));
  assert.ok(readIdleCompactionCache(calls[1]));

  const taskId = await startIdle();
  const settled = await pi.waitForTask(taskId, context);
  assert.equal(settled.state.outcome.status, "completed", JSON.stringify(settled.state.outcome));
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[2], {
    ...calls[1], max_tokens: 4_096,
    messages: [...calls[1].messages as unknown[], { role: "user", content: [{ type: "text", text: IDLE_SUMMARY_PROMPT }] }],
  });
  assert.equal((await pi.usage(context)).models[modelKey].cacheRead, cacheReadBefore + 64_000);
  assert.equal(projectedEvents(), eventsBefore);
  assert.equal(kv.has(IDLE_COMPACTION_KEY), false);
  const compacted = await root.context(context);
  assert.equal(compacted.head?.kind, "pi.compaction");
  assert.ok(JSON.stringify(compacted.messages).includes(checkpoint));
  assert.ok(!JSON.stringify(compacted.messages).includes(early));
  assert.ok(JSON.stringify(compacted.messages).includes(latest));
  const history = await root.entries({}, 20, undefined, context);
  assert.ok(history.items.some(entry => entry.kind === "camel.prompt" && entry.model?.[0]?.content === early));
  assert.ok(history.items.some(entry => entry.kind === "camel.prompt" && entry.model?.[0]?.content === latest));
  assert.equal(history.items.filter(entry => entry.kind === "pi.assistant").length, 2);

  advance(1_000);
  await send("What should I do next?");
  assert.equal(calls.length, 4);
  assert.ok(JSON.stringify(calls[3].messages).includes(checkpoint));
  assert.ok(!JSON.stringify(calls[3].messages).includes(early));

  rotateKey();
  const rotatedTaskId = await startIdle();
  assert.notEqual(rotatedTaskId, taskId);
  const rotatedTask = await pi.waitForTask(rotatedTaskId, context);
  assert.equal(rotatedTask.state.outcome.status, "aborted");
  assert.equal(calls.length, 4);
});

function pausedSummary() {
  const started = Promise.withResolvers<AbortSignal>();
  const finish = Promise.withResolvers<void>();
  return {
    started: started.promise,
    finish: finish.resolve,
    wait(signal: AbortSignal) {
      signal.throwIfAborted();
      started.resolve(signal);
      return Promise.race([finish.promise, new Promise<void>((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      })]);
    },
  };
}

test("a follow-up finishes while idle compaction is waiting for the provider", { timeout: 5_000 }, async t => {
  const summary = pausedSummary();
  const { pi, root, send, startIdle, calls, checkpoint, advance } = await fixture(t, { beforeSummary: summary.wait });
  await send("Remember the project called Cedar.");
  advance(1_000);
  await send("Continue with the prompt discussed in the previous turn.");
  const taskId = await startIdle();
  await Promise.race([summary.started, pi.waitForTask(taskId, context).then(task => {
    throw new Error(`Compaction settled before dispatch: ${JSON.stringify(task.state.outcome)}`);
  })]);

  const followUp = "Answer the new question about Cedar.";
  await send(followUp);
  assert.equal(calls.length, 4);
  assert.ok(JSON.stringify(calls[3].messages).includes(followUp));
  assert.equal((await root.context(context)).head, undefined);

  summary.finish();
  const settled = await pi.waitForTask(taskId, context);
  assert.equal(settled.state.outcome.status, "completed");
  const compacted = await root.context(context);
  assert.equal(compacted.head?.kind, "pi.compaction");
  assert.ok(JSON.stringify(compacted.messages).includes(checkpoint));
  assert.ok(JSON.stringify(compacted.messages).includes(followUp));
});

test("shutdown cancels idle compaction even after the provider has received the request", { timeout: 5_000 }, async t => {
  const summary = pausedSummary();
  const { runtime, pi, root, send, startIdle, advance } = await fixture(t, { beforeSummary: summary.wait });
  await send("Remember the project called Cedar.");
  advance(1_000);
  await send("Continue with the prompt discussed in the previous turn.");
  const taskId = await startIdle();
  const signal = await Promise.race([summary.started, pi.waitForTask(taskId, context).then(task => {
    throw new Error(`Compaction settled before dispatch: ${JSON.stringify(task.state.outcome)}`);
  })]);

  await root.abort(context);
  assert.equal(signal.aborted, false);
  await abortIdleCompaction(runtime);
  assert.equal(signal.aborted, true);
  const settled = await pi.waitForTask(taskId, context);
  assert.equal(settled.state.outcome.status, "aborted");
  assert.equal((await root.context(context)).head, undefined);
});

test("opting out during replay preflight skips the provider request and future captures", { timeout: 5_000 }, async t => {
  const { runtime, pi, root, send, startIdle, calls, advance, optOutBeforePayload } = await fixture(t);
  await send("Remember the project called Cedar.");
  advance(1_000);
  await send("Continue with the prompt discussed in the previous turn.");
  optOutBeforePayload();
  const taskId = await startIdle();
  const settled = await pi.waitForTask(taskId, context);
  assert.equal(settled.state.outcome.status, "aborted");
  assert.equal(calls.length, 2);
  assert.equal((await root.context(context)).head, undefined);

  await send("Continue without idle compaction.");
  assert.equal(calls.length, 3);
  assert.equal(await idleCompactionDeadline(runtime), Infinity);
});


for (const provider of ["openai", "openrouter"] as const) {
  test(`idle compaction reuses the ${provider} Responses prefix`, { timeout: 5_000 }, async t => {
    const { pi, root, send, startIdle, calls, sessionHeaders, checkpoint, advance } = await fixture(t, { provider });
    await send("Remember that Cedar is the project name. " + "This is previous context to summarize. ".repeat(100));
    advance(1_000);
    await send("Continue our conversation. " + "Keep this part of our recent conversation intact. ".repeat(20));
    const settled = await pi.waitForTask(await startIdle(), context);
    assert.equal(settled.state.outcome.status, "completed", JSON.stringify(settled.state.outcome));
    assert.equal(calls.length, 3, JSON.stringify(settled.state.outcome));
    const original = calls[1]!, summary = calls[2]!;
    assert.equal(summary.model, original.model);
    assert.deepEqual((summary.input as unknown[]).slice(0, -1), original.input);
    assert.ok(JSON.stringify((summary.input as unknown[]).at(-1)).includes(IDLE_SUMMARY_PROMPT));
    assert.equal((summary.provider as { allow_fallbacks?: boolean } | undefined)?.allow_fallbacks, provider === "openrouter" ? false : undefined);
    if (provider === "openrouter") {
      assert.ok(sessionHeaders[1]);
      assert.equal(sessionHeaders[2], sessionHeaders[1]);
    }
    assert.ok(JSON.stringify((await root.context(context)).messages).includes(checkpoint));
  });
}

test("idle compaction does not retry or use a virtual fallback on an OpenRouter refusal", { timeout: 5_000 }, async t => {
  const { pi, send, startIdle, calls } = await fixture(t, {
    provider: "openrouter",
    beforeSummary: async () => Response.json({ error: { message: "No capacity for this model" } }, { status: 503 }),
  });
  await send("Previous conversation. ".repeat(100));
  await send("Recent conversation. ".repeat(30));
  await pi.waitForTask(await startIdle(), context);
  assert.equal(calls.length, 3);
  assert.equal(calls[2]!.model, calls[1]!.model);
});

test("OpenRouter provider ordering bypasses sticky routing and does not arm idle compaction", { timeout: 5_000 }, async t => {
  const providerOrder = ["baseten", "together"];
  const { runtime, send, calls } = await fixture(t, { provider: "openrouter", providerOrder });
  await send("Previous conversation. ".repeat(100));
  await send("Recent conversation. ".repeat(30));
  assert.deepEqual(calls[1]?.provider, { order: providerOrder });
  assert.equal(await idleCompactionDeadline(runtime), Infinity);
});
