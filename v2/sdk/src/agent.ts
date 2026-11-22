import { isTerminalAgentEvent, normalizeAgentEvent, streamAgentEvents } from "./sse.ts";
import { ToolSession, type ToolEventSubscriber } from "./tools.ts";
import {
  CamelRunError, type AgentEvent, type AgentSchedule, type AgentSummary, type HistoryMessage,
  type LocalTool, type ResponseLike, type RunOptions, type RunRecord, type ScheduleCreateInput,
  type V1HistoryImport, type WebSocketConstructorLike, type WorkflowRunResult,
} from "./types.ts";

export interface AgentTransport {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly WebSocket?: WebSocketConstructorLike;
  requestJson<T>(method: string, path: string, body?: unknown, init?: { headers?: Record<string, string>; signal?: AbortSignal }): Promise<T>;
  requestRaw(method: string, path: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }): Promise<ResponseLike>;
  createHandle(summary: AgentSummary, localTools?: LocalTool<any, any>[]): AgentHandle;
  untrackHandle(handle: AgentHandle): void;
}

export type AgentRunStream<TOutput = unknown> = AsyncGenerator<AgentEvent, RunRecord<TOutput>, void> & {
  readonly result: Promise<RunRecord<TOutput>>;
};

const ACTIVE_STATUSES = new Set(["queued", "running"]);

function buildQuery(params: Record<string, string | number | boolean | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, String(v));
  const str = qs.toString();
  return str ? `?${str}` : "";
}

function unwrapArray<T>(value: unknown, ...fields: string[]): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    for (const f of [...fields, "items"]) if (Array.isArray(rec[f])) return rec[f] as T[];
  }
  return [];
}

export class AgentHandle {
  readonly id: string;
  readonly key: string;
  readonly agentToken?: string;
  readonly repoId?: string | null;
  readonly branch?: string;
  readonly model?: string;
  readonly created?: boolean;
  readonly summary: AgentSummary;

  private readonly transport: AgentTransport;
  private localTools: LocalTool<any, any>[];
  private toolSession: ToolSession | null = null;
  private connectingSession: Promise<ToolSession> | null = null;
  private readonly listeners = new Set<ToolEventSubscriber>();

  readonly schedules = {
    create: (input: ScheduleCreateInput): Promise<AgentSchedule> =>
      this.transport.requestJson("POST", `${this.basePath}/schedules`, input),
    list: async (): Promise<AgentSchedule[]> =>
      unwrapArray<AgentSchedule>(await this.transport.requestJson("GET", `${this.basePath}/schedules`), "schedules"),
    delete: (id: string): Promise<{ deleted: boolean }> =>
      this.transport.requestJson("DELETE", `${this.basePath}/schedules/${encodeURIComponent(id)}`),
  };

  constructor(transport: AgentTransport, summary: AgentSummary, localTools: LocalTool<any, any>[] = []) {
    this.transport = transport;
    this.summary = summary;
    this.id = summary.id;
    this.key = summary.key;
    this.agentToken = summary.agentToken;
    this.repoId = summary.repoId;
    this.branch = summary.branch;
    this.model = summary.model;
    this.created = summary.created;
    this.localTools = [...localTools];
  }

  private get targetId(): string { return this.id || this.key; }
  private get basePath(): string { return `/v2/agents/${encodeURIComponent(this.targetId)}`; }

  attachTools(tools: LocalTool<any, any>[]): this {
    this.localTools = [...tools];
    if (this.toolSession?.isOpen) this.toolSession.setTools(this.localTools);
    return this;
  }

  onEvent(listener: ToolEventSubscriber): () => void {
    this.listeners.add(listener);
    const unsub = this.toolSession?.subscribe(listener);
    return () => { this.listeners.delete(listener); unsub?.(); };
  }

  async ensureToolSession(): Promise<ToolSession | null> {
    if (this.localTools.length === 0) return null;
    if (this.toolSession?.isOpen) return this.toolSession;
    if (this.connectingSession) return this.connectingSession;
    const p = (async () => {
      this.toolSession?.close();
      const session = new ToolSession({
        baseUrl: this.transport.baseUrl, agentIdOrKey: this.targetId,
        token: this.transport.apiKey || this.agentToken || "",
        tools: this.localTools, WebSocket: this.transport.WebSocket,
      });
      for (const l of this.listeners) session.subscribe(l);
      await session.ready();
      this.toolSession = session;
      return session;
    })();
    this.connectingSession = p;
    try { return await p; } finally { this.connectingSession = null; }
  }

  async run<TOutput = unknown>(prompt: string, options?: RunOptions): Promise<RunRecord<TOutput>> {
    await this.ensureToolSession();
    const wait = options?.wait ?? true;
    let rec = await this.transport.requestJson<RunRecord<TOutput>>(
      "POST", `${this.basePath}/runs`,
      { prompt, files: options?.files, idempotencyKey: options?.idempotencyKey, whileRunning: options?.whileRunning, wait, outputSchema: options?.outputSchema, maxSteps: options?.maxSteps, spendLimitUsd: options?.spendLimitUsd, actor: options?.actor, supersedeInputs: options?.supersedeInputs },
      { signal: options?.signal },
    );
    if (wait) {
      let delay = 40;
      while (ACTIVE_STATUSES.has(rec.status) && !options?.signal?.aborted) {
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(250, delay * 2);
        rec = await this.getRun<TOutput>(rec.id);
      }
    }
    if (rec.status === "failed" && options?.throwOnError !== false) {
      const msg = typeof rec.error === "string" ? rec.error : rec.error?.message ?? `Run ${rec.id} failed`;
      const code = typeof rec.error === "object" && rec.error?.code ? rec.error.code : "run_failed";
      throw new CamelRunError(msg, { code, run: rec });
    }
    return rec;
  }

  async submit<TOutput = unknown>(prompt: string, options?: Omit<RunOptions, "wait">): Promise<RunRecord<TOutput>> {
    await this.ensureToolSession();
    return this.transport.requestJson("POST", `${this.basePath}/runs`,
      { prompt, files: options?.files, idempotencyKey: options?.idempotencyKey, whileRunning: options?.whileRunning, wait: false, outputSchema: options?.outputSchema, maxSteps: options?.maxSteps, spendLimitUsd: options?.spendLimitUsd, actor: options?.actor, supersedeInputs: options?.supersedeInputs },
      { signal: options?.signal });
  }

  async steer<TOutput = unknown>(prompt: string, options?: Omit<RunOptions, "whileRunning" | "files">): Promise<RunRecord<TOutput>> {
    await this.ensureToolSession();
    return this.transport.requestJson("POST", `${this.basePath}/runs`,
      { prompt, idempotencyKey: options?.idempotencyKey, whileRunning: "steer", ...(options?.wait !== undefined ? { wait: options.wait } : {}), outputSchema: options?.outputSchema, maxSteps: options?.maxSteps, spendLimitUsd: options?.spendLimitUsd, actor: options?.actor },
      { signal: options?.signal });
  }

  stream<TOutput = unknown>(prompt: string, options?: RunOptions): AgentRunStream<TOutput> {
    let resolveResult!: (run: RunRecord<TOutput>) => void;
    let rejectResult!: (err: unknown) => void;
    const resultPromise = new Promise<RunRecord<TOutput>>((res, rej) => { resolveResult = res; rejectResult = rej; });
    resultPromise.catch(() => {});

    const self = this;
    async function* gen(): AsyncGenerator<AgentEvent, RunRecord<TOutput>, void> {
      try {
        const submitted = await self.submit<TOutput>(prompt, options);
        const abortCtrl = new AbortController();
        const onAbort = () => abortCtrl.abort();
        options?.signal?.addEventListener("abort", onAbort, { once: true });

        let doneByTerminalEvent = false;
        const pollTimer = setInterval(() => {
          void self.getRun<TOutput>(submitted.id).then((r) => {
            if (!ACTIVE_STATUSES.has(r.status)) {
              doneByTerminalEvent = true;
              try { abortCtrl.abort(); } catch {}
            }
          }).catch(() => {});
        }, 750);

        try {
          const res = await self.transport.requestRaw("GET", `${self.basePath}/events${buildQuery({ after: 0, runId: submitted.id })}`, {
            headers: { Accept: "text/event-stream" }, signal: abortCtrl.signal,
          });
          const ct = res.headers.get("content-type") ?? "";
          const seen = new Set<number>();
          if (ct.includes("text/event-stream") && res.body) {
            for await (const ev of streamAgentEvents(res.body, abortCtrl.signal)) {
              if (ev.runId && ev.runId !== submitted.id) continue;
              if (ev.seq > 0) { if (seen.has(ev.seq)) continue; seen.add(ev.seq); }
              yield ev;
              if (isTerminalAgentEvent(ev)) { doneByTerminalEvent = true; break; }
            }
          } else {
            for (const raw of unwrapArray<unknown>(await res.json(), "events")) {
              const ev = normalizeAgentEvent(raw);
              if (!ev.runId || ev.runId === submitted.id) yield ev;
            }
          }
        } catch (err) {
          if (!doneByTerminalEvent && (!abortCtrl.signal.aborted || options?.signal?.aborted)) throw err;
        } finally {
          clearInterval(pollTimer);
          options?.signal?.removeEventListener("abort", onAbort);
          try { if (!abortCtrl.signal.aborted) abortCtrl.abort(); } catch {}
        }

        const finalRun = await self.getRun<TOutput>(submitted.id);
        if (finalRun.status === "failed" && options?.throwOnError === true) {
          const msg = typeof finalRun.error === "string" ? finalRun.error : finalRun.error?.message ?? `Run ${finalRun.id} failed`;
          throw new CamelRunError(msg, { code: "run_failed", run: finalRun });
        }
        resolveResult(finalRun);
        return finalRun;
      } catch (err) { rejectResult(err); throw err; }
    }
    return Object.assign(gen(), { result: resultPromise });
  }

  getRun<TOutput = unknown>(runId: string): Promise<RunRecord<TOutput>> {
    return this.transport.requestJson("GET", `${this.basePath}/runs/${encodeURIComponent(runId)}`);
  }

  getRunByKey<TOutput = unknown>(idempotencyKey: string): Promise<RunRecord<TOutput>> {
    return this.transport.requestJson("GET", `${this.basePath}/runs/${encodeURIComponent(idempotencyKey)}?by=idempotency-key`);
  }

  abort(options?: { keepQueued?: boolean; supersedeInputs?: boolean }): Promise<{ aborted: boolean; [key: string]: unknown }> {
    return this.transport.requestJson("POST", `${this.basePath}/abort`, { keepQueued: options?.keepQueued, supersedeInputs: options?.supersedeInputs });
  }

  async answerInput<TOutput = unknown>(inputId: string, payload: { approved?: boolean; answer?: unknown; wait?: boolean; actor?: string }): Promise<RunRecord<TOutput>> {
    await this.ensureToolSession();
    return this.transport.requestJson("POST", `${this.basePath}/inputs/${encodeURIComponent(inputId)}`, payload);
  }

  async history(options?: { after?: number; before?: number | "latest"; limit?: number }): Promise<HistoryMessage[]> {
    const res = await this.transport.requestJson("GET", `${this.basePath}/history${buildQuery({ after: options?.after, before: options?.before, limit: options?.limit })}`);
    return unwrapArray<HistoryMessage>(res, "messages", "history");
  }

  importV1History(input: V1HistoryImport): Promise<{ receipt: string; count: number }> {
    const endpoint = input.appendAfter === undefined ? "import" : "import/chunk";
    return this.transport.requestJson("PUT", `${this.basePath}/history/${endpoint}`, input);
  }

  async events(options?: { after?: number; runId?: string }): Promise<AgentEvent[]> {
    const res = await this.transport.requestJson("GET", `${this.basePath}/events${buildQuery({ after: options?.after ?? 0, runId: options?.runId })}`, undefined, { headers: { Accept: "application/json" } });
    return unwrapArray<unknown>(res, "events").map((x) => normalizeAgentEvent(x));
  }

  async *eventStream(options?: { after?: number; runId?: string; signal?: AbortSignal }): AsyncGenerator<AgentEvent, void, void> {
    const res = await this.transport.requestRaw("GET", `${this.basePath}/events${buildQuery({ after: options?.after ?? 0, runId: options?.runId })}`, { headers: { Accept: "text/event-stream" }, signal: options?.signal });
    if (res.body) yield* streamAgentEvents(res.body, options?.signal);
  }

  compact(options?: { summary?: string; keepLast?: number }): Promise<{ summary?: string; upToSeq?: number; compactedCount?: number; [key: string]: unknown }> {
    return this.transport.requestJson("POST", `${this.basePath}/compact`, options ?? {});
  }
  resetContext(options?: { summary?: string; keepLast?: number }): Promise<Record<string, unknown>> {
    return this.transport.requestJson("POST", `${this.basePath}/reset-context`, options ?? {});
  }

  async fork(options?: { key?: string; atSeq?: number; tools?: LocalTool<any, any>[] }): Promise<AgentHandle> {
    const summary = await this.transport.requestJson<AgentSummary>("POST", `${this.basePath}/fork`, { key: options?.key, atSeq: options?.atSeq });
    const tools = options?.tools ?? this.localTools;
    const handle = this.transport.createHandle(summary, tools);
    if (tools.length > 0) await handle.ensureToolSession();
    return handle;
  }

  runWorkflow<TResult = unknown>(code: string, options?: { idempotencyKey?: string; wait?: boolean }): Promise<WorkflowRunResult<TResult>> {
    return this.transport.requestJson("POST", `${this.basePath}/workflows`, { code, idempotencyKey: options?.idempotencyKey, wait: options?.wait ?? true });
  }

  dream(): Promise<Record<string, unknown>> { return this.transport.requestJson("POST", `${this.basePath}/dream`, {}); }

  async delete(): Promise<{ deleted: boolean }> {
    this.close();
    this.transport.untrackHandle(this);
    return this.transport.requestJson("DELETE", this.basePath);
  }

  close(): void {
    this.toolSession?.close();
    this.toolSession = null;
    this.listeners.clear();
  }
}
