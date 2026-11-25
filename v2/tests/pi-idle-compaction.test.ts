import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createAssistantMessageEventStream,
  createModels,
  createProvider,
  type Api,
  type AssistantMessage,
  type Message,
  type Model,
  type ProviderStreams,
  type SimpleStreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  CompactionEntry,
  CompactionTask,
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  MemoryStorage,
  ProviderDoc,
  UsageDoc,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
import { Miniflare } from "miniflare";
import {
  createCamelRunBillingExtension,
  type BillingUsageEvent,
} from "../worker/src/pi/extensions.ts";
import {
  DEFAULT_COMPACT_ON_IDLE_KEEP_RECENT_TOKENS,
  DEFAULT_COMPACT_ON_IDLE_MIN_TOKENS,
  DEFAULT_COMPACT_ON_IDLE_SECONDS,
} from "../worker/src/types.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BG = BACKGROUND_CONTEXT;

function loadDirModules(dir: string) {
  const modules: Record<
    string,
    { type: "esm" | "wasm" | "data"; contents: string | Uint8Array<ArrayBuffer> }
  > = {};
  for (const entry of readdirSync(dir)) {
    if (entry.endsWith(".map") || entry === "README.md") continue;
    const full = join(dir, entry);
    if (entry.endsWith(".wasm")) {
      const buf = readFileSync(full);
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      modules[entry] = { type: "wasm", contents: new Uint8Array(ab) };
    } else if (entry.endsWith(".js") || entry.endsWith(".mjs")) {
      modules[entry] = { type: "esm", contents: readFileSync(full, "utf8") };
    }
  }
  return modules;
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        b && typeof b === "object" && "text" in b
          ? String((b as { text?: unknown }).text ?? "")
          : "",
      )
      .join("\n");
  }
  return "";
}

function streamSingleMessage(msg: AssistantMessage) {
  const s = createAssistantMessageEventStream();
  queueMicrotask(() => {
    if (msg.stopReason === "error") {
      s.push({ type: "error", reason: "error", error: msg });
      s.end(msg);
      return;
    }
    s.push({ type: "start", partial: { ...msg, content: [] } });
    const doneReason =
      msg.stopReason === "toolUse" || msg.stopReason === "length" ? msg.stopReason : "stop";
    s.push({ type: "done", reason: doneReason, message: msg });
    s.end(msg);
  });
  return s;
}

// =============================================================================
// PART A: Direct pi-durable Harness + beforeCompact Hook Verification
//   - Byte-for-byte prefix preservation & same sessionId & cacheRetention != "none"
//   - Usage recorded once (no double-counting)
//   - Overflow fallback -> default serialized CompactionTask
//   - Tool-call fallback -> default serialized CompactionTask
//   - Error / throw fallback -> default serialized CompactionTask
//   - Spend-limit decline -> 0 compaction LLM calls
// =============================================================================

interface RecordedModelCall {
  messages: Message[];
  options: SimpleStreamOptions | undefined;
  isSerializedCompaction: boolean;
  isPrefixCompaction: boolean;
}

function createHarnessTestFixture(opts?: {
  spendLimitUsd?: () => number | undefined;
  spentUsd?: () => number;
  prefixCompactionBehavior?: () => "ok" | "toolCall" | "errorStop" | "throw";
}) {
  const calls: RecordedModelCall[] = [];
  const usageEvents: BillingUsageEvent[] = [];

  const testModel: Model<Api> = {
    id: "gpt-cache-test",
    name: "GPT Cache Test",
    api: "openai-responses",
    provider: "testprov",
    baseUrl: "https://testprov.local/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 2.0, output: 8.0, cacheRead: 0.2, cacheWrite: 2.0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
  };

  const makeAssistant = (
    content: AssistantMessage["content"],
    stopReason: AssistantMessage["stopReason"],
    usage: { input: number; output: number; cacheRead: number },
    errorMessage?: string,
  ): AssistantMessage => {
    const cost = {
      input: (usage.input * 2.0) / 1_000_000,
      output: (usage.output * 8.0) / 1_000_000,
      cacheRead: (usage.cacheRead * 0.2) / 1_000_000,
      cacheWrite: 0,
      total: (usage.input * 2.0 + usage.output * 8.0 + usage.cacheRead * 0.2) / 1_000_000,
    };
    return {
      role: "assistant",
      content,
      api: testModel.api,
      provider: testModel.provider,
      model: testModel.id,
      usage: {
        input: usage.input,
        output: usage.output,
        cacheRead: usage.cacheRead,
        cacheWrite: 0,
        totalTokens: usage.input + usage.output + usage.cacheRead,
        cost,
      },
      stopReason,
      ...(errorMessage ? { errorMessage } : {}),
      timestamp: Date.now(),
    };
  };

  const streams: ProviderStreams = {
    stream: () => {
      throw new Error("Unexpected non-simple stream()");
    },
    streamSimple: (_model, context: TranscriptContext, options?: SimpleStreamOptions) => {
      const msgs = structuredClone(context.messages) as Message[];
      const firstSys = msgs[0]?.role === "system" ? messageText(msgs[0].content) : "";
      const lastUser = msgs.at(-1)?.role === "user" ? messageText(msgs.at(-1)!.content) : "";
      const isSerializedCompaction = firstSys.includes("context summarization assistant");
      const isPrefixCompaction =
        !isSerializedCompaction &&
        lastUser.includes("STOP. Do NOT call any tools.") &&
        lastUser.includes("structured context checkpoint summary");

      calls.push({
        messages: msgs,
        options: options ? { ...options } : undefined,
        isSerializedCompaction,
        isPrefixCompaction,
      });

      if (isPrefixCompaction) {
        const mode = opts?.prefixCompactionBehavior?.() ?? "ok";
        if (mode === "throw") {
          throw new Error("Simulated transient network error during prefix compaction");
        }
        if (mode === "errorStop") {
          return streamSingleMessage(
            makeAssistant(
              [],
              "error",
              { input: 0, output: 0, cacheRead: 0 },
              "Simulated provider error",
            ),
          );
        }
        if (mode === "toolCall") {
          return streamSingleMessage(
            makeAssistant(
              [
                {
                  type: "toolCall",
                  id: "call_bad_compact",
                  name: "lookup_doc",
                  arguments: { id: "1" },
                },
              ],
              "toolUse",
              { input: 50, output: 20, cacheRead: 900 },
            ),
          );
        }
        return streamSingleMessage(
          makeAssistant(
            [
              {
                type: "text",
                text: "## Goal\nPrefix-cached summary preserving ALPHA-KEY-42.\n## Critical Context\n- ALPHA-KEY-42",
              },
            ],
            "stop",
            { input: 80, output: 60, cacheRead: 1200 },
          ),
        );
      }

      if (isSerializedCompaction) {
        return streamSingleMessage(
          makeAssistant(
            [
              {
                type: "text",
                text: "## Goal\nSerialized fallback summary preserving ALPHA-KEY-42.",
              },
            ],
            "stop",
            { input: 400, output: 50, cacheRead: 0 },
          ),
        );
      }

      return streamSingleMessage(
        makeAssistant(
          [{ type: "text", text: `Assistant reply #${calls.length} to ${lastUser.slice(0, 30)}` }],
          "stop",
          { input: 500, output: 40, cacheRead: 0 },
        ),
      );
    },
  };

  const models = createModels();
  models.setProvider(
    createProvider({
      id: "testprov",
      name: "TestProv",
      baseUrl: "https://testprov.local/v1",
      auth: {
        apiKey: {
          name: "TestProv",
          async resolve() {
            return { auth: { apiKey: "sk-test" } };
          },
        },
      },
      api: streams,
      models: [testModel],
    }),
  );

  const registry = createRegistry();
  const sampleTool = defineTool({
    name: "lookup_doc",
    description: "Look up an architectural document by ID.",
    parameters: obj({ id: str({ description: "Document ID" }) }),
    async execute(args) {
      return { output: [{ type: "text", text: `doc:${args.id}` }] };
    },
  }) as unknown as ToolRegistration;

  registry.install(defineExtension({ name: "sample-tools", tools: [sampleTool] }));
  registry.install(
    createCamelRunBillingExtension({
      getSpendLimitUsd: opts?.spendLimitUsd,
      getSpentUsd: opts?.spentUsd,
      onUsageRecorded: (ev) => {
        usageEvents.push(ev);
      },
    }),
  );

  return { models, registry, calls, usageEvents, sampleTool };
}

test("beforeCompact: prefix-preserving cache hit, exact sessionId, fallbacks, spend limit, and single-counted billing", async (t) => {
  assert.equal(DEFAULT_COMPACT_ON_IDLE_SECONDS, 240);
  assert.equal(DEFAULT_COMPACT_ON_IDLE_MIN_TOKENS, 24_000);
  assert.equal(DEFAULT_COMPACT_ON_IDLE_KEEP_RECENT_TOKENS, 4_000);

  await t.test("1. prefix-preserving compaction sends byte-for-byte identical prefix + same sessionId + keeps cacheRetention + bills once", async () => {
    const fx = createHarnessTestFixture();
    const harness = await Harness.open(
      new MemoryStorage(),
      {
        models: fx.models,
        registry: fx.registry,
        settings: {
          stream: { cacheRetention: "short" },
          compaction: { enabled: true, keepRecentTokens: 40 },
        },
      },
      BG,
    );
    t.after(() => harness.close(BG));

    const conv = await harness.root(BG, {
      agent: {
        model: { provider: "testprov", modelId: "gpt-cache-test" },
        instructions: "You are a precise architecture assistant.",
        tools: [fx.sampleTool],
      },
    });

    const s1 = await conv.submit(
      {
        type: "input",
        content:
          "ALPHA-KEY-42 long context: " + "architecture notes and invariants. ".repeat(60),
      },
      BG,
    );
    await s1.wait(BG);

    const s2 = await conv.submit({ type: "input", content: "Short recent follow-up." }, BG);
    await s2.wait(BG);

    const genCalls = fx.calls.filter((c) => !c.isPrefixCompaction && !c.isSerializedCompaction);
    assert.equal(genCalls.length, 2);
    const liveViewBeforeCompact = await conv.context(BG);
    const providerDoc = await harness.snapshot(ProviderDoc, conv.id, BG);
    assert.ok(providerDoc?.sessionId, "Expected ProviderDoc.sessionId to exist after generation");

    const usageBefore = fx.usageEvents.length;
    const taskId = await conv.compact(undefined, BG);
    const settled = await harness.waitForTask(taskId, BG);
    assert.equal(settled.state.outcome.status, "completed");
    const res = settled.state.outcome.result as { submissionId?: number };
    if (res.submissionId !== undefined) {
      const sub = await harness.submission(res.submissionId as never, BG);
      await sub?.wait(BG);
    }

    // Exactly ONE compaction call — prefix-preserving (NOT serialized!)
    const compactCalls = fx.calls.slice(2);
    assert.equal(compactCalls.length, 1, `Expected 1 compaction call, got ${compactCalls.length}`);
    const compactCall = compactCalls[0]!;
    assert.equal(compactCall.isPrefixCompaction, true);
    assert.equal(compactCall.isSerializedCompaction, false);

    // Byte-for-byte identical live prefix (system prompt + tool declarations + user/assistant history)!
    assert.deepEqual(compactCall.messages.slice(0, -1), liveViewBeforeCompact.messages);

    // Exact same sessionId as GenerationTask (for OpenAI/Azure prompt_cache_key)!
    assert.equal(compactCall.options?.sessionId, genCalls[1]!.options?.sessionId);
    assert.equal(compactCall.options?.sessionId, providerDoc.sessionId);

    // cacheRetention MUST NOT be "none"!
    assert.notEqual(compactCall.options?.cacheRetention, "none");
    assert.equal(compactCall.options?.cacheRetention, "short");

    // CompactionEntry placed with our prefix-cached summary
    const viewAfter = await conv.context(BG);
    assert.ok(viewAfter.head && CompactionEntry.is(viewAfter.head));
    assert.ok(messageText(viewAfter.head.model?.[0]?.content).includes("Prefix-cached summary"));

    // Usage recorded ONCE under kind: "compaction" with exact tokens & cost, and UsageDoc matches!
    const newUsage = fx.usageEvents.slice(usageBefore);
    assert.equal(newUsage.length, 1);
    assert.equal(newUsage[0]!.kind, "compaction");
    assert.equal(newUsage[0]!.inputTokens, 1280); // 80 uncached + 1200 cacheRead
    assert.equal(newUsage[0]!.outputTokens, 60);
    assert.equal(newUsage[0]!.cacheReadTokens, 1200);
    assert.ok(newUsage[0]!.costUsd > 0);

    const usageDoc = await harness.snapshot(UsageDoc, conv.id, BG);
    const modelUsage = usageDoc?.models["testprov/gpt-cache-test"];
    assert.ok(modelUsage);
    // 2 gen calls (500+500 input, 40+40 output) + 1 compaction call (80 input, 60 output, 1200 cacheRead)
    assert.equal(modelUsage.input, 1080);
    assert.equal(modelUsage.output, 140);
    assert.equal(modelUsage.cacheRead, 1200);
  });

  await t.test("2. overflow reason skips prefix-preserving hook and uses default serialized CompactionTask", async () => {
    const fx = createHarnessTestFixture();
    const harness = await Harness.open(
      new MemoryStorage(),
      {
        models: fx.models,
        registry: fx.registry,
        settings: { compaction: { enabled: true, keepRecentTokens: 40 } },
      },
      BG,
    );
    t.after(() => harness.close(BG));

    const conv = await harness.root(BG, {
      agent: {
        model: { provider: "testprov", modelId: "gpt-cache-test" },
        instructions: "System prompt.",
      },
    });
    await (
      await conv.submit(
        { type: "input", content: "ALPHA-KEY-42 verbose: " + "word ".repeat(300) },
        BG,
      )
    ).wait(BG);
    await (await conv.submit({ type: "input", content: "Recent turn." }, BG)).wait(BG);

    const callIdx = fx.calls.length;
    const taskId = await conv.commit(
      (tx) =>
        tx.createTask(
          CompactionTask,
          { reason: "overflow" },
          { ownership: { kind: "conversation" }, conversationId: conv.id },
        ),
      BG,
    );
    const settled = await harness.waitForTask(taskId, BG);
    assert.equal(settled.state.outcome.status, "completed");
    const res = settled.state.outcome.result as { submissionId?: number };
    if (res.submissionId !== undefined) {
      await (await harness.submission(res.submissionId as never, BG))?.wait(BG);
    }

    const compactCalls = fx.calls.slice(callIdx);
    assert.equal(compactCalls.length, 1);
    assert.equal(compactCalls[0]!.isPrefixCompaction, false);
    assert.equal(compactCalls[0]!.isSerializedCompaction, true);
    assert.equal(compactCalls[0]!.options?.cacheRetention, "none");

    const viewAfter = await conv.context(BG);
    assert.ok(viewAfter.head && CompactionEntry.is(viewAfter.head));
    assert.ok(
      messageText(viewAfter.head.model?.[0]?.content).includes("Serialized fallback summary"),
    );
  });

  for (const mode of ["toolCall", "errorStop", "throw"] as const) {
    await t.test(`3. graceful fallback to default CompactionTask when prefix call returns ${mode}`, async () => {
      const fx = createHarnessTestFixture({ prefixCompactionBehavior: () => mode });
      const harness = await Harness.open(
        new MemoryStorage(),
        {
          models: fx.models,
          registry: fx.registry,
          settings: { compaction: { enabled: true, keepRecentTokens: 40 } },
        },
        BG,
      );
      t.after(() => harness.close(BG));

      const conv = await harness.root(BG, {
        agent: {
          model: { provider: "testprov", modelId: "gpt-cache-test" },
          instructions: "System prompt.",
          tools: [fx.sampleTool],
        },
      });
      await (
        await conv.submit(
          { type: "input", content: "ALPHA-KEY-42 verbose: " + "word ".repeat(300) },
          BG,
        )
      ).wait(BG);
      await (await conv.submit({ type: "input", content: "Recent turn." }, BG)).wait(BG);

      const callIdx = fx.calls.length;
      const taskId = await conv.compact(undefined, BG);
      const settled = await harness.waitForTask(taskId, BG);
      assert.equal(settled.state.outcome.status, "completed");
      const res = settled.state.outcome.result as { submissionId?: number };
      if (res.submissionId !== undefined) {
        await (await harness.submission(res.submissionId as never, BG))?.wait(BG);
      }

      const compactCalls = fx.calls.slice(callIdx);
      assert.equal(compactCalls.length, 2, `Expected [prefixAttempt, serializedFallback]`);
      assert.equal(compactCalls[0]!.isPrefixCompaction, true);
      assert.equal(compactCalls[1]!.isSerializedCompaction, true);

      const viewAfter = await conv.context(BG);
      assert.ok(viewAfter.head && CompactionEntry.is(viewAfter.head));
      assert.ok(
        messageText(viewAfter.head.model?.[0]?.content).includes("Serialized fallback summary"),
      );
    });
  }

  await t.test("4. spend limit exceeded declines compaction with 0 compaction LLM calls", async () => {
    let spent = 0;
    const fx2 = createHarnessTestFixture({
      spendLimitUsd: () => 1.0,
      spentUsd: () => spent,
    });
    const harness2 = await Harness.open(
      new MemoryStorage(),
      {
        models: fx2.models,
        registry: fx2.registry,
        settings: { compaction: { enabled: true, keepRecentTokens: 40 } },
      },
      BG,
    );
    t.after(() => harness2.close(BG));

    const conv = await harness2.root(BG, {
      agent: {
        model: { provider: "testprov", modelId: "gpt-cache-test" },
        instructions: "System prompt.",
      },
    });
    await (
      await conv.submit(
        { type: "input", content: "ALPHA-KEY-42 verbose: " + "word ".repeat(300) },
        BG,
      )
    ).wait(BG);
    await (await conv.submit({ type: "input", content: "Recent turn." }, BG)).wait(BG);

    // Exceed spend limit right before compaction
    spent = 1.25;
    const callIdx = fx2.calls.length;
    const taskId = await conv.compact(undefined, BG);
    const settled = await harness2.waitForTask(taskId, BG);
    assert.equal(settled.state.outcome.status, "completed");
    assert.deepEqual(settled.state.outcome.result, {});
    assert.equal(fx2.calls.slice(callIdx).length, 0, "Expected 0 compaction LLM calls when spend exceeded");
    const viewAfter = await conv.context(BG);
    assert.equal(viewAfter.head, undefined);
  });
});

// =============================================================================
// PART B: Full Miniflare + AgentDO Warm-Cache Idle Alarm Integration Tests
// =============================================================================

interface CapturedHttpRequest {
  isSerializedCompaction: boolean;
  isPrefixCompaction: boolean;
  totalChars: number;
  messages: Array<Record<string, unknown>>;
  tools: unknown;
  body: Record<string, unknown>;
}

async function startMockOpenAiServer() {
  const captured: CapturedHttpRequest[] = [];
  let prefixCompactionMode: "ok" | "toolCall" | "error" = "ok";

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};

    if (url.pathname !== "/v1/chat/completions") {
      res.writeHead(404);
      res.end("not found");
      return;
    }

    const messages = (body.messages ?? []) as Array<Record<string, unknown>>;
    const systemText = messages
      .filter((m) => m.role === "system" || m.role === "developer")
      .map((m) => messageText(m.content))
      .join("\n");
    const lastText = messageText(messages.at(-1)?.content);
    const isSerializedCompaction = systemText.includes("context summarization assistant");
    const isPrefixCompaction =
      !isSerializedCompaction &&
      lastText.includes("STOP. Do NOT call any tools.") &&
      lastText.includes("structured context checkpoint summary");
    const totalChars = messages.reduce((sum, m) => sum + messageText(m.content).length, 0);

    captured.push({
      isSerializedCompaction,
      isPrefixCompaction,
      totalChars,
      messages,
      tools: body.tools,
      body,
    });

    if (isPrefixCompaction && prefixCompactionMode === "error") {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Simulated prefix compaction error" } }));
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    });

    const emit = (
      delta: Record<string, unknown>,
      finishReason: string | null = null,
      usage?: Record<string, unknown>,
    ) => {
      res.write(
        `data: ${JSON.stringify({
          id: `chatcmpl_${captured.length}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: body.model || "gpt-idle-test",
          choices: [{ index: 0, delta, finish_reason: finishReason }],
          ...(usage ? { usage } : {}),
        })}\n\n`,
      );
    };

    if (isPrefixCompaction && prefixCompactionMode === "toolCall") {
      emit({
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: "call_stray_tool",
            type: "function",
            function: { name: "lookup_doc", arguments: '{"id":"42"}' },
          },
        ],
      });
      emit({}, "tool_calls", {
        prompt_tokens: Math.max(10, Math.ceil(totalChars / 4)),
        completion_tokens: 12,
      });
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    const reply = isPrefixCompaction
      ? [
          "## Goal",
          "Continue user conversation concisely (prefix-cached).",
          "## Progress",
          "### Done",
          "- [x] Processed earlier verbose history about ALPHA-MARKER-99.",
          "## Critical Context",
          "- Key token: ALPHA-MARKER-99",
        ].join("\n")
      : isSerializedCompaction
        ? [
            "## Goal",
            "Continue user conversation concisely (serialized fallback).",
            "## Critical Context",
            "- Key token: ALPHA-MARKER-99",
          ].join("\n")
        : `Reply to: ${lastText.slice(0, 60)} (msgs=${messages.length}, chars=${totalChars})`;

    const promptTokens = Math.max(10, Math.ceil(totalChars / 4));
    const cachedTokens = isPrefixCompaction ? Math.floor(promptTokens * 0.9) : 0;
    emit({ role: "assistant", content: reply });
    emit({}, "stop", {
      prompt_tokens: promptTokens,
      completion_tokens: Math.max(5, Math.ceil(reply.length / 4)),
      ...(cachedTokens > 0
        ? { prompt_tokens_details: { cached_tokens: cachedTokens } }
        : {}),
    });
    res.write("data: [DONE]\n\n");
    res.end();
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as { port: number };
  return {
    baseUrl: `http://127.0.0.1:${addr.port}/v1`,
    captured,
    setPrefixCompactionMode(mode: "ok" | "toolCall" | "error") {
      prefixCompactionMode = mode;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("AgentDO compactOnIdle: warm-cache idle alarm, prefix preservation, threshold gating, fallback, and inheritance", async (t) => {
  const tmpDir = mkdtempSync(join(tmpdir(), "camelrun-idle-alarm-"));
  const workerOut = join(tmpDir, "worker");
  const entryFile = join(tmpDir, "test-worker.ts");
  t.after(() => rmSync(tmpDir, { recursive: true, force: true }));

  const workerIndexPath = join(ROOT, "worker/src/index.ts").replace(/\\/g, "/");
  writeFileSync(
    entryFile,
    `import app, { AgentDO as RuntimeAgentDO, TenantDO, VoiceCallDO } from ${JSON.stringify(workerIndexPath)};
export { TenantDO, VoiceCallDO };

export class AgentDO extends RuntimeAgentDO {
  async inspectIdleAlarm(): Promise<{ alarm: number | null; lastIdleCompactedSeq: number | null }> {
    const alarm = await this.ctx.storage.getAlarm();
    let lastIdleCompactedSeq: number | null = null;
    try {
      const row = this.ctx.storage.sql
        .exec<{ v: string }>("SELECT v FROM runtime_kv WHERE k = 'last_idle_compacted_seq' LIMIT 1")
        .toArray()[0];
      if (row?.v !== undefined) lastIdleCompactedSeq = Number(row.v);
    } catch {}
    return { alarm, lastIdleCompactedSeq };
  }

  async triggerAlarmNow(): Promise<{ alarm: number | null; lastIdleCompactedSeq: number | null }> {
    await this.alarm();
    return this.inspectIdleAlarm();
  }
}

export default {
  ...app,
  async fetch(request: Request, env: any, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\\/_test\\/agent\\/([^/]+)\\/(inspect|alarm)$/);
    if (match) {
      const agentId = decodeURIComponent(match[1]!);
      const action = match[2]!;
      const stub = env.AGENT_DO.get(env.AGENT_DO.idFromName(agentId));
      const data = action === "alarm" ? await stub.triggerAlarmNow() : await stub.inspectIdleAlarm();
      return Response.json(data);
    }
    return app.fetch(request, env, ctx);
  },
};
`,
  );

  const envVars = {
    ...process.env,
    XDG_CONFIG_HOME: "/tmp/xdg",
    WRANGLER_LOG_PATH: join(ROOT, ".wrangler/logs"),
  };

  execFileSync(
    "npx",
    [
      "wrangler",
      "deploy",
      entryFile,
      "--dry-run",
      "-c",
      "worker/wrangler.jsonc",
      "--outdir",
      workerOut,
    ],
    { cwd: ROOT, env: envVars, stdio: "pipe" },
  );

  const llm = await startMockOpenAiServer();
  t.after(() => llm.close());

  const adminSecret = "idle-alarm-admin";
  const vaultSecret = "idle-alarm-vault-secret-32-bytes!!";

  const mf = new Miniflare({
    workers: [
      {
        config: {
          name: "camelrun-worker-v2",
          compatibilityDate: "2026-03-24",
          compatibilityFlags: ["nodejs_compat", "enhanced_error_serialization"],
          manifest: {
            mainModule: "test-worker.js",
            modules: loadDirModules(workerOut),
          },
          exports: {
            TenantDO: { type: "durable-object", storage: "sqlite" },
            AgentDO: { type: "durable-object", storage: "sqlite" },
            VoiceCallDO: { type: "durable-object", storage: "sqlite" },
          },
          env: {
            ADMIN_SECRET: { type: "text", value: adminSecret },
            VAULT_SECRET: { type: "text", value: vaultSecret },
            CAMELFS_URL: { type: "text", value: "http://127.0.0.1:9" },
            CAMELFS_DEV_TOKEN: { type: "text", value: "dev-token" },
            DEFAULT_MODEL: { type: "text", value: "mock/default" },
            TENANT_DO: { type: "durable-object", worker: "camelrun-worker-v2", exportName: "TenantDO" },
            AGENT_DO: { type: "durable-object", worker: "camelrun-worker-v2", exportName: "AgentDO" },
            VOICE_CALL_DO: { type: "durable-object", worker: "camelrun-worker-v2", exportName: "VoiceCallDO" },
          },
        },
      },
    ],
  });
  t.after(() => mf.dispose());

  const createTenantRes = await mf.dispatchFetch("http://worker.test/v2/tenants", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Admin-Key": adminSecret },
    body: JSON.stringify({ name: "idle-alarm-tenant", initialCreditsUsd: 25 }),
  });
  assert.equal(createTenantRes.status, 201);
  const tenant = (await createTenantRes.json()) as { apiKey: string };

  const api = async (
    path: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string },
  ) => {
    const res = await mf.dispatchFetch(`http://worker.test${path}`, {
      method: init?.method,
      body: init?.body,
      headers: {
        Authorization: `Bearer ${tenant.apiKey}`,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, json };
  };

  const inspectAlarm = async (agentId: string) => {
    const res = await mf.dispatchFetch(
      `http://worker.test/_test/agent/${encodeURIComponent(agentId)}/inspect`,
    );
    return (await res.json()) as { alarm: number | null; lastIdleCompactedSeq: number | null };
  };

  const triggerAlarm = async (agentId: string) => {
    const res = await mf.dispatchFetch(
      `http://worker.test/_test/agent/${encodeURIComponent(agentId)}/alarm`,
    );
    return (await res.json()) as { alarm: number | null; lastIdleCompactedSeq: number | null };
  };

  const provRes = await api("/v2/providers/openai", {
    method: "PUT",
    body: JSON.stringify({
      apiKey: "sk-test-idle",
      baseUrl: llm.baseUrl,
      apiStyle: "openai-chat",
    }),
  });
  assert.equal(provRes.status, 200, JSON.stringify(provRes));

  const largeTurn1Prompt =
    "ALPHA-MARKER-99 detailed architectural notes: " +
    "lorem ipsum dolor sit amet consectetur adipiscing elit. ".repeat(80);
  const smallTurn2Prompt = "Keep this recent message short and verbatim: RECENT-TURN-2.";

  // =========================================================================
  // 1. Warm-cache idle alarm fires above minTokens, preserves exact prefix,
  //    emits context_compacted(reason: "idle"), updates last_idle_compacted_seq,
  //    and does NOT re-fire on subsequent alarms!
  // =========================================================================
  await t.test("1. warm-cache idle alarm compacts above minTokens with exact prefix match and never re-fires", async () => {
    const upsert = await api("/v2/agents/idle-alarm-trigger", {
      method: "PUT",
      body: JSON.stringify({
        model: "openai/gpt-idle-test",
        instructions: "You are a helpful assistant.",
        tools: [
          {
            name: "lookup_doc",
            description: "Look up a document by ID",
            parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
            url: "http://127.0.0.1:9/tool",
          },
        ],
        compactOnIdle: {
          enabled: true,
          idleSeconds: 1,
          minTokens: 400,
          keepRecentTokens: 120,
        },
      }),
    });
    assert.equal(upsert.status, 201, JSON.stringify(upsert));
    const agentId = upsert.json.id as string;

    const reqStart = llm.captured.length;
    const r1 = await api("/v2/agents/idle-alarm-trigger/runs", {
      method: "POST",
      body: JSON.stringify({ prompt: largeTurn1Prompt, wait: true }),
    });
    assert.equal(r1.status, 200);
    assert.equal(r1.json.status, "completed");

    const r2 = await api("/v2/agents/idle-alarm-trigger/runs", {
      method: "POST",
      body: JSON.stringify({ prompt: smallTurn2Prompt, wait: true }),
    });
    assert.equal(r2.status, 200);
    assert.equal(r2.json.status, "completed");

    const callsBeforeAlarm = llm.captured.slice(reqStart);
    assert.equal(callsBeforeAlarm.length, 2);
    const turn2Req = callsBeforeAlarm[1]!;
    const turn2Chars = turn2Req.totalChars;
    assert.ok(turn2Chars > 4000);

    // Alarm MUST be scheduled because activeTokens >= minTokens
    const beforeAlarm = await inspectAlarm(agentId);
    assert.ok(beforeAlarm.alarm !== null, "Expected DO alarm to be scheduled when activeTokens >= minTokens");
    assert.equal(beforeAlarm.lastIdleCompactedSeq, null);

    // Wait past idleSeconds (1s) so the real scheduled DO alarm fires automatically!
    const beforeCompactIdx = llm.captured.length;
    const deadline = Date.now() + 4_000;
    while (llm.captured.length === beforeCompactIdx && Date.now() < deadline) {
      await sleep(100);
    }
    // Wait briefly for the alarm's compaction commit & event persistence to finish
    await sleep(250);
    const afterAlarm = await inspectAlarm(agentId);

    const compactCalls = llm.captured.slice(beforeCompactIdx);
    assert.equal(compactCalls.length, 1, `Expected 1 prefix-preserving compaction call, got ${compactCalls.length}`);
    const compactReq = compactCalls[0]!;
    assert.equal(compactReq.isPrefixCompaction, true, "Must use prefix-preserving compaction");
    assert.equal(compactReq.isSerializedCompaction, false, "Must NOT fall back to serialized compaction");

    // Prefix of compaction request matches live Turn 2 prefix + Turn 2 assistant response byte-for-byte!
    assert.deepEqual(
      compactReq.messages.slice(0, turn2Req.messages.length),
      turn2Req.messages,
      "Compaction prefix must be byte-for-byte identical to Turn 2 messages",
    );
    assert.equal(compactReq.messages[turn2Req.messages.length]?.role, "assistant");
    assert.equal(compactReq.messages.length, turn2Req.messages.length + 2);
    assert.deepEqual(compactReq.tools, turn2Req.tools, "Compaction tools must match live generation tools");

    // last_idle_compacted_seq persisted and no re-arm alarm left behind
    assert.ok(
      typeof afterAlarm.lastIdleCompactedSeq === "number" && afterAlarm.lastIdleCompactedSeq > 0,
      `Expected last_idle_compacted_seq to be persisted, got ${afterAlarm.lastIdleCompactedSeq}`,
    );

    // Exactly one context_compacted event with reason: "idle"
    const eventsRes = await api("/v2/agents/idle-alarm-trigger/events?after=0");
    assert.equal(eventsRes.status, 200);
    const compactedEvents = (
      eventsRes.json.events as Array<{ type: string; data: Record<string, unknown> }>
    ).filter((e) => e.type === "context_compacted");
    assert.equal(compactedEvents.length, 1, JSON.stringify(compactedEvents));
    assert.equal(compactedEvents[0]!.data.reason, "idle");
    assert.ok(Number(compactedEvents[0]!.data.compactedCount) > 0);
    assert.ok(Number(compactedEvents[0]!.data.upToSeq) > 0);
    assert.ok(Number(compactedEvents[0]!.data.idleSeconds) >= 1);

    // Firing alarm() AGAIN must NOT re-compact!
    const beforeSecondAlarmIdx = llm.captured.length;
    await sleep(200);
    const afterSecondAlarm = await triggerAlarm(agentId);
    assert.equal(
      llm.captured.slice(beforeSecondAlarmIdx).length,
      0,
      "Subsequent alarm() must NOT re-compact",
    );
    assert.equal(afterSecondAlarm.alarm, null, "No new idle alarm should remain scheduled after compaction");

    // Next user turn (Turn 3) runs immediately with NO on-resume compaction, and sees the compacted <summary>!
    const beforeTurn3Idx = llm.captured.length;
    const r3 = await api("/v2/agents/idle-alarm-trigger/runs", {
      method: "POST",
      body: JSON.stringify({ prompt: "Turn 3 after warm-cache idle alarm compaction.", wait: true }),
    });
    assert.equal(r3.status, 200);
    assert.equal(r3.json.status, "completed");

    const turn3Calls = llm.captured.slice(beforeTurn3Idx);
    assert.equal(turn3Calls.length, 1, "Turn 3 must issue ONLY the user generation call (zero on-resume compaction)");
    assert.equal(turn3Calls[0]!.isPrefixCompaction, false);
    assert.equal(turn3Calls[0]!.isSerializedCompaction, false);

    const turn3Payload = turn3Calls[0]!.messages.map((m) => messageText(m.content)).join("\n");
    assert.ok(turn3Payload.includes("<summary>"), "Expected compacted <summary> in Turn 3");
    assert.ok(turn3Payload.includes("ALPHA-MARKER-99"), "Expected preserved marker in Turn 3");
    assert.ok(turn3Payload.includes("RECENT-TURN-2"), "Expected recent turn kept verbatim");
    assert.ok(
      turn3Calls[0]!.totalChars < turn2Chars * 0.5,
      `Expected Turn 3 input (${turn3Calls[0]!.totalChars}) < 50% of Turn 2 (${turn2Chars})`,
    );
  });

  // =========================================================================
  // 2. Below minTokens schedules NO alarm and does NOT compact
  // =========================================================================
  await t.test("2. below minTokens schedules NO DO alarm and does NOT compact", async () => {
    const upsert = await api("/v2/agents/small-context-no-alarm", {
      method: "PUT",
      body: JSON.stringify({
        model: "openai/gpt-idle-test",
        compactOnIdle: {
          enabled: true,
          idleSeconds: 1,
          minTokens: 5_000,
          keepRecentTokens: 100,
        },
      }),
    });
    assert.equal(upsert.status, 201);
    const agentId = upsert.json.id as string;

    const startIdx = llm.captured.length;
    await api("/v2/agents/small-context-no-alarm/runs", {
      method: "POST",
      body: JSON.stringify({ prompt: "Tiny message 1", wait: true }),
    });
    await api("/v2/agents/small-context-no-alarm/runs", {
      method: "POST",
      body: JSON.stringify({ prompt: "Tiny message 2", wait: true }),
    });

    // ZERO alarm scheduled when activeTokens < minTokens!
    const insp = await inspectAlarm(agentId);
    assert.equal(
      insp.alarm,
      null,
      `Expected NO alarm scheduled when activeTokens < minTokens, got ${insp.alarm}`,
    );

    // Even if alarm() is manually invoked after idleSeconds, 0 compaction calls happen!
    await sleep(1150);
    await triggerAlarm(agentId);

    const calls = llm.captured.slice(startIdx);
    assert.equal(calls.length, 2, `Expected only the 2 user turns (0 compaction calls), got ${calls.length}`);
    assert.equal(calls.some((c) => c.isPrefixCompaction || c.isSerializedCompaction), false);

    const eventsRes = await api("/v2/agents/small-context-no-alarm/events?after=0");
    const compacted = (eventsRes.json.events as Array<{ type: string }>).filter(
      (e) => e.type === "context_compacted",
    );
    assert.equal(compacted.length, 0);
  });

  // =========================================================================
  // 3. End-to-end fallback: tool-call during prefix compaction falls back to
  //    pi-durable's default serialized CompactionTask cleanly
  // =========================================================================
  await t.test("3. tool-call response in prefix compaction falls back cleanly to serialized CompactionTask", async () => {
    const upsert = await api("/v2/agents/idle-fallback-toolcall", {
      method: "PUT",
      body: JSON.stringify({
        model: "openai/gpt-idle-test",
        tools: [
          {
            name: "lookup_doc",
            description: "Look up a document",
            parameters: { type: "object", properties: { id: { type: "string" } } },
            url: "http://127.0.0.1:9/tool",
          },
        ],
        compactOnIdle: {
          enabled: true,
          idleSeconds: 1,
          minTokens: 400,
          keepRecentTokens: 120,
        },
      }),
    });
    assert.equal(upsert.status, 201);
    const agentId = upsert.json.id as string;

    await api("/v2/agents/idle-fallback-toolcall/runs", {
      method: "POST",
      body: JSON.stringify({ prompt: largeTurn1Prompt, wait: true }),
    });
    await api("/v2/agents/idle-fallback-toolcall/runs", {
      method: "POST",
      body: JSON.stringify({ prompt: smallTurn2Prompt, wait: true }),
    });

    const beforeIdx = llm.captured.length;
    llm.setPrefixCompactionMode("toolCall");
    try {
      const deadline = Date.now() + 4_000;
      while (llm.captured.length < beforeIdx + 2 && Date.now() < deadline) {
        await sleep(100);
      }
      await sleep(250);
    } finally {
      llm.setPrefixCompactionMode("ok");
    }

    const calls = llm.captured.slice(beforeIdx);
    assert.equal(calls.length, 2, `Expected [prefixAttempt(toolCall), serializedFallback], got ${calls.length}`);
    assert.equal(calls[0]!.isPrefixCompaction, true);
    assert.equal(calls[1]!.isSerializedCompaction, true);

    const eventsRes = await api("/v2/agents/idle-fallback-toolcall/events?after=0");
    const compacted = (
      eventsRes.json.events as Array<{ type: string; data: Record<string, unknown> }>
    ).filter((e) => e.type === "context_compacted");
    assert.equal(compacted.length, 1);
    assert.equal(compacted[0]!.data.reason, "idle");
  });

  // =========================================================================
  // 4. Definition-level compactOnIdle inheritance, override, null/disabled,
  //    updated defaults (240s), and input validation
  // =========================================================================
  await t.test("4. definition inheritance, override, disable, validation, and 240s default", async () => {
    // Default idleSeconds is now 240 (4 min)
    const defaultUpsert = await api("/v2/agents/default-idle-seconds", {
      method: "PUT",
      body: JSON.stringify({
        model: "openai/gpt-idle-test",
        compactOnIdle: { enabled: true },
      }),
    });
    assert.equal(defaultUpsert.status, 201, JSON.stringify(defaultUpsert));
    const defaultState = await api("/v2/agents/default-idle-seconds");
    assert.deepEqual(defaultState.json.compactOnIdle, {
      enabled: true,
      idleSeconds: 240,
    });

    // Validation errors
    const badDef = await api("/v2/definitions/bad-idle", {
      method: "PUT",
      body: JSON.stringify({
        model: "openai/gpt-idle-test",
        compactOnIdle: { enabled: true, idleSeconds: 0 },
      }),
    });
    assert.equal(badDef.status, 400);

    const badMin = await api("/v2/agents/bad-min", {
      method: "PUT",
      body: JSON.stringify({
        model: "openai/gpt-idle-test",
        compactOnIdle: { enabled: true, idleSeconds: 10, minTokens: -1 },
      }),
    });
    assert.equal(badMin.status, 400);

    const badKeep = await api("/v2/agents/bad-keep", {
      method: "PUT",
      body: JSON.stringify({
        model: "openai/gpt-idle-test",
        compactOnIdle: { enabled: true, idleSeconds: 10, keepRecentTokens: -5 },
      }),
    });
    assert.equal(badKeep.status, 400);

    // Valid definition
    const defPut = await api("/v2/definitions/idle-def", {
      method: "PUT",
      body: JSON.stringify({
        model: "openai/gpt-idle-test",
        instructions: "Definition instructions",
        compactOnIdle: {
          enabled: true,
          idleSeconds: 1,
          minTokens: 400,
          keepRecentTokens: 120,
        },
      }),
    });
    assert.equal(defPut.status, 200);

    // 4a. Agent inherits compactOnIdle from definition and triggers idle alarm compaction
    const inherited = await api("/v2/agents/from-idle-def", {
      method: "PUT",
      body: JSON.stringify({ definition: "idle-def" }),
    });
    assert.equal(inherited.status, 201);
    const inheritedId = inherited.json.id as string;
    const inheritedState = await api("/v2/agents/from-idle-def");
    assert.deepEqual(inheritedState.json.compactOnIdle, {
      enabled: true,
      idleSeconds: 1,
      minTokens: 400,
      keepRecentTokens: 120,
    });

    await api("/v2/agents/from-idle-def/runs", {
      method: "POST",
      body: JSON.stringify({ prompt: largeTurn1Prompt, wait: true }),
    });
    await api("/v2/agents/from-idle-def/runs", {
      method: "POST",
      body: JSON.stringify({ prompt: smallTurn2Prompt, wait: true }),
    });
    const beforeDefAlarm = llm.captured.length;
    const defDeadline = Date.now() + 4_000;
    while (llm.captured.length === beforeDefAlarm && Date.now() < defDeadline) {
      await sleep(100);
    }
    await sleep(250);
    assert.equal(llm.captured.slice(beforeDefAlarm).length, 1);
    assert.equal(llm.captured[beforeDefAlarm]?.isPrefixCompaction, true);
    void inheritedId;

    // 4b. Override
    const override = await api("/v2/agents/override-idle-def", {
      method: "PUT",
      body: JSON.stringify({
        definition: "idle-def",
        compactOnIdle: { enabled: true, idleSeconds: 300, minTokens: 32_000, keepRecentTokens: 6_000 },
      }),
    });
    assert.equal(override.status, 201);
    const overrideState = await api("/v2/agents/override-idle-def");
    assert.deepEqual(overrideState.json.compactOnIdle, {
      enabled: true,
      idleSeconds: 300,
      minTokens: 32_000,
      keepRecentTokens: 6_000,
    });

    // 4c. Disable via null
    const nullDisable = await api("/v2/agents/disable-null-def", {
      method: "PUT",
      body: JSON.stringify({ definition: "idle-def", compactOnIdle: null }),
    });
    assert.equal(nullDisable.status, 201);
    const nullState = await api("/v2/agents/disable-null-def");
    assert.equal(nullState.json.compactOnIdle, undefined);

    // 4d. Disable via { enabled: false }
    const falseDisable = await api("/v2/agents/disable-false-def", {
      method: "PUT",
      body: JSON.stringify({
        definition: "idle-def",
        compactOnIdle: { enabled: false, idleSeconds: 1, minTokens: 100 },
      }),
    });
    assert.equal(falseDisable.status, 201);
    const falseState = await api("/v2/agents/disable-false-def");
    assert.deepEqual(falseState.json.compactOnIdle, {
      enabled: false,
      idleSeconds: 1,
      minTokens: 100,
    });
  });
});
