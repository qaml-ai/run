import { DurableObject } from "cloudflare:workers";
import { Workspace } from "@cloudflare/computer";
import { WorkerJavaScriptBackend } from "@cloudflare/computer/backends/worker-javascript";
import { createPiTools } from "@cloudflare/computer/tools/pi-ai";
import { type Message, type AssistantMessage } from "@earendil-works/pi-ai";
import { Harness, createRegistry, type ToolRegistration, type ConversationView, type LiveState } from "@earendil-works/pi-durable";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { RemoteCodemodeSandbox } from "@earendil-works/pi-codemode/portable";
import type { CodemodeSandboxDurableObject } from "@earendil-works/pi-codemode/cloudflare";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { PiHarness } from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";
import { BadRequest, boundedText, object, body, workspacePath } from "./validation.ts";
import { askHuman, HumanInputs } from "./human.ts";
import { modelRuntime } from "./model.ts";

type Config = { id: string; revision: number; expiresAt: number | null; config: { model?: string; systemPrompt?: string; name?: string; fileTools?: boolean; codeMode?: boolean; thinkingLevel?: string } };
type RequestRecord = { id: string; method: string; params?: Record<string, unknown>; metadata?: unknown; fingerprint: string; state: "running" | "completed"; startedAt: number; endedAt?: number; began?: number; accepted?: boolean; outcome?: { result?: unknown; error?: string }; status?: string; error?: string };
export interface Env { CODEMODE_SANDBOX: DurableObjectNamespace<CodemodeSandboxDurableObject>; AGENTS: DurableObjectNamespace<CamelAgent>; AI: Ai; LOADER: WorkerLoader; MODEL: string; API_TOKEN: string; TEST_MODEL?: string }
export const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
const canonical = (value: unknown): string => JSON.stringify(value && typeof value === "object" ? Array.isArray(value) ? value.map(item => JSON.parse(canonical(item))) : Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, JSON.parse(canonical(item))])) : value);
const reqKey = (id: string) => `request:${id}`;

export class CamelAgent extends DurableObject<Env> {
  private instanceId = crypto.randomUUID();
  private workspace = new Workspace({ storage: this.ctx.storage, backends: [new WorkerJavaScriptBackend({
    loader: this.env.LOADER, root: "/workspace", globalOutbound: null, onInterrupt: "fail",
    defaultTimeoutMs: 15_000, maxTimeoutMs: 30_000, maxCpuMs: 5_000, maxStdioBytes: 64 * 1024,
    maxResultBytes: 64 * 1024, retentionMs: 60_000, maxRetainedExecutions: 10,
  })] });
  private models = modelRuntime(this.env);
  private availableTools: ToolRegistration[] = [];
  private workspaceToolNames: string[] = [];
  private harness = new PiHarness({ defaults: { model: this.models.model },
    harness: async ({ storage, context, onWake }) => {
      await this.workspace.fs.mkdir("/workspace", { recursive: true });
      const registry = createRegistry();
      const computer = createPiTools({ workspace: this.workspace, root: "/workspace", assets: false,
        exec: { "worker-javascript": { description: "Run JavaScript against private files, without network access." } },
        execOutput: { maxBytes: 16 * 1024, maxLines: 300 },
      });
      const tools: ToolRegistration[] = computer.tools.map(tool => ({
        name: tool.name, description: tool.description, parameters: tool.parameters,
        replay: ["read", "ls", "find", "grep"].includes(tool.name) ? "safe" : "unsafe", executionMode: "sequential",
        execute: async (args, api, callContext) => {
          const result = await computer.execute({ id: api.callId, name: tool.name, arguments: args }, { abortSignal: callContext.abortSignal });
          return { output: result.content, isError: result.isError };
        },
      }));
      this.workspaceToolNames = tools.filter(tool => tool.name !== "exec").map(tool => tool.name);
      registry.install({ name: "camel.computer", tools, sections: [{ key: "computer", tag: false,
        render: () => "Your private persistent files are in /workspace. JavaScript execution has no network access." }] });
      registry.install({ name: "camel.human", tools: [askHuman] });
      registry.install(createCodemodeExtension({
        sandbox: new RemoteCodemodeSandbox({
          remote: () => this.env.CODEMODE_SANDBOX.getByName(this.ctx.id.toString()),
        }),
        // Keep provider calls outside the script's capability set.
        models: false,
      }));
      this.availableTools = registry.snapshot().tools().map(({ tool }) => tool);
      return Harness.open(storage, { models: this.models.models, registry, onWake,
        settings: { afterFailedRun: "withdraw", retry: { enabled: true, maxRetries: 2, baseDelayMs: 500 } },
      }, context);
    },
  });
  private lifecycle = Lifecycle.install(this).use(this.harness);
  private observer?: Promise<void>;
  private listeners = new Set<(cursor: number, event: unknown) => void>();
  private partial: AssistantMessage | null = null;
  private emittedText = "";
  private active?: string;
  private serial: Promise<unknown> = Promise.resolve();
  private pendingWaits = new Set<string>();
  private admission: Promise<unknown> = Promise.resolve();
  private eventsProcessed: Promise<void> = Promise.resolve();

  private async records() { return [...(await this.ctx.storage.list<RequestRecord>({ prefix: "request:" })).values()]; }
  private async config() {
    if (await this.ctx.storage.get("deleted")) throw Object.assign(new Error("Agent deleted"), { status: 410 });
    const config = await this.ctx.storage.get<Config>("configuration");
    if (!config) throw Object.assign(new Error("Agent not found"), { status: 404 });
    return config;
  }
  private async emit(event: unknown) {
    const work = this.serial.then(async () => {
      const cursor = (await this.ctx.storage.get<number>("cursor") ?? 1) + 1;
      await this.ctx.storage.put("cursor", cursor);
      for (const listener of this.listeners) listener(cursor, event);
    });
    this.serial = work.catch(() => {}); await work;
  }
  private lastEntry = 0;
  private messageText = new Map<number, string>();
  private async observe() {
    return this.observer ??= (async () => {
      const watch = await this.harness.session().watch();
      // The initial window is a snapshot, not a batch of new messages.
      this.lastEntry = Math.max(0, ...watch.value.entries.map(entry => Number(entry.id)));
      const live = watch.value.docs["pi.live"] as LiveState | undefined;
      this.partial = live?.generation?.message as AssistantMessage ?? null;
      this.active = await this.requestForInputs(live?.run?.inputs ?? []);
      watch.start(async call => {
        if (call.kind !== "value") return;
        const processing = this.eventsProcessed.then(() => this.onView(call.value));
        this.eventsProcessed = processing.catch(() => {});
        return processing;
      });
    })();
  }
  private async requestForInputs(inputs: readonly number[]): Promise<string | undefined> {
    const pi = await this.harness.pi();
    for (const input of inputs) {
      const submission = await pi.submission(input as never, BACKGROUND_CONTEXT);
      const status = await submission?.status(BACKGROUND_CONTEXT);
      if (status?.requestId) return status.requestId;
    }
  }
  private async projectMessage(id: string, message: Message, ended: boolean) {
    if (message.role === "assistant") {
      const before = this.messageText.get(message.timestamp);
      if (before === undefined) await this.emit({ type: "event", requestId: id, event: { type: "message_start", message } });
      const text = message.content.filter(part => part.type === "text").map(part => part.text).join("");
      const delta = text.startsWith(before ?? "") ? text.slice((before ?? "").length) : "";
      this.messageText.set(message.timestamp, text);
      if (this.messageText.size > 100) this.messageText.delete(this.messageText.keys().next().value!);
      if (delta) await this.emit({ type: "event", requestId: id, event: {
        type: "message_update", message, assistantMessageEvent: { type: "text_delta", delta, partial: message },
      } });
    }
    if (ended) await this.emit({ type: "event", requestId: id, event: { type: "message_end", message } });
  }
  private async onView(view: ConversationView) {
    // Input labels retain attribution when several turns share one callback.
    for (const entry of view.entries) {
      if (Number(entry.id) <= this.lastEntry) continue;
      if (entry.kind === "camel.prompt") this.active = (entry.data as { requestId: string }).requestId;
      if (this.active) for (const message of entry.model ?? []) await this.projectMessage(this.active, message, true);
      this.lastEntry = Number(entry.id);
    }
    const live = view.docs["pi.live"] as LiveState | undefined;
    const id = await this.requestForInputs(live?.run?.inputs ?? []);
    this.partial = live?.generation?.message as AssistantMessage ?? null;
    if (id) {
      this.active = id;
      const record = await this.ctx.storage.get<RequestRecord>(reqKey(id));
      if (record && !record.began) { record.began = Date.now(); await this.ctx.storage.put(reqKey(id), record); }
      if (this.partial) await this.projectMessage(id, this.partial, false);
    } else this.active = undefined;
  }
  private track(id: string) {
    if (this.pendingWaits.has(id)) return;
    this.pendingWaits.add(id);
    this.ctx.waitUntil(this.settle(id, 0).catch(() => {}).finally(() => this.pendingWaits.delete(id)));
  }
  private async settle(id: string, waitMs: number): Promise<RequestRecord> {
    const record = await this.ctx.storage.get<RequestRecord>(reqKey(id));
    if (!record) throw Object.assign(new Error("Unknown request"), { status: 404 });
    if (record.state === "completed") return record;
    try {
      const result = await this.harness.wait(id, waitMs ? { signal: AbortSignal.timeout(waitMs) } : undefined);
      // Pi wakes result waiters as it commits; let its queued event batches reach
      // the adapter before exposing completion to an SDK stream.
      await new Promise(resolve => setTimeout(resolve, 0));
      await this.eventsProcessed;
      const current = await this.ctx.storage.get<RequestRecord>(reqKey(id));
      if (current?.state === "completed") return current;
      const outcome = result.status === "done" ? { result: { reply: result.text ?? "" } }
        : { error: result.reason ?? "Model operation failed" };
      const completed: RequestRecord = { ...record, state: "completed", endedAt: Date.now(), outcome,
        status: result.status === "done" ? "completed" : "failed", ...(result.status !== "done" ? { error: result.reason ?? "Model operation failed" } : {}) };
      let changed = false;
      const terminal = await this.ctx.storage.transaction(async tx => {
        const latest = await tx.get<RequestRecord>(reqKey(id));
        if (latest?.state === "completed") return latest;
        await tx.put(reqKey(id), completed); changed = true; return completed;
      });
      if (changed) await this.emit({ type: "response", id, outcome });
      return terminal;
    } catch (error) {
      if (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name)) return record;
      throw error;
    }
  }
  private async submit(input: unknown) {
    const result = this.admission.then(() => this.admit(input));
    this.admission = result.catch(() => {});
    return result;
  }
  private async admit(input: unknown) {
    await this.config();
    const request = object(input, ["id", "method", "params"]);
    const id = boundedText(request.id, "id", 80);
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new BadRequest("Invalid request id");
    if (request.method === "abort") {
      const params = object(request.params ?? {}, ["queued"]);
      if (params.queued !== undefined && params.queued !== "cancel") throw new BadRequest("Only queued cancel is supported");
      const fingerprint = canonical({ method: "abort", params });
      const previous = await this.ctx.storage.get<RequestRecord>(reqKey(id));
      if (previous && previous.fingerprint !== fingerprint) throw Object.assign(new Error("Request id reused with different input"), { status: 409 });
      if (previous?.state === "completed") return previous;
      await this.harness.session().abort();
      await this.state();
      const record: RequestRecord = { id, method: "abort", fingerprint, state: "completed", startedAt: Date.now(), endedAt: Date.now(), outcome: { result: { aborted: true } } };
      await this.ctx.storage.put(reqKey(id), record); await this.emit({ type: "response", id, outcome: record.outcome });
      return record;
    }
    if (request.method !== "prompt") throw new BadRequest("Only prompt and abort requests are implemented");
    const params = object(request.params, ["text", "allowDisconnected", "history", "metadata"]);
    const text = boundedText(params.text, "text", 24 * 1024);
    if (params.history !== undefined && params.history !== "none") throw new BadRequest("Only history:none is supported; use the history endpoint for durable messages");
    const fingerprint = canonical({ method: request.method, params });
    const old = await this.ctx.storage.get<RequestRecord>(reqKey(id));
    if (old && old.fingerprint !== fingerprint) throw Object.assign(new Error("Request id reused with different input"), { status: 409 });
    if (old?.state === "completed") return old;
    const record: RequestRecord = old ?? { id, method: "prompt", params, ...(params.metadata !== undefined ? { metadata: params.metadata } : {}), fingerprint, state: "running", startedAt: Date.now() };
    await this.ctx.storage.put(reqKey(id), record);
    await this.observe();
    // No successful acceptance response until Pi has durably recorded the input.
    await this.harness.submit(text, { operationId: id, entry: { kind: "camel.prompt", data: { requestId: id } } });
    const accepted = await this.ctx.storage.transaction(async tx => {
      const latest = await tx.get<RequestRecord>(reqKey(id)) ?? record;
      const accepted = { ...latest, accepted: true };
      await tx.put(reqKey(id), accepted); return accepted;
    });
    this.track(id);
    return accepted;
  }
  private async state() {
    const records = await this.records();
    await Promise.all(records.filter(record => record.state === "running").slice(0, 100).map(record => this.settle(record.id, 1)));
    return { cursor: await this.ctx.storage.get<number>("cursor") ?? 1, requests: await this.records(),
      ...(this.env.TEST_MODEL === "1" ? { localInstanceId: this.instanceId } : {}) };
  }
  private async history(url: URL) {
    const pi = await this.harness.pi(), root = await pi.root(BACKGROUND_CONTEXT);
    const messages: Message[] = [];
    let cursor;
    do {
      const page = await root.entries({ order: "ascending" }, 256, cursor, BACKGROUND_CONTEXT);
      for (const entry of page.items) messages.push(...entry.model ?? []);
      cursor = page.next;
    } while (cursor !== undefined);
    if (!url.searchParams.has("limit") && !url.searchParams.has("before")) return { messages };
    const before = Math.min(messages.length, Math.max(0, Number(url.searchParams.get("before") ?? messages.length)));
    const start = Math.max(0, before - Math.min(1000, Math.max(1, Number(url.searchParams.get("limit") ?? 100))));
    return { entries: messages.slice(start, before).map((message, offset) => ({ index: start + offset, message })), next: start || null, total: messages.length };
  }
  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url), path = url.pathname;
      if (path === "/configuration" && request.method === "PUT") {
        const incoming = await body(request) as Config;
        const old = await this.ctx.storage.get<Config>("configuration");
        if (await this.ctx.storage.get("deleted")) return json({ error: "Agent deleted" }, 410);
        if (old && incoming.revision < old.revision) return json(old);
        const model = this.models.resolve(incoming.config.model);
        if (old && canonical(old.config) !== canonical(incoming.config) && await this.harness.session().busy()) return json({ error: "Agent is busy" }, 409);
        const pi = await this.harness.pi(), root = await pi.root(BACKGROUND_CONTEXT);
        const disabled = [
          ...(incoming.config.codeMode === false ? ["exec", "codemode"] : []),
          ...(incoming.config.fileTools === false ? this.workspaceToolNames : []),
        ];
        const enabled = this.availableTools.filter(tool => !disabled.includes(tool.name));
        await root.configure({ model: { provider: model.provider, modelId: model.id }, instructions: incoming.config.systemPrompt ?? "",
          thinkingLevel: incoming.config.thinkingLevel as never,
          tools: enabled, modelTools: enabled,
        }, BACKGROUND_CONTEXT);
        await this.ctx.storage.put("configuration", incoming);
        await this.observe();
        return json(incoming);
      }
      if (request.method === "DELETE" && path === "/") {
        const deletion = this.admission.then(async () => {
          await this.ctx.storage.put("deleted", true);
          await this.harness.session().abort();
          for (const listener of this.listeners) listener(0, null);
          return json({ deleted: true });
        });
        this.admission = deletion.catch(() => {});
        return deletion;
      }
      await this.config();
      if (path === "/configuration" && request.method === "GET") return json(await this.config());
      if (path === "/state" && request.method === "GET") return json(await this.state());
      if (path === "/requests" && request.method === "POST") return json(await this.submit(await body(request)), 202);
      if (path.startsWith("/requests/") && request.method === "GET") {
        const wait = Math.max(1, Math.min(25000, Number(url.searchParams.get("wait") ?? 0) * 1000));
        return json(await this.settle(decodeURIComponent(path.slice(10)), wait));
      }
      if (path === "/history" && request.method === "GET") return json(await this.history(url));
      if (path === "/inputs" && request.method === "GET") {
        const pi = await this.harness.pi(), root = await pi.root(BACKGROUND_CONTEXT);
        const doc = await pi.snapshot(HumanInputs, root.id, BACKGROUND_CONTEXT);
        return json(Object.entries(doc?.requests ?? {}).filter(([, item]) => item.answer === undefined)
          .map(([id, item]) => ({ id, question: item.question })));
      }
      if (path.startsWith("/inputs/") && request.method === "POST") {
        const id = decodeURIComponent(path.slice(8));
        const input = object(await body(request), ["answer"]);
        const answer = boundedText(input.answer, "answer", 4096);
        const pi = await this.harness.pi(), root = await pi.root(BACKGROUND_CONTEXT);
        await root.commit(async tx => {
          const doc = await tx.doc(HumanInputs, root.id);
          const pending = doc.requests[id];
          if (!pending) throw Object.assign(new Error("Unknown input"), { status: 404 });
          if (pending.answer !== undefined && pending.answer !== answer) throw Object.assign(new Error("Already answered"), { status: 409 });
          pending.answer = answer;
        }, BACKGROUND_CONTEXT);
        return json({ answered: true });
      }
      if (path === "/abort" && request.method === "POST") { await this.harness.session().abort(); await this.state(); return json({ aborted: true }); }
      if (path === "/events" && request.method === "GET") return this.events();
      if (path === "/exec" && request.method === "POST") {
        const input = object(await body(request), ["source"]);
        const source = boundedText(input.source, "source", 24 * 1024);
        await this.workspace.fs.mkdir("/workspace", { recursive: true });
        const run = await this.workspace.runtime.exec(source, { backend: "worker-javascript", cwd: "/workspace", encoding: "utf8" });
        return json(await run.result());
      }
      if (path.startsWith("/files/") && ["GET", "PUT"].includes(request.method)) {
        const file = workspacePath(decodeURIComponent(path.slice(7)).replace(/^workspace\//, ""));
        if (request.method === "GET") {
          const stat = await this.workspace.fs.stat(file);
          if (stat.size > 1024 * 1024) throw new BadRequest("File read exceeds 1 MiB");
          return new Response(await this.workspace.fs.readFile(file, {}), { headers: { "content-type": "application/octet-stream", "cache-control": "no-store" } });
        }
        const chunks: Uint8Array[] = []; let size = 0;
        const reader = request.body?.getReader();
        if (reader) try {
          for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.length;
            if (size > 1024 * 1024) { await reader.cancel(); throw new BadRequest("File write exceeds 1 MiB"); } chunks.push(value); }
        } finally { reader.releaseLock(); }
        const buffer = new Uint8Array(size); let offset = 0;
        for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.length; }
        await this.workspace.fs.mkdir(file.slice(0, file.lastIndexOf("/")), { recursive: true });
        await this.workspace.fs.writeFile(file, buffer);
        return json({ path: file, version: Date.now(), size: buffer.byteLength, contentType: request.headers.get("content-type") ?? "application/octet-stream" });
      }
      return json({ error: "Unsupported backend operation" }, 404);
    } catch (error) {
      const status = error instanceof BadRequest ? 400 : (error as { status?: number }).status ?? ((error as { code?: string }).code === "ENOENT" ? 404 : 500);
      return json({ error: status >= 500 ? "Backend operation failed" : error instanceof Error ? error.message : "Backend failure" }, status);
    }
  }
  private async events(): Promise<Response> {
    await this.observe();
    const state = await this.state();
    const encoder = new TextEncoder(); let heartbeat: ReturnType<typeof setInterval>; let cleanup = () => {};
    const stream = new ReadableStream<Uint8Array>({
      start: controller => {
        let closed = false;
        const send = (cursor: number, event: unknown) => {
          if (closed) return;
          if (cursor === 0 || (controller.desiredSize ?? 0) <= 0) { cleanup(); controller.close(); return; }
          controller.enqueue(encoder.encode(`id: ${cursor}\ndata: ${JSON.stringify(event)}\n\n`));
        };
        cleanup = () => { if (closed) return; closed = true; clearInterval(heartbeat); this.listeners.delete(send); };
        this.listeners.add(send);
        controller.enqueue(encoder.encode('event: ready\ndata: {}\n\n'));
        send(state.cursor, { type: "snapshot", cursor: state.cursor, requestId: this.active ?? null, turn: this.active ? { start: null, count: 0, messages: [], partial: this.partial } : null });
        heartbeat = setInterval(() => {
          if (closed) return;
          if ((controller.desiredSize ?? 0) <= 0) { cleanup(); controller.close(); return; }
          controller.enqueue(encoder.encode(': heartbeat\n\n'));
        }, 10_000);
      },
      cancel() { cleanup(); },
    }, { highWaterMark: 64 });
    return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
  }
}
