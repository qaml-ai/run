/**
 * Pure-Pi subagents for the load spike: a replay-safe `subagent` tool whose child conversation the call's own task
 * owns (pi-durable's README pattern, examples 21 and 23), a cheap `work` tool, and an OpenAI-compatible model that
 * streams from the fake model Worker. The same code runs in a Durable Object (worker.ts) and in Node (node-bench.ts).
 */
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, Model, SimpleStreamOptions, StreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import { stream as streamOpenAI, streamSimple as streamOpenAISimple } from "@earendil-works/pi-ai/api/openai-completions";
import { createModels } from "@earendil-works/pi-ai/models";
import { num, obj, str } from "@earendil-works/pi-schema";
import {
  AssistantEntry,
  type ConversationId,
  configure,
  createRegistry,
  defineExtension,
  defineTask,
  defineTool,
  type EntryId,
  type Extension,
  Harness,
  type LiveState,
  ProviderDoc,
  type Report,
  type Storage,
  type ToolExecutionApi,
  type Wake,
} from "@earendil-works/pi-durable";

export const context = BACKGROUND_CONTEXT;

type ChildRecord = { created: number; firstDelta?: number; deltas: number; answered?: number; status?: string; error?: string };

/** What the spike records inside the agent: per-child timings, stream latencies, loop lag, and errors. */
export class Metrics {
  startedAt = Date.now();
  children = new Map<string, ChildRecord>();
  /** Provider delta arrival times of watched conversations, consumed when their watch sees a commit. */
  pending = new Map<string, number[]>();
  latencies: number[] = [];
  lag: number[] = [];
  deltas = 0;
  reports: string[] = [];
  statements = 0;
  parentDone?: number;
  peakHeap = 0;
  /** Model requests made and not ended; of those, ones receiving tokens. */
  requested = 0;
  streaming = 0;
  maxStreaming = 0;
  /** [ms since start, requested, streaming] every second. */
  concurrency: [number, number, number][] = [];

  delta(conversation: string | undefined) {
    this.deltas++;
    if (conversation === undefined) return;
    const child = this.children.get(conversation);
    if (child) {
      child.deltas++;
      child.firstDelta ??= Date.now();
    }
    this.pending.get(conversation)?.push(Date.now());
  }

  /** A watch saw a commit of the conversation's live answer: every delta that arrived before it is now visible. */
  seen(conversation: string) {
    const queue = this.pending.get(conversation);
    if (!queue?.length) return;
    const now = Date.now();
    for (const at of queue) this.latencies.push(now - at);
    queue.length = 0;
  }

  summary() {
    const pct = (values: number[], p: number) => {
      const s = [...values].sort((a, b) => a - b);
      return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : null;
    };
    const children = [...this.children.values()];
    const done = children.filter((child) => child.answered !== undefined);
    const firsts = children.flatMap((child) => (child.firstDelta === undefined ? [] : [child.firstDelta - child.created]));
    const durations = done.map((child) => child.answered! - child.created);
    const statuses: Record<string, number> = {};
    for (const child of children) statuses[child.status ?? "running"] = (statuses[child.status ?? "running"] ?? 0) + 1;
    return {
      elapsedMs: Date.now() - this.startedAt,
      children: children.length,
      answered: done.length,
      statuses,
      errors: [...new Set(children.flatMap((child) => (child.error ? [child.error] : [])))].slice(0, 5),
      deltas: this.deltas,
      firstDeltaMs: { p50: pct(firsts, 50), p95: pct(firsts, 95), max: pct(firsts, 100) },
      childDurationMs: { p50: pct(durations, 50), p95: pct(durations, 95), max: pct(durations, 100) },
      streamLatencyMs: { samples: this.latencies.length, p50: pct(this.latencies, 50), p95: pct(this.latencies, 95), p99: pct(this.latencies, 99), max: pct(this.latencies, 100) },
      loopLagMs: { samples: this.lag.length, p50: pct(this.lag, 50), p95: pct(this.lag, 95), p99: pct(this.lag, 99), max: pct(this.lag, 100) },
      sqlStatements: this.statements,
      parentDoneMs: this.parentDone === undefined ? null : this.parentDone - this.startedAt,
      ...(this.peakHeap ? { peakHeapMiB: Math.round((this.peakHeap / 1048576) * 10) / 10 } : {}),
      reports: this.reports.slice(0, 10),
      maxStreaming: this.maxStreaming,
      concurrency: this.concurrency.filter((_, index) => index % 5 === 0),
    };
  }
}

const FILLER = "The quick brown fox jumps over the lazy dog near the river bank. ";

/** About `tokens` tokens of filler (4 characters a token). */
export function filler(tokens: number) {
  return FILLER.repeat(Math.ceil((tokens * 4) / FILLER.length)).slice(0, tokens * 4);
}

function answerText(message: AssistantMessage | undefined) {
  return (message?.content ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

export type Hooks = {
  sessions: Map<string, string>;
  watch?: (id: ConversationId) => Promise<void>;
  remote?: { task: ReturnType<typeof remoteChildTask>; prefix: string };
};

/** How the parent reaches a child object: start (idempotent by request id), long-poll its answer, and abort it. */
export type RemoteChildren = {
  start(child: string, requestId: string, task: string): Promise<void>;
  wait(child: string, requestId: string, timeoutMs: number): Promise<{ done: boolean; status?: string; text?: string }>;
  abort(child: string, requestId: string): Promise<void>;
};

/**
 * The middle ground's remote child task: owned by the delegate call's task, so Pi's abort cascade, idle waits and
 * replay apply to it. `start` asks the child object to run the conversation (its own Pi submission, deduplicated by the
 * stable request id), `wait` long-polls it and commits the answer, and the abort handler aborts the child.
 */
export function remoteChildTask(remote: RemoteChildren) {
  type Input = { child: string; requestId: string; task: string };
  type State = { phase: "start" } | { phase: "wait"; started: number; startMs: number };
  return defineTask<Input, State, { text: string; startMs: number }>({
    name: "spike.remote-child",
    version: 1,
    initial: () => ({ phase: "start" }),
    phases: {
      start: async (task, runtime, taskContext) => {
        const started = Date.now();
        await remote.start(task.input.child, task.input.requestId, task.input.task);
        await runtime.commit(() => ({ status: "running", checkpoint: { phase: "wait", started, startMs: Date.now() - started } }), taskContext);
      },
      wait: async (task, runtime, taskContext) => {
        // A phase reruns from its top after an eviction, so the poll simply asks again.
        const answer = await remote.wait(task.input.child, task.input.requestId, 20_000);
        const checkpoint = task.state.checkpoint as { phase: "wait"; started: number; startMs: number };
        if (!answer.done) {
          await runtime.commit(() => ({ status: "running", checkpoint }), taskContext);
          return;
        }
        await runtime.commit(() => answer.status === "done"
          ? { status: "terminal", outcome: { status: "completed", result: { text: answer.text ?? "", startMs: checkpoint.startMs } } }
          : { status: "terminal", outcome: { status: "failed", error: { message: `child ${answer.status}` } } }, taskContext);
      },
    },
    abort: async (task, runtime, taskContext) => {
      await remote.abort(task.input.child, task.input.requestId);
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), taskContext);
    },
  });
}

export function subagentExtension(metrics: Metrics, hooks: Hooks): Extension {
  const extension: Extension = defineExtension({
    name: "spike.subagent",
    tasks: hooks.remote ? [hooks.remote.task] : [],
    tools: [
      defineTool({
        name: "subagent",
        description: "Delegate a self-contained task to a subagent and get its answer back.",
        parameters: obj({ task: str() }),
        replay: "safe",
        execute: async (args, api: ToolExecutionApi, callContext: Context) => {
          const ctxTokens = Number(/ctx=(\d+)/.exec(args.task)?.[1] ?? 0);
          if (hooks.remote) {
            // The middle ground: the call owns a RemoteChild task, which runs the conversation in a Durable Object of
            // its own. A rerun finds the task by its memo; the task's abort handler reaches the remote child.
            const key = `remote-${api.taskId}`;
            if (!metrics.children.has(key)) metrics.children.set(key, { created: Date.now(), deltas: 0 });
            const content = ctxTokens > 0 ? `${filler(ctxTokens)}\n\n${args.task}` : args.task;
            const task = (await api.memo<number>("remote", callContext)) ?? (await api.memo("remote",
              Number(await api.createTask(hooks.remote.task, { child: `${hooks.remote.prefix}-t${api.taskId}`, requestId: `subagent:${api.taskId}`, task: content }, { ownership: { kind: "task", taskId: api.taskId } }, callContext)), callContext));
            const settled = await api.waitForTask(task as never, callContext);
            const record = metrics.children.get(key)!;
            record.answered = Date.now();
            const outcome = settled.state.outcome as { status: string; result?: { text: string; startMs: number } };
            record.status = outcome.status === "completed" ? "done" : outcome.status;
            if (outcome.result) record.firstDelta = record.created + outcome.result.startMs;
            if (outcome.status !== "completed") throw new Error(`Subagent ${outcome.status}`);
            return { output: [{ type: "text", text: `${outcome.result!.text.length} characters` }] };
          }
          // The ownership index remembers the child, so a rerun after a crash reuses it.
          const child = await api.commit(async (tx) => {
            const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
            if (existing !== undefined) return existing.id;
            const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
            await configure(tx, created.id, { extensions: { remove: [extension] }, instructions: "You are a subagent." });
            return created.id;
          }, callContext);
          const key = String(child);
          if (!metrics.children.has(key)) metrics.children.set(key, { created: Date.now(), deltas: 0 });
          const provider = await api.snapshot(ProviderDoc, child, callContext);
          if (provider) hooks.sessions.set(provider.sessionId, key);
          await hooks.watch?.(child);
          await api.details({ conversationId: child }, callContext);
          const handle = (await api.conversation(child, callContext))!;
          // A long-context child carries its history in its first message.
          const content = ctxTokens > 0 ? `${filler(ctxTokens)}\n\n${args.task}` : args.task;
          // The stable request id makes a rerun find the submission it already made.
          const request = { type: "input", content, requestId: `subagent:${api.taskId}` } as const;
          const settled = await (await handle.submit(request, callContext)).wait(callContext);
          const record = metrics.children.get(key)!;
          record.answered = Date.now();
          record.status = settled.status === "done" ? "done" : `${settled.status}:${"reason" in settled ? String(settled.reason) : ""}`;
          if (settled.status !== "done" || settled.type !== "input") throw new Error(`Subagent ${record.status}`);
          const entry = await api.commit((tx) => tx.entry(AssistantEntry, settled.answer as EntryId), callContext);
          const text = answerText(entry?.model?.[0] as AssistantMessage | undefined);
          return { output: [{ type: "text", text: `${text.length} characters` }], details: { conversationId: child } };
        },
      }),
      defineTool({
        name: "work",
        description: "Do one round of work.",
        parameters: obj({ round: num() }),
        execute: async (args) => ({ output: [{ type: "text", text: `round ${args.round} ok: ${filler(100)}` }] }),
      }),
    ],
  });
  return extension;
}

export const MODEL: Model<"openai-completions"> = {
  id: "fake-stream",
  name: "Fake streaming model",
  provider: "spike",
  api: "openai-completions",
  baseUrl: "https://invalid.test/v1",
  input: ["text"],
  reasoning: false,
  contextWindow: 1_000_000,
  maxTokens: 8192,
  // Dollars per million tokens, so Pi's per-conversation usage shows a cost.
  cost: { input: 1, output: 4, cacheRead: 0, cacheWrite: 0 },
};

type EventStream = ReturnType<typeof streamOpenAI>;

export function spikeModels(baseUrl: string, metrics: Metrics, fetcher?: typeof fetch) {
  const models = createModels();
  const model = { ...MODEL, baseUrl };
  const sessions = new Map<string, string>();
  // Pi passes each conversation's provider session id; it maps the delta back to its conversation.
  const wrap = (stream: EventStream, sessionId: string | undefined): EventStream => {
    const original = stream[Symbol.asyncIterator].bind(stream);
    (stream as unknown as { [Symbol.asyncIterator]: () => AsyncIterator<unknown> })[Symbol.asyncIterator] = () => {
      const iterator = original() as AsyncIterator<unknown>;
      let streaming = false, ended = false;
      metrics.requested++;
      const end = () => {
        if (ended) return;
        ended = true;
        metrics.requested--;
        if (streaming) metrics.streaming--;
      };
      return {
        next: async () => {
          const result = await iterator.next().catch((error: unknown) => { end(); throw error; });
          const type = (result.value as { type?: string } | undefined)?.type;
          if (!result.done && (type === "text_delta" || type === "toolcall_delta")) {
            if (!streaming) {
              streaming = true;
              metrics.streaming++;
              metrics.maxStreaming = Math.max(metrics.maxStreaming, metrics.streaming);
            }
            metrics.delta(sessionId ? sessions.get(sessionId) : undefined);
          }
          if (result.done || type === "done" || type === "error") end();
          return result;
        },
        ...(iterator.return ? { return: iterator.return.bind(iterator) } : {}),
      };
    };
    return stream;
  };
  const options = <T extends StreamOptions | undefined>(value: T): T => (fetcher ? ({ ...value, fetch: fetcher } as T) : value);
  models.setProvider({
    id: "spike",
    name: "spike",
    auth: { apiKey: { name: "spike", resolve: async () => ({ auth: { apiKey: "fake" } }) } },
    getModels: () => [model],
    stream: (target, transcript: TranscriptContext, streamOptions) =>
      wrap(streamOpenAI(target as Model<"openai-completions">, transcript, options(streamOptions)), streamOptions?.sessionId),
    streamSimple: (target, transcript: TranscriptContext, streamOptions) =>
      wrap(streamOpenAISimple(target as Model<"openai-completions">, transcript, options(streamOptions) as SimpleStreamOptions), streamOptions?.sessionId),
  } as never);
  return { models, sessions, ref: { provider: "spike", modelId: MODEL.id } };
}

export type Spike = {
  harness: Harness;
  root: Awaited<ReturnType<Harness["root"]>>;
  sessions: Map<string, string>;
  watches: { stop(): Promise<unknown> }[];
};

export async function openSpike(
  storage: Storage,
  baseUrl: string,
  metrics: Metrics,
  options: { onWake?: (wake: Wake) => void; fetcher?: typeof fetch; watchChildren?: number; remote?: { children: RemoteChildren; prefix: string } } = {},
): Promise<Spike> {
  const { models, sessions, ref } = spikeModels(baseUrl, metrics, options.fetcher);
  const registry = createRegistry();
  let harness!: Harness;
  const watches: { stop(): Promise<unknown> }[] = [];
  // A UI attached to a few children: each watch sees the child's streamed partials as Pi commits them.
  const watch = async (id: ConversationId) => {
    const key = String(id);
    if (metrics.pending.has(key) || metrics.pending.size >= (options.watchChildren ?? 0)) return;
    metrics.pending.set(key, []);
    const conversation = await harness.conversation(id, context);
    if (!conversation) return;
    const handle = await conversation.watch(context, { min: 1, max: 2 });
    watches.push(handle);
    handle.start(async (call) => {
      if (call.kind !== "value") return;
      if ((call.value.docs["pi.live"] as LiveState | undefined)?.generation) metrics.seen(key);
    });
  };
  const remote = options.remote ? { task: remoteChildTask(options.remote.children), prefix: options.remote.prefix } : undefined;
  registry.install(subagentExtension(metrics, { sessions, watch, ...(remote ? { remote } : {}) }));
  harness = await Harness.open(
    storage,
    {
      models,
      registry,
      ...(options.onWake ? { onWake: options.onWake } : {}),
      onReport: (report: Report) => {
        const error = (report as { error?: unknown }).error;
        metrics.reports.push(`${report.kind}: ${error instanceof Error ? error.message : String(error ?? "")}`.slice(0, 300));
      },
      settings: () => ({ compaction: { enabled: false }, retry: { enabled: false } }),
    } as never,
    context,
  );
  const root = await harness.root(context, { agent: { model: ref } });
  return { harness, root, sessions, watches };
}

/** Start a fan-out run on the root conversation. */
export async function startRun(spike: Spike, metrics: Metrics, run: { n: number; tps: number; tokens: number; tools: number; ctx: number; id: string }) {
  const content = `fanout n=${run.n} tps=${run.tps} tokens=${run.tokens} tools=${run.tools} ctx=${run.ctx}`;
  const submission = await spike.root.submit({ type: "input", content, requestId: `run:${run.id}` }, context);
  void submission.wait(context).then(
    () => { metrics.parentDone = Date.now(); },
    (error: unknown) => { metrics.reports.push(`parent: ${error instanceof Error ? error.message : String(error)}`); },
  );
  return submission;
}

/** Loop lag: how late a 100 ms timer fires, a proxy for how busy the isolate's one thread is. */
export function lagProbe(metrics: Metrics, stopAfterMs: number, onTick?: () => void) {
  const until = Date.now() + stopAfterMs;
  let expected = Date.now() + 100;
  const tick = () => {
    const now = Date.now();
    metrics.lag.push(Math.max(0, now - expected));
    if (metrics.lag.length % 10 === 0) metrics.concurrency.push([now - metrics.startedAt, metrics.requested, metrics.streaming]);
    onTick?.();
    if (now > until) return;
    expected = now + 100;
    setTimeout(tick, 100);
  };
  setTimeout(tick, 100);
}

/** Usage per conversation as Pi keeps it (pi.usage), for the billing question. */
export async function usageByConversation(spike: Spike, ids: string[]) {
  const out: Record<string, unknown> = {};
  for (const id of ids) {
    const conversation = await spike.harness.conversation(Number(id) as unknown as ConversationId, context);
    const watch = await conversation?.watch(context, { min: 1, max: 1 });
    out[id] = watch?.value.docs["pi.usage"];
    await watch?.stop();
  }
  return out;
}
