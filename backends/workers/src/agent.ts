import { DurableObject } from "cloudflare:workers";
import { type Message, type AssistantMessage } from "@earendil-works/pi-ai";
import {
  Harness,
  createRegistry,
  type ToolRegistration,
  type ConversationView,
  type LiveState,
  defineTool,
} from "@earendil-works/pi-durable";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { RemoteCodemodeSandbox } from "@earendil-works/pi-codemode/portable";
import { isolatedSandboxRemote } from "../codemode/routing.ts";
import type { CodemodeSandboxDurableObject } from "@earendil-works/pi-codemode/cloudflare";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { PiHarness } from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";
import {
  BadRequest,
  boundedText,
  object,
  body,
  workspacePath,
} from "./validation.ts";
import {
  computerTool,
  computerParameters,
  type ComputerBindings,
} from "./computers/tool.ts";
import { compile } from "@earendil-works/pi-schema";
import { askHuman, HumanInputs } from "./human.ts";
import { obj, str, opt } from "@earendil-works/pi-schema";
import {
  Directory,
  reserveTurn,
  settleTurn,
  releaseTurn,
  type ControlEnv,
  type TurnReceipt,
} from "./control.ts";
import {
  volumeTools,
  handleAgentFileRequest,
  handleAgentFilesRoute,
  type FileBindings,
} from "./files.ts";
import {
  calendarInput,
  nextCalendar,
  calendarPrompt,
  type Calendar,
} from "../../../src/calendar.ts";
import type { TenantAdmission } from "./tenant.ts";
import { imageReferenceInput, type ImageRef } from "./images.ts";
import { eventFrame, negotiateEvents, EVENT_PROTOCOL } from "./live-transport.ts";
import { attachedComputerTools } from "./computers/agent-tools.ts";
import { ComputerService, inheritComputer, type ComputerEnv } from "./computers/service.ts";
import type { AdminEnv } from "./admin-api.ts";
import type { MediaBindings } from "./media-api.ts";
import { newSchedule, scheduleDeliveries, queueScheduleEmail, publishScheduleEmails, type StoredSchedule as Schedule } from "./schedules.ts";
import { nextOccurrence, retryable, RETRY_DELAYS_MS } from "./schedule-policy.ts";
import { metric, safeError, errorClass } from "./observability.ts";
import { modelRuntime } from "./model.ts";
import { meterProvider, applyModelReceipt, type ModelReceipt } from "./model-metering.ts";
import { keyServices, type KeyEnv } from "./security-services.ts";
import type { AccountEnv } from "./account-services.ts";
import type { BillingEnv } from "./billing-routes.ts";
import { runAdmission } from "./admission.ts";
import { actorInput, bucketInput, spendInput } from "./security-policy.ts";
import { writtenFile, presentedFile, fileOutputs, releasePresentedFiles } from "./file-output.ts";

type Config = {
  id: string;
  tenantId: string;
  revision: number;
  expiresAt: number | null;
  config: {
    model?: string;
    systemPrompt?: string;
    name?: string;
    fileTools?: boolean;
    codeMode?: boolean;
    thinkingLevel?: string;
    builtins?: string[];
    delegate?: { agents?: string[] };
    mounts?: unknown[];
    subject?: string;
    context?: Record<string, unknown>;
    bucket?: string;
    keyScope?: string;
    spendLimit?: number;
  };
};
type RequestRecord = {
  id: string;
  method: string;
  params?: Record<string, unknown>;
  metadata?: unknown;
  fingerprint: string;
  billing?: { tenantId: string; agentId: string; model?: string };
  state: "running" | "completed";
  startedAt: number;
  endedAt?: number;
  began?: number;
  accepted?: boolean;
  outcome?: { result?: unknown; error?: string };
  status?: string;
  error?: string;
};
export interface Env extends ComputerBindings, ControlEnv, FileBindings, KeyEnv, AccountEnv, BillingEnv, ComputerEnv, MediaBindings, AdminEnv {
  TENANTS: DurableObjectNamespace<TenantAdmission>;
  RATE_LIMITER?: RateLimit;
  CODEMODE_SANDBOX: DurableObjectNamespace<CodemodeSandboxDurableObject>;
  AGENTS: DurableObjectNamespace<CamelAgent>;
  AI: Ai;
  MODEL: string;
  API_TOKEN: string;
  TEST_MODEL?: string;
  TEST_MODEL_BASE_URL?: string;
  TEST_TURN_COST_MICROS?: string;
  TENANT_MAX_ACTIVE?: string;
  SCHEDULE_EMAIL_FROM?: string;
  SCHEDULE_OPERATOR_TENANTS?: string;
}
export const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "cache-control": "no-store" } });
const canonical = (value: unknown): string =>
  JSON.stringify(
    value && typeof value === "object"
      ? Array.isArray(value)
        ? value.map((item) => JSON.parse(canonical(item)))
        : Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, item]) => [key, JSON.parse(canonical(item))]),
          )
      : value,
  );
type BillingReceipt = TurnReceipt;
type Child = {
  id: string;
  key: string;
  requestId: string;
  task: string;
  createdAt: number;
};
const reqKey = (id: string) => `request:${id}`;

export class CamelAgent extends DurableObject<Env> {
  private instanceId = crypto.randomUUID();
  private models = modelRuntime(
    this.env,
    async () => (await this.config()).tenantId,
    provider => meterProvider(provider, this.env, async () => {
      const conf = await this.config();
      const request = this.active ? await this.ctx.storage.get<RequestRecord>(reqKey(this.active)) : undefined;
      return { tenant: conf.tenantId, agent: conf.id, requestId: this.active,
        subject: conf.config.subject, context: conf.config.context, bucket: request?.params?.bucket as string | undefined ?? conf.config.bucket,
        actor: request?.params?.actor as string | undefined,
        keyScope: conf.config.keyScope, spendLimit: (request?.params?.spendLimit as {usd?: number} | undefined)?.usd, platform: this.env.TEST_MODEL !== "1" };
    }, async receipt => {
      const key = `model-billing:${receipt.event.id}`;
      await this.ctx.storage.put(key, receipt);
      await applyModelReceipt(this.env, receipt);
      await this.ctx.storage.delete(key);
    }),
  );
  private availableTools: ToolRegistration[] = [];
  private computerSerial: Promise<unknown> = Promise.resolve();
  private serializeComputer<T>(run: () => Promise<T>): Promise<T> {
    const next = this.computerSerial.then(run);
    this.computerSerial = next.catch(() => {});
    return next;
  }
  private async computerNames() {
    if (!this.env.HYPERDRIVE) return new Set<string>();
    const conf = await this.config();
    return new Set((await new ComputerService(this.env, conf.tenantId).tools(conf.id)).map(tool => tool.name));
  }
  private async refreshComputerTools() {
    const conf = await this.config();
    const names = await this.computerNames();
    const pi = await this.harness.pi(), root = await pi.root(BACKGROUND_CONTEXT);
    const enabled = this.availableTools.filter(tool => {
      if (/^(computer_|browser_)/.test(tool.name)) return names.has(tool.name);
      if (conf.config.codeMode === false && ["exec","codemode"].includes(tool.name)) return false;
      return conf.config.fileTools !== false || !this.workspaceToolNames.includes(tool.name);
    });
    await root.configure({ tools: enabled, modelTools: enabled }, BACKGROUND_CONTEXT);
  }
  private workspaceToolNames: string[] = [];
  // Pi can reopen its Harness after a storage failure without replacing this
  // agent. Keep admission here so old remote work still occupies its slots.
  private readonly sandboxRemote = isolatedSandboxRemote({
    agentKey: this.ctx.id.toString(),
    getByName: (key) => this.env.CODEMODE_SANDBOX.getByName(key),
    maxConcurrent: 4,
  });
  private harness = new PiHarness({
    defaults: { model: this.models.model },
    harness: async ({ storage, context, onWake }) => {
      const registry = createRegistry();
      // User files live in the volume DO/R2; code runs in the separate sandbox.
      const templates = volumeTools(
        this.env,
        "_uninitialized",
        "_uninitialized",
      );
      const tools: ToolRegistration[] = templates.map((tool, index) => ({
        ...tool,
        execute: async (args, api, context) => {
          const config = await this.config();
          const impl = volumeTools(
            this.env,
            config.tenantId,
            config.id,
            async () => (config.config.mounts as never) ?? [],
            async (file, volumePath) => {
              const requestId = await this.fileRequestId();
              await presentedFile(this.ctx.storage, this.env, {
                requestId, callId: api.callId, tenant: config.tenantId,
                origin: await this.ctx.storage.get<string>("file-origin"),
              }, file, volumePath, event => this.emit(event));
            },
            async file => writtenFile(this.ctx.storage, await this.fileRequestId(), file),
          )[index];
          return impl.execute(args as never, api, context);
        },
      }));
      this.workspaceToolNames = tools.map((tool) => tool.name);
      registry.install({
        name: "camel.files",
        tools,
        sections: [
          {
            key: "files",
            tag: false,
            render: () =>
              "Your persistent files are in /workspace, backed by an ordered volume. Use read, write and ls.",
          },
        ],
      });
      registry.install({ name: "camel.human", tools: [askHuman] });
      registry.install({ name: "camel.computers", tools: attachedComputerTools(this.env, () => this.config(), run => this.serializeComputer(async () => { try { return await run(); } finally { await this.arm(); } })) });
      registry.install({
        name: "camel.delegation",
        tools: [
          defineTool({
            name: "delegate",
            description:
              "Create a durable child agent, run its task and return the result.",
            parameters: obj({
              task: str({ maxLength: 24000 }),
              agent: opt(str({ maxLength: 80 })),
            }),
            replay: "safe",
            execute: async (input, api) => {
              const child = await this.delegate(
                input.task,
                String(api.taskId),
                input.agent,
              );
              const childAgent = this.env.AGENTS.getByName(child.id);
              for (;;) {
                const response = await childAgent.fetch(
                  new Request(
                    `https://agent/requests/${child.requestId}?wait=25`,
                  ),
                );
                if (!response.ok) throw new Error("Child agent unavailable");
                const record = (await response.json()) as RequestRecord;
                if (record.state === "completed")
                  return {
                    output: [
                      {
                        type: "text" as const,
                        text: JSON.stringify(record.outcome),
                      },
                    ],
                  };
              }
            },
          }),
        ],
      });
      registry.install({
        name: "camel.linux",
        tools: [computerTool(this.env, this.ctx.id.toString())],
      });
      registry.install(
        createCodemodeExtension({
          sandbox: new RemoteCodemodeSandbox({
            remote: this.sandboxRemote,
          }),
          // Keep provider calls outside the script's capability set.
          models: false,
        }),
      );
      this.availableTools = registry
        .snapshot()
        .tools()
        .map(({ tool }) => tool);
      return Harness.open(
        storage,
        {
          models: this.models.models,
          registry,
          onWake,
          settings: {
            afterFailedRun: "withdraw",
            retry: { enabled: true, maxRetries: 2, baseDelayMs: 500 },
          },
        },
        context,
      );
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

  private async records() {
    return [
      ...(
        await this.ctx.storage.list<RequestRecord>({ prefix: "request:" })
      ).values(),
    ].sort((a, b) => a.startedAt - b.startedAt);
  }
  private async config() {
    if (await this.ctx.storage.get("deleted"))
      throw Object.assign(new Error("Agent deleted"), { status: 410 });
    const config = await this.ctx.storage.get<Config>("configuration");
    if (!config)
      throw Object.assign(new Error("Agent not found"), { status: 404 });
    if (config.expiresAt && config.expiresAt <= Date.now())
      throw Object.assign(new Error("Agent expired"), { status: 410 });
    return config;
  }
  private async emit(event: unknown) {
    const work = this.serial.then(async () => {
      const cursor = ((await this.ctx.storage.get<number>("cursor")) ?? 1) + 1;
      await this.ctx.storage.put("cursor", cursor);
      for (const listener of this.listeners) listener(cursor, event);
      for (const socket of this.ctx.getWebSockets()) {
        try {
          socket.send(eventFrame(event, cursor));
        } catch {
          socket.close(1011, "Send failed");
        }
      }
    });
    this.serial = work.catch(() => {});
    await work;
  }
  private lastEntry = 0;
  private messageText = new Map<number, string>();
  private async observe() {
    return (this.observer ??= (async () => {
      const watch = await this.harness.session().watch();
      // The initial window is a snapshot, not a batch of new messages.
      this.lastEntry = Math.max(
        0,
        ...watch.value.entries.map((entry) => Number(entry.id)),
      );
      const live = watch.value.docs["pi.live"] as LiveState | undefined;
      this.partial = (live?.generation?.message as AssistantMessage) ?? null;
      this.active = await this.requestForInputs(live?.run?.inputs ?? []);
      watch.start(async (call) => {
        if (call.kind !== "value") return;
        const processing = this.eventsProcessed.then(() =>
          this.onView(call.value),
        );
        this.eventsProcessed = processing.catch(() => {});
        return processing;
      });
    })());
  }
  private async requestForInputs(
    inputs: readonly number[],
  ): Promise<string | undefined> {
    const pi = await this.harness.pi();
    for (const input of inputs) {
      const submission = await pi.submission(
        input as never,
        BACKGROUND_CONTEXT,
      );
      const status = await submission?.status(BACKGROUND_CONTEXT);
      if (status?.requestId) return status.requestId;
    }
  }
  private async fileRequestId() {
    const watch = await this.harness.session().watch();
    const live = watch.value.docs["pi.live"] as LiveState | undefined;
    const id = await this.requestForInputs(live?.run?.inputs ?? []) ?? this.active;
    if (!id) throw new Error("Files can be presented only during a run");
    return id;
  }
  private async projectMessage(id: string, message: Message, ended: boolean) {
    if (message.role === "assistant") {
      const before = this.messageText.get(message.timestamp);
      if (before === undefined)
        await this.emit({
          type: "event",
          requestId: id,
          event: { type: "message_start", message },
        });
      const text = message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("");
      const delta = text.startsWith(before ?? "")
        ? text.slice((before ?? "").length)
        : "";
      this.messageText.set(message.timestamp, text);
      if (this.messageText.size > 100)
        this.messageText.delete(this.messageText.keys().next().value!);
      if (delta)
        await this.emit({
          type: "event",
          requestId: id,
          event: {
            type: "message_update",
            message,
            assistantMessageEvent: {
              type: "text_delta",
              delta,
              partial: message,
            },
          },
        });
    }
    if (ended)
      await this.emit({
        type: "event",
        requestId: id,
        event: { type: "message_end", message },
      });
  }
  private async onView(view: ConversationView) {
    // Input labels retain attribution when several turns share one callback.
    for (const entry of view.entries) {
      if (Number(entry.id) <= this.lastEntry) continue;
      if (entry.kind === "camel.prompt")
        this.active = (entry.data as { requestId: string }).requestId;
      if (this.active)
        for (const message of entry.model ?? [])
          await this.projectMessage(this.active, message, true);
      this.lastEntry = Number(entry.id);
    }
    const live = view.docs["pi.live"] as LiveState | undefined;
    const id = await this.requestForInputs(live?.run?.inputs ?? []);
    this.partial = (live?.generation?.message as AssistantMessage) ?? null;
    if (id) {
      this.active = id;
      const record = await this.ctx.storage.get<RequestRecord>(reqKey(id));
      if (record && !record.began) {
        record.began = Date.now();
        await this.ctx.storage.put(reqKey(id), record);
      }
      if (this.partial) await this.projectMessage(id, this.partial, false);
    } else this.active = undefined;
  }
  private track(id: string) {
    if (this.pendingWaits.has(id)) return;
    this.pendingWaits.add(id);
    this.ctx.waitUntil(
      this.settle(id, 0)
        .catch(() => {})
        .finally(() => this.pendingWaits.delete(id)),
    );
  }
  private async settle(id: string, waitMs: number): Promise<RequestRecord> {
    const record = await this.ctx.storage.get<RequestRecord>(reqKey(id));
    if (!record)
      throw Object.assign(new Error("Unknown request"), { status: 404 });
    if (record.state === "completed") return record;
    try {
      const result = await this.harness.wait(
        id,
        waitMs ? { signal: AbortSignal.timeout(waitMs) } : undefined,
      );
      // Pi wakes result waiters as it commits; let its queued event batches reach
      // the adapter before exposing completion to an SDK stream.
      await new Promise((resolve) => setTimeout(resolve, 0));
      await this.eventsProcessed;
      const current = await this.ctx.storage.get<RequestRecord>(reqKey(id));
      if (current?.state === "completed") return current;
      const usage = await this.usageForRequest(id);
      const stored = await this.ctx.storage.get<Config>("configuration");
      const outcome =
        result.status === "done"
          ? {
              result: {
                reply: result.text ?? "",
                usage: {
                  responses: usage.responses,
                  input: usage.inputTokens,
                  output: usage.outputTokens,
                  cacheRead: usage.cacheRead,
                  cacheWrite: usage.cacheWrite,
                  costUsd: usage.costMicros / 1_000_000,
                },
                servedModel: record.billing?.model ?? stored?.config.model,
                ...await fileOutputs(this.ctx.storage, id),
              },
            }
          : { error: result.reason ?? "Model operation failed" };
      let changed = false;
      const terminal = await this.ctx.storage.transaction(async (tx) => {
        const latest = await tx.get<RequestRecord>(reqKey(id));
        if (latest?.state === "completed") return latest;
        // Observation and acceptance can update this record while wait() is
        // pending. Merge under the transaction so their latest fields survive.
        const completed: RequestRecord = {
          ...(latest ?? current ?? record),
          state: "completed",
          endedAt: Date.now(),
          outcome,
          status: result.status === "done" ? "completed" : "failed",
          ...(result.status !== "done"
            ? { error: result.reason ?? "Model operation failed" }
            : {}),
        };
        const conf = await tx.get<Config>("configuration");
        if (conf)
          await tx.put(`billing:${id}`, {
            tenantId: record.billing?.tenantId ?? conf.tenantId,
            agentId: record.billing?.agentId ?? conf.id,
            requestId: id,
            costMicros: 0,
            modelMetered: true,
            activeMs: Math.max(0, Date.now() - (latest?.began ?? record.began ?? Date.now())),
            startedAt: record.startedAt,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            model: record.billing?.model ?? conf.config.model,
          } satisfies BillingReceipt);
        await tx.put(reqKey(id), completed);
        changed = true;
        return completed;
      });
      // Receipt and terminal state commit together. A lost PG acknowledgement
      // only replays this immutable receipt; money remains one PG transaction.
      await this.flushBilling();
      if (changed) {
        metric(this.env, "turn_metrics", { Turns: 1, TurnDurationMs: terminal.endedAt! - terminal.startedAt, ModelResponses: usage.responses }, { Outcome: terminal.status ?? "completed", ErrorClass: errorClass(terminal.error), Model: terminal.billing?.model ?? "unknown", Provider: (terminal.billing?.model ?? "unknown").split("/")[0] });
        await this.emit({ type: "response", id, outcome });
        if (id.startsWith("schedule-")) await publishScheduleEmails(this.env);
      }
      return terminal;
    } catch (error) {
      if (
        error instanceof Error &&
        ["AbortError", "TimeoutError"].includes(error.name)
      )
        return record;
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
    if (!/^[A-Za-z0-9_-]+$/.test(id))
      throw new BadRequest("Invalid request id");
    if (request.method === "abort") {
      const params = object(request.params ?? {}, ["queued"]);
      if (params.queued !== undefined && params.queued !== "cancel")
        throw new BadRequest("Only queued cancel is supported");
      const fingerprint = canonical({ method: "abort", params });
      const previous = await this.ctx.storage.get<RequestRecord>(reqKey(id));
      if (previous && previous.fingerprint !== fingerprint)
        throw Object.assign(
          new Error("Request id reused with different input"),
          { status: 409 },
        );
      if (previous?.state === "completed") return previous;
      await this.harness.session().abort();
      await this.state();
      const record: RequestRecord = {
        id,
        method: "abort",
        fingerprint,
        state: "completed",
        startedAt: Date.now(),
        endedAt: Date.now(),
        outcome: { result: { aborted: true } },
      };
      await this.ctx.storage.put(reqKey(id), record);
      await this.emit({ type: "response", id, outcome: record.outcome });
      return record;
    }
    if (request.method !== "prompt")
      throw new BadRequest("Only prompt and abort requests are implemented");
    const params = object(request.params, [
      "text",
      "allowDisconnected",
      "history",
      "metadata",
      "from",
      "attachments",
      "images",
      "bucket", "actor", "spendLimit",
    ]);
    if (params.bucket !== undefined) bucketInput(params.bucket);
    if (params.actor !== undefined) actorInput(params.actor);
    if (params.spendLimit !== undefined && spendInput(params.spendLimit) === null) throw new BadRequest('A run spendLimit must be {usd}');
    const text = boundedText(params.text, "text", 24 * 1024);
    if (
      params.history !== undefined &&
      !["none", "full"].includes(String(params.history))
    )
      throw new BadRequest("Invalid history");
    if (
      params.images !== undefined &&
      (!Array.isArray(params.images) || params.images.length > 8)
    )
      throw new BadRequest("At most eight image references per input");
    if (params.attachments !== undefined)
      throw new BadRequest(
        "Use file upload before prompting; attachment hydration is not implemented",
      );
    const fingerprint = canonical({ method: request.method, params });
    const old = await this.ctx.storage.get<RequestRecord>(reqKey(id));
    if (old && old.fingerprint !== fingerprint)
      throw Object.assign(new Error("Request id reused with different input"), {
        status: 409,
      });
    if (old?.state === "completed") return old;
    const conf = await this.config();
    const record: RequestRecord = old ?? {
      id,
      method: "prompt",
      billing: {
        tenantId: conf.tenantId,
        agentId: conf.id,
        model: conf.config.model,
      },
      params,
      ...(params.metadata !== undefined ? { metadata: params.metadata } : {}),
      fingerprint,
      state: "running",
      startedAt: Date.now(),
    };
    const prompt = params.images
      ? imageReferenceInput(text, params.images as ImageRef[], conf.tenantId)
      : text;
    await this.ctx.storage.put(reqKey(id), record);
    await this.arm(Date.now() + 1000);
    if (!old?.accepted) {
      const { accounts } = await keyServices(this.env);
      const limited = await accounts.runLimit(conf.tenantId);
      if (limited) {
        await this.ctx.storage.delete(reqKey(id));
        throw typeof limited === 'string' ? Object.assign(new Error(limited), { status: 402 }) : limited;
      }
      const { limit } = await accounts.billing.busyLimit(conf.tenantId);
      await runAdmission(this.env, conf.tenantId);
      if (
        !(await this.env.TENANTS.getByName(conf.tenantId).acquire(
          `${conf.id}:${id}`,
          Math.min(limit, Number(this.env.TENANT_MAX_ACTIVE ?? Number.MAX_SAFE_INTEGER)),
        ))
      ) {
        await this.ctx.storage.delete(reqKey(id));
        throw Object.assign(new Error("Tenant concurrency limit"), {
          status: 429,
        });
      }
      try {
        // Each provider attempt reserves its estimate before dispatch. Queueing a
        // request does not take a fixed-dollar hold.
        await reserveTurn(this.env, conf.tenantId, conf.id, id);
      } catch (error) {
        await this.env.TENANTS.getByName(conf.tenantId).release(
          `${conf.id}:${id}`,
        );
        if (
          [400, 402, 403, 404, 409].includes(
            (error as { status?: number }).status ?? 0,
          )
        )
          await this.ctx.storage.delete(reqKey(id));
        throw error;
      }
    }
    await this.ctx.storage.put(reqKey(id), record);
    await this.observe();
    // Attachment changes take effect on the next turn, including inherited ones.
    await this.refreshComputerTools();
    // No successful acceptance response until Pi has durably recorded the input.
    await this.harness.submit(prompt, {
      operationId: id,
      entry: { kind: "camel.prompt", data: { requestId: id } },
    });
    const accepted = await this.ctx.storage.transaction(async (tx) => {
      const latest = (await tx.get<RequestRecord>(reqKey(id))) ?? record;
      const accepted = { ...latest, accepted: true };
      await tx.put(reqKey(id), accepted);
      return accepted;
    });
    this.track(id);
    return accepted;
  }
  private async state() {
    const records = await this.records();
    await Promise.all(
      records
        .filter((record) => record.state === "running")
        .slice(0, 100)
        .map((record) => this.settle(record.id, 1)),
    );
    return {
      cursor: (await this.ctx.storage.get<number>("cursor")) ?? 1,
      requests: await this.records(),
      ...(this.env.TEST_MODEL === "1"
        ? { localInstanceId: this.instanceId }
        : {}),
    };
  }
  private async history(url: URL) {
    const pi = await this.harness.pi(),
      root = await pi.root(BACKGROUND_CONTEXT);
    const paged =
      url.searchParams.has("limit") || url.searchParams.has("before");
    const limit = Number(url.searchParams.get("limit") ?? 100);
    const beforeValue = url.searchParams.get("before"),
      before = beforeValue === null ? Infinity : Number(beforeValue);
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 1000 ||
      (before !== Infinity && (!Number.isInteger(before) || before < 0))
    )
      throw new BadRequest("Invalid history cursor or limit");
    const retained: { index: number; message: Message; bytes: number }[] = [];
    let cursor,
      total = 0,
      bytes = 0;
    do {
      const page = await root.entries(
        { order: "ascending" },
        256,
        cursor,
        BACKGROUND_CONTEXT,
      );
      for (const entry of page.items)
        for (const message of entry.model ?? []) {
          const index = total++;
          if (index >= before) continue;
          const size = new TextEncoder().encode(JSON.stringify(message)).length;
          retained.push({ index, message, bytes: size });
          bytes += size;
          if (paged && retained.length > limit)
            bytes -= retained.shift()!.bytes;
          if (bytes > 8 * 1024 * 1024 || (!paged && retained.length > 1000))
            throw Object.assign(
              new Error("History response too large; request a bounded page"),
              { status: 413 },
            );
        }
      cursor = page.next;
    } while (cursor !== undefined);
    if (!paged) return { messages: retained.map((item) => item.message) };
    const first = retained[0]?.index ?? 0;
    return {
      entries: retained.map(({ index, message }) => ({ index, message })),
      next: first || null,
      total,
    };
  }
  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url),
        path = url.pathname;
      if (path === "/configuration" && request.method === "PUT") {
        const incoming = (await body(request)) as Config;
        const mutation = this.admission.then(async () => {
          const old = await this.ctx.storage.get<Config>("configuration");
          if (await this.ctx.storage.get("deleted"))
            return json({ error: "Agent deleted" }, 410);
          if (old && incoming.revision < old.revision) return json(old);
          const model = this.models.resolve(incoming.config.model);
          if (
            old &&
            canonical(old.config) !== canonical(incoming.config) &&
            (await this.harness.session().busy())
          )
            return json({ error: "Agent is busy" }, 409);
          await this.ctx.storage.put("configuration", incoming);
          const pi = await this.harness.pi(),
            root = await pi.root(BACKGROUND_CONTEXT);
          const disabled = [
            ...(incoming.config.codeMode === false ? ["exec", "codemode"] : []),
            ...(incoming.config.fileTools === false
              ? this.workspaceToolNames
              : []),
          ];
          const names = await this.computerNames();
          const enabled = this.availableTools.filter(
            (tool) => !disabled.includes(tool.name) && (!/^(computer_|browser_)/.test(tool.name) || names.has(tool.name)),
          );
          await root.configure(
            {
              model: { provider: model.provider, modelId: model.id },
              instructions: incoming.config.systemPrompt ?? "",
              thinkingLevel: incoming.config.thinkingLevel as never,
              tools: enabled,
              modelTools: enabled,
            },
            BACKGROUND_CONTEXT,
          );
          await this.ctx.storage.put("configuration", incoming);
          await this.arm();
          await this.observe();
          return json(incoming);
        });
        this.admission = mutation.catch(() => {});
        return mutation;
      }
      if (request.method === "DELETE" && path === "/") {
        const deletion = this.admission.then(async () => {
          const conf = await this.ctx.storage.get<Config>("configuration");
          if (conf) await this.serializeComputer(() => new ComputerService(this.env, conf.tenantId).removeAgent(conf.id));
          await this.ctx.storage.put("deleted", true);
          await this.harness.session().abort();
          if (conf) await releasePresentedFiles(this.ctx.storage, this.env, conf.tenantId, conf.id);
          for (const listener of this.listeners) listener(0, null);
          return json({ deleted: true });
        });
        this.admission = deletion.catch(() => {});
        return deletion;
      }
      if (path === "/__computer" && request.method === "POST") {
        const input = await body(request) as any;
        const conf = input.operation === "sweep" ? await this.ctx.storage.get<Config>("configuration") : await this.config();
        if (!conf) return json({ error: "Agent not found" }, 404);
        if (input.tenant !== conf.tenantId) return json({error:"Forbidden"},403);
        return await this.serializeComputer(async () => {
          const service = new ComputerService(this.env, conf.tenantId);
          if (input.operation === "sweep") { await service.sweepAgent(conf.id); await this.arm(); return json({ swept: true }); }
          if (input.operation === "refresh") { await this.refreshComputerTools(); return json({ refreshed: true }); }
          if (input.operation === "remove") { const removed = await service.remove(conf.id); await this.refreshComputerTools(); return json(removed); }
          if (input.operation === "confirm-cleanup") return json(await service.confirmCleanup(conf.id));
          try { return json(await service.call(conf.id,input.operation,input.args??{},input.key)); }
          finally { await this.arm(); }
        });
      }
      await this.config();
      if (request.method === "POST" && ["/prompt", "/requests"].includes(path))
        await this.ctx.storage.put("file-origin", url.origin);
      if (path === "/schedule-deliveries" && request.method === "GET") {
        const conf = await this.config();
        return json(await scheduleDeliveries(this.env, conf.tenantId, conf.id));
      }
      if (
        path === "/__test/flush-billing" &&
        this.env.TEST_MODEL === "1" &&
        request.method === "POST"
      ) {
        await this.flushBilling(true);
        return json({
          pending: (await this.ctx.storage.list({ prefix: "billing:" })).size,
        });
      }
      if (
        path === "/__test/settlement-state" &&
        this.env.TEST_MODEL === "1" &&
        request.method === "GET"
      ) {
        return json({
          crashReached: !!(await this.ctx.storage.get("test:crash-reached")),
          pending: (await this.ctx.storage.list({ prefix: "billing:" })).size,
        });
      }
      if (
        path === "/__test/crash-next-settlement" &&
        this.env.TEST_MODEL === "1" &&
        request.method === "POST"
      ) {
        await this.ctx.storage.delete("test:crash-reached");
        await this.ctx.storage.put("test:crash-settlement", true);
        return json({ armed: true });
      }
      if (path === "/schedules" && request.method === "GET")
        return json([
          ...(await this.ctx.storage
            .list<Schedule>({ prefix: "schedule:" })
            .then((x) => [...x.values()].sort((a,b)=>a.dueAt-b.dueAt || a.id.localeCompare(b.id)))),
        ]);
      if (path === "/schedules" && request.method === "POST")
        return json(await this.createSchedule(await body(request)), 201);
      if (path.startsWith("/schedules/") && request.method === "DELETE") {
        const deleted = await this.ctx.storage.delete(
          `schedule:${decodeURIComponent(path.slice(11))}`,
        );
        await this.arm();
        return json({ deleted });
      }
      if (path === "/children" && request.method === "GET")
        return json([
          ...(await this.ctx.storage
            .list<Child>({ prefix: "child:" })
            .then((x) => x.values())),
        ]);
      if (path === "/children" && request.method === "POST") {
        const input = object(await body(request), ["task", "key", "agent"]);
        return json(
          await this.delegate(
            boundedText(input.task, "task", 24000),
            String(input.key ?? crypto.randomUUID()),
            input.agent as string | undefined,
          ),
          201,
        );
      }
      if (path === "/prompt" && request.method === "POST") {
        const input = object(await body(request), [
          "text",
          "idempotencyKey",
          "history",
          "metadata",
          "allowDisconnected",
          "from",
        ]);
        const { idempotencyKey, ...params } = input;
        return json(
          await this.submit({
            id: idempotencyKey ?? crypto.randomUUID(),
            method: "prompt",
            params,
          }),
          202,
        );
      }
      if (path === "/configuration" && request.method === "GET")
        return json(await this.config());
      if (path === "/state" && request.method === "GET")
        return json(await this.state());
      if (path === "/requests" && request.method === "POST")
        return json(await this.submit(await body(request)), 202);
      if (path.startsWith("/requests/") && request.method === "GET") {
        const wait = Math.max(
          1,
          Math.min(25000, Number(url.searchParams.get("wait") ?? 0) * 1000),
        );
        return json(
          await this.settle(decodeURIComponent(path.slice(10)), wait),
        );
      }
      if (path === "/history" && request.method === "GET")
        return json(await this.history(url));
      if (path === "/inputs" && request.method === "GET") {
        const pi = await this.harness.pi(),
          root = await pi.root(BACKGROUND_CONTEXT);
        const doc = await pi.snapshot(HumanInputs, root.id, BACKGROUND_CONTEXT);
        return json(
          Object.entries(doc?.requests ?? {})
            .filter(([, item]) => item.answer === undefined)
            .map(([id, item]) => ({ id, question: item.question })),
        );
      }
      if (path.startsWith("/inputs/") && request.method === "POST") {
        const id = decodeURIComponent(path.slice(8));
        const input = object(await body(request), ["answer"]);
        const answer = boundedText(input.answer, "answer", 4096);
        const pi = await this.harness.pi(),
          root = await pi.root(BACKGROUND_CONTEXT);
        await root.commit(async (tx) => {
          const doc = await tx.doc(HumanInputs, root.id);
          const pending = doc.requests[id];
          if (!pending)
            throw Object.assign(new Error("Unknown input"), { status: 404 });
          if (pending.answer !== undefined && pending.answer !== answer)
            throw Object.assign(new Error("Already answered"), { status: 409 });
          pending.answer = answer;
        }, BACKGROUND_CONTEXT);
        return json({ answered: true });
      }
      if (path === "/abort" && request.method === "POST") {
        await this.harness.session().abort();
        await this.state();
        return json({ aborted: true });
      }
      if (path === "/events" && request.method === "GET") {
        const selected = negotiateEvents(request); if (selected) return selected;
        return request.headers.get("upgrade")?.toLowerCase() === "websocket" ? this.webSocketEvents(request) : this.events();
      }
      if (path === "/computer" && request.method === "POST") {
        const inputBody = await body(request, 1100 * 1024);
        if (!compile(computerParameters).check(inputBody))
          throw new BadRequest("Invalid computer request");
        const { provider, ...input } = inputBody;
        const namespace =
          provider === "container"
            ? this.env.COMPUTER_CONTAINERS
            : this.env.COMPUTER_SANDBOXES;
        if (!namespace)
          return json({ error: "Optional computer is not configured" }, 501);
        return json(
          await namespace.getByName(this.ctx.id.toString()).operate(input),
        );
      }
      if(path==="/files"||path==="/links"||path.startsWith("/uploads/")) {
        const conf=await this.config();
        return (await handleAgentFilesRoute(request,this.env,conf.tenantId,conf.id,(conf.config.mounts??[]) as never,path))!;
      }
      if (path.startsWith("/files/")) {
        const conf = await this.config();
        return handleAgentFileRequest(
          request,
          this.env,
          conf.tenantId,
          conf.id,
          decodeURIComponent(path.slice(7)),
          conf.config.mounts as never,
        );
      }
      return json({ error: "Unsupported backend operation" }, 404);
    } catch (error) {
      const status =
        error instanceof BadRequest
          ? 400
          : ((error as { status?: number }).status ??
            ((error as { code?: string }).code === "ENOENT" ? 404 : 500));
      return json(
        {
          error:
            status >= 500
              ? "Backend operation failed"
              : error instanceof Error
                ? error.message
                : "Backend failure",
        },
        status,
      );
    }
  }
  private async usageForRequest(id: string) {
    const pi = await this.harness.pi(),
      root = await pi.root(BACKGROUND_CONTEXT);
    let cursor,
      active: string | undefined,
      inputTokens = 0,
      outputTokens = 0,
      cacheRead = 0,
      cacheWrite = 0,
      responses = 0,
      cost = 0;
    do {
      const page = await root.entries(
        { order: "ascending" },
        256,
        cursor,
        BACKGROUND_CONTEXT,
      );
      for (const entry of page.items) {
        if (entry.kind === "camel.prompt")
          active = (entry.data as { requestId: string }).requestId;
        if (active !== id) continue;
        for (const message of entry.model ?? [])
          if (message.role === "assistant") {
            responses++;
            inputTokens += message.usage.input;
            cacheRead += message.usage.cacheRead;
            cacheWrite += message.usage.cacheWrite;
            outputTokens += message.usage.output;
            cost += message.usage.cost.total;
          }
      }
      cursor = page.next;
    } while (cursor !== undefined);
    return {
      inputTokens,
      outputTokens,
      cacheRead,
      cacheWrite,
      responses,
      costMicros: Math.max(0, Math.round(cost * 1_000_000)),
    };
  }
  private async flushBilling(propagate = false) {
    for (const [key, receipt] of await this.ctx.storage.list<ModelReceipt>({ prefix: "model-billing:", limit: 100 })) {
      await applyModelReceipt(this.env, receipt);
      await this.ctx.storage.delete(key);
    }
    for (const [key, receipt] of await this.ctx.storage.list<BillingReceipt>({
      prefix: "billing:",
      limit: 100,
    })) {
      try {
        await settleTurn(this.env, receipt);
        if (await this.ctx.storage.get("test:crash-settlement")) {
          await this.ctx.storage.transaction(async (tx) => {
            await tx.delete("test:crash-settlement");
            await tx.put("test:crash-reached", true);
          });
          throw new Error(
            "Injected crash after PostgreSQL commit before DO acknowledgement",
          );
        }
        await this.env.TENANTS.getByName(receipt.tenantId).release(
          `${receipt.agentId}:${receipt.requestId}`,
        );
        await this.ctx.storage.delete(key);
      } catch (error) {
        await this.arm(Date.now() + 1000);
        if (propagate) throw error;
      }
    }
  }
  private async delegate(
    task: string,
    key: string,
    definition?: string,
  ): Promise<Child> {
    const conf = await this.config();
    const childKey = `${conf.id.slice(-24)}-${key.slice(-40)}`;
    const directory = new Directory(this.env, conf.tenantId);
    const base = definition ? await directory.get(definition) : null;
    if (definition && !base)
      throw Object.assign(new Error("Unknown delegate agent"), { status: 404 });
    if (
      definition &&
      conf.config.delegate?.agents &&
      !conf.config.delegate.agents.includes(definition)
    )
      throw Object.assign(new Error("Delegate is not allowed"), {
        status: 403,
      });
    const entry = await directory.upsert(
      {
        ...(base?.config ?? conf.config),
        ...((base?.config ?? conf.config).spendLimit !== undefined ? { spendLimit: { usd: (base?.config ?? conf.config).spendLimit } } : {}),
        name: `Child of ${conf.id}`,
        ttlSeconds: null,
      },
      childKey,
    );
    if ("failed" in entry)
      throw Object.assign(new Error(entry.error), { status: entry.status });
    await inheritComputer(this.env, conf.tenantId, conf.id, entry.id);
    const child: Child = {
      id: entry.id,
      key: childKey,
      requestId: `delegated-${key.slice(-60)}`,
      task,
      createdAt: Date.now(),
    };
    await this.ctx.storage.put(`child:${key}`, child);
    const response = await this.env.AGENTS.getByName(entry.id).fetch(
      new Request("https://agent/requests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: child.requestId,
          method: "prompt",
          params: { text: task },
        }),
      }),
    );
    if (!response.ok)
      throw Object.assign(new Error("Child submission failed"), {
        status: response.status,
      });
    return child;
  }
  private async createSchedule(raw: unknown): Promise<Schedule> {
    if ((await this.ctx.storage.list({prefix:"schedule:",limit:100})).size >= 100) throw new BadRequest("At most 100 schedules per agent");
    const conf=await this.config();
    const schedule=await newSchedule(this.env,conf.tenantId,conf.id,raw);
    await this.ctx.storage.put(`schedule:${schedule.id}`, schedule);
    await this.arm();
    return schedule;
  }
  private async arm(retry?: number) {
    const schedules = await this.ctx.storage.list<Schedule>({
      prefix: "schedule:",
      limit: 100,
    });
    const pendingBilling = (
      await this.ctx.storage.list({ prefix: "billing:", limit: 1 })
    ).size;
    const config = await this.ctx.storage.get<Config>("configuration");
    const next = Math.min(
      config?.expiresAt ?? Infinity,
      config ? await new ComputerService(this.env, config.tenantId).nextDeadline(config.id) ?? Infinity : Infinity,
      ...[...schedules.values()].map((item) => item.retryAt ?? item.dueAt),
      retry ?? Infinity,
      pendingBilling ? Date.now() + 5000 : Infinity,
    );
    if (Number.isFinite(next))
      await this.lifecycle.jobs.push({
        id: "camel-wake",
        fn: "camel-wake",
        time: Math.max(Date.now() + 1, next),
      });
  }
  async onStart() {
    // Pi restores its own work on startup. Restore the adapter's result/receipt
    // waiters too, so completion is billed without requiring a client poll.
    for (const record of await this.records())
      if (record.accepted && record.state !== "completed")
        this.track(record.id);
    if ((await this.ctx.storage.list({ prefix: "billing:", limit: 1 })).size)
      this.ctx.waitUntil(this.flushBilling());
  }
  async onJob(context: { job: { fn: string } }) {
    if (context.job.fn === "camel-wake") await this.wake();
  }
  private async wake() {
    const conf = await this.ctx.storage.get<Config>("configuration");
    if (conf) await this.serializeComputer(() => new ComputerService(this.env, conf.tenantId).sweepAgent(conf.id)).catch(() => console.error(JSON.stringify({ type: "computer_cleanup_failed", agent: conf.id })));
    if (conf?.expiresAt && conf.expiresAt <= Date.now()) {
      await this.ctx.storage.put("deleted", true);
      await this.harness.session().abort();
      // Unsettled turns are still charged from their durable receipts below.
      await this.flushBilling();
      return;
    }
    await this.flushBilling();
    for (const record of await this.records()) {
      if (record.accepted && record.state !== "completed")
        this.track(record.id);
      if (record.method === "prompt" && !record.accepted) {
        try {
          await this.submit({
            id: record.id,
            method: record.method,
            params: record.params,
          });
        } catch {}
      }
    }
    const now = Date.now();
    for (const [key, schedule] of await this.ctx.storage.list<Schedule>({
      prefix: "schedule:",
      limit: 100,
    })) {
      if ((schedule.retryAt ?? schedule.dueAt) > now) continue;
      try {
        const occurrence = `schedule-${schedule.id}-${schedule.dueAt}`;
        await queueScheduleEmail(this.env,schedule,occurrence);
        await this.submit({ id: occurrence, method: schedule.code === undefined ? "prompt" : "execute", params: schedule.code === undefined ? {
          text: schedule.calendar ? calendarPrompt(schedule.text!,schedule.calendar,schedule.dueAt) : schedule.text,
          allowDisconnected: true,
        } : { code: schedule.code, allowDisconnected: true } });
        if (schedule.email) await publishScheduleEmails(this.env);
        if (schedule.calendar || schedule.everySeconds) {
          delete schedule.retryAt;
          schedule.failures = 0;
          delete schedule.lastError;
          schedule.dueAt = nextOccurrence(schedule);
          await this.ctx.storage.put(key, schedule);
        } else await this.ctx.storage.delete(key);
      } catch (error) {
        const status = (error as {status?:number}).status;
        const attempt = (schedule.attempts ?? 0) + 1;
        const delay = retryable(status) ? RETRY_DELAYS_MS[attempt-1] : undefined;
        const next = schedule.calendar || schedule.everySeconds ? nextOccurrence(schedule) : undefined;
        schedule.lastError = safeError(error);
        schedule.lastErrorAt = Date.now();
        if (status === 404 || status === 410) await this.ctx.storage.delete(key);
        else if (delay !== undefined && (next === undefined || Date.now()+delay < next)) {
          schedule.attempts = attempt; schedule.retryAt = Date.now()+delay;
          await this.ctx.storage.put(key,schedule);
        } else if (next !== undefined) {
          schedule.failures = (schedule.failures??0)+1;
          schedule.attempts = 0; delete schedule.retryAt; schedule.dueAt = next;
          await this.ctx.storage.put(key,schedule);
        } else await this.ctx.storage.delete(key);
        metric(this.env,"schedule_delivery_failed",{ScheduleDeliveryFailures:1},{ErrorClass:errorClass(error instanceof Error?error.message:"")});
      }
    }
    await this.arm();
  }
  private async webSocketEvents(request: Request): Promise<Response> {
    await this.observe();
    const state = await this.state();
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    pair[1].send(eventFrame({}, undefined, "ready"));
    pair[1].send(eventFrame({ type: "snapshot", cursor: state.cursor, requestId: this.active ?? null, turn: this.active ? { start:null,count:0,messages:[],partial:this.partial } : null },state.cursor));
    const selected = request.headers.get("sec-websocket-protocol")?.split(",").map(x=>x.trim()).includes(EVENT_PROTOCOL);
    return new Response(null, { status: 101, webSocket: pair[0], headers: selected ? {"Sec-WebSocket-Protocol": EVENT_PROTOCOL} : {} });
  }
  async webSocketMessage(socket: WebSocket, _data: string | ArrayBuffer) { socket.close(1008,"Read-only event stream"); }
  async webSocketClose(socket: WebSocket, code: number) {
    socket.close(code, "Closed");
  }
  private async events(): Promise<Response> {
    await this.observe();
    const state = await this.state();
    const encoder = new TextEncoder();
    let heartbeat: ReturnType<typeof setInterval>;
    let cleanup = () => {};
    const stream = new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          let closed = false;
          const send = (cursor: number, event: unknown) => {
            if (closed) return;
            if (cursor === 0 || (controller.desiredSize ?? 0) <= 0) {
              cleanup();
              controller.close();
              return;
            }
            controller.enqueue(
              encoder.encode(
                `id: ${cursor}\ndata: ${JSON.stringify(event)}\n\n`,
              ),
            );
          };
          cleanup = () => {
            if (closed) return;
            closed = true;
            clearInterval(heartbeat);
            this.listeners.delete(send);
          };
          this.listeners.add(send);
          controller.enqueue(encoder.encode("event: ready\ndata: {}\n\n"));
          send(state.cursor, {
            type: "snapshot",
            cursor: state.cursor,
            requestId: this.active ?? null,
            turn: this.active
              ? { start: null, count: 0, messages: [], partial: this.partial }
              : null,
          });
          heartbeat = setInterval(() => {
            if (closed) return;
            if ((controller.desiredSize ?? 0) <= 0) {
              cleanup();
              controller.close();
              return;
            }
            controller.enqueue(encoder.encode(": heartbeat\n\n"));
          }, 10_000);
        },
        cancel() {
          cleanup();
        },
      },
      { highWaterMark: 64 },
    );
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
      },
    });
  }
}
