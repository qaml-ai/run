import { retriesModelError } from "./model-errors.ts";
import { modelCompactionSettings } from "./model-context.ts";
import { toolOutputExtension } from "./tool-output.ts";
import { refreshIdleLifetime } from "./idle-lifetime.ts";
import { forkSnapshot } from "./fork-snapshot.ts";
import { seedHistory, writeModelContext } from "./history-seed.ts";
import { assertContextRange, contextRangeExtension, contextRangeLimit } from "./context-range.ts";
import { workflowTools } from "./workflow.ts";
import { recordChildParent } from "./child-parent.ts";
import { RecentEvents } from "./recent-events.ts";
import { tenantRunCaps } from "./tenant-run-caps.ts";
import { toolCallSite } from "./tool-call-context.ts";
import { withMoneyMetrics } from "./money-metrics.ts";
import { DurableObject } from "cloudflare:workers";
import { type Message, type AssistantMessage } from "@earendil-works/pi-ai";
import {
  Harness,
  createRegistry,
  type ToolRegistration,
  type ConversationView,
  type LiveState,
  type Extension,
  defineTool,
  hook,
  GenerationTask,
} from "@earendil-works/pi-durable";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { SessionCodemodeSandbox } from "../codemode/sandbox.ts";
import { isolatedSandboxRemote } from "../codemode/routing.ts";
import type { CodemodeSandboxDurableObject } from "@earendil-works/pi-codemode/cloudflare";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
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
import {
  askHuman,
  askUser,
  answerHuman,
  bindHumanInput,
  sameHumanAnswer,
  systemHumanAnswer,
  humanInputExtension,
  cancelledHumanInput,
  humanInputView,
  HumanInputs,
  resumedHumanTools,
  type HumanInput,
} from "./human.ts";
import { answerList } from "./input-policy.ts";
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
  type Mount,
} from "./files.ts";
import {
  calendarInput,
  nextCalendar,
  calendarPrompt,
  type Calendar,
} from "../../../src/calendar.ts";
import type { TenantAdmission } from "./tenant.ts";
import { imageReferenceInput, type ImageRef } from "./images.ts";
import {
  PromptAttachments,
  attachmentInput,
  attachmentFiles,
  attachmentMessage,
} from "./prompt-attachments.ts";
import {
  eventFrame,
  negotiateEvents,
  EVENT_PROTOCOL,
} from "./live-transport.ts";
import { attachedComputerTools } from "./computers/agent-tools.ts";
import {
  ComputerService,
  inheritComputer,
  type ComputerEnv,
} from "./computers/service.ts";
import type { AdminEnv } from "./admin-api.ts";
import type { MediaBindings } from "./media-api.ts";
import {
  newSchedule,
  scheduleDeliveries,
  queueScheduleEmail,
  publishScheduleEmails,
  type StoredSchedule as Schedule,
} from "./schedules.ts";
import {
  nextOccurrence,
  retryable,
  RETRY_DELAYS_MS,
} from "./schedule-policy.ts";
import { metric, safeError, errorClass } from "./observability.ts";
import { modelRuntime } from "./model.ts";
import {
  meterProvider,
  applyModelReceipt,
  type ModelReceipt,
} from "./model-metering.ts";
import { keyServices, type KeyEnv } from "./security-services.ts";
import type { AccountEnv } from "./account-services.ts";
import { runAdmission } from "./admission.ts";
import { PromptPreparations } from "./prompt-admission.ts";
import { actorInput, bucketInput } from "./security-policy.ts";
import { MessageProjection } from "./message-projection.ts";
import { runtimePromptSections } from "./prompt-sections.ts";
import { toolResultFiles } from "./tool-output-files.ts";
import { projectRunFailure } from "./run-failure.ts";
import { RunProjection } from "./run-projection.ts";
import { requestView } from "./request-view.ts";
import { AgentHistory } from "./history.ts";
import type { AgentConfiguration } from "./api-contract.ts";
import { digest, configuration } from "./api-contract.ts";
import { configurationModelError } from "./default-model.ts";
import { MAX_OPEN_REQUESTS } from "./access-policy.ts";
import { follow as followLiveTurn, replay as replayEvents, type LiveTurn } from "./live-event-policy.ts";
import { AttachedTools } from "./attached-tools.ts";
import { prioritizedTools } from "./tool-priority.ts";
import { compatibleFileTools } from "./fs-tools.ts";
import { sourceTools, toolSourceViews, type SourceFailure } from "./tool-sources.ts";
import { Delegation } from "./delegation.ts";
import { resolveDefinition, provisionDefinition, configurationPatch } from "./definitions.ts";
import {
  resolveProviderKey,
  resolveCustomProviders,
} from "./model-credentials.ts";
import { resolveModelCredentials } from "./model-endpoints.ts";
import { decisionService, recordDecision } from "./decision-service.ts";
import { offersDecisions } from "./decision-runtime.ts";
import {
  hostExecutionTool,
  hostExecutionRequest,
  startHostExecution,
  admitHostExecution,
  waitHostExecution,
  abortHostExecution,
  executionParams,
  HOST_EXECUTION_TOOL,
} from "./host-execution.ts";
import { outputInput, schemaAccepts } from "./output-validation.ts";
import { runLimitsInput, modelSettingsRefusal } from "./model-policy.ts";
import {
  DelegationNotifications,
  DelegationWakeBudget,
  type RuntimeNotice,
  type NoticeDelivery,
  type NoticeRequest,
  type WakeDecision,
} from "./delegation-notifications.ts";
import type { ChildProgressReport } from "./delegation.ts";
import { senderExtension } from "./sender-extension.ts";
import { metadataInput, senderInput } from "./sender.ts";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { AgentRunLimits, type RuntimeLimit } from "./run-limits.ts";
import {
  DurableEventLog,
  runEventStream,
  enqueueTerminalEvents,
  acknowledgeTerminalEvent,
  TERMINAL_EVENTS_PREFIX,
  type TerminalEvents,
  type TerminalDelivery,
} from "./event-log.ts";
import { agentBuiltins } from "./agent-builtins.ts";
import { auxiliaryRunCosts } from "./auxiliary-usage.ts";
import { resetContext } from "./context-reset.ts";
import {
  readAgentSpendLimit,
  setAgentSpendLimit,
  agentSpendRefusal,
  spendInput,
  runSpend,
} from "./agent-spend.ts";
import { withSql } from "./postgres.ts";
import {
  writtenFile,
  presentedFile,
  fileOutputs,
  releasePresentedFiles,
} from "./file-output.ts";
import { DurableFileVersions } from "./file-versions.ts";
import { agentMediaTools, flushAgentMediaUsage } from "./agent-media.ts";
import { flushAttachmentTranscriptions } from "./attachment-transcription.ts";
import { selectFileTools } from "./file-tool-selection.ts";

type Config = {
  id: string;
  tenantId: string;
  revision: number;
  expiresAt: number | null;
  config: AgentConfiguration;
  resolvedModel?: import("@earendil-works/pi-ai").Model<import("@earendil-works/pi-ai").Api>;
  runtimeOrigin?: string;
};
type RequestRecord = {
  id: string;
  method: string;
  params?: Record<string, unknown>;
  piId?: string;
  task?: number;
  steer?: "queued" | "accepted";
  steeredInto?: string;
  metadata?: unknown;
  actor?: string;
  fingerprint: string;
  billing?: { tenantId: string; agentId: string; model?: string };
  agentSpendAt?: number | null;
  state: "queued" | "running" | "completed";
  startedAt: number;
  endedAt?: number;
  began?: number;
  accepted?: boolean;
  admitted?: boolean;
  outcome?: { result?: unknown; error?: string };
  status?: string;
  error?: string;
};
export interface Env
  extends ComputerBindings,
    ControlEnv,
    FileBindings,
    KeyEnv,
    AccountEnv,
    ComputerEnv,
    MediaBindings,
    AdminEnv {
  TENANTS: DurableObjectNamespace<TenantAdmission>;
  RATE_LIMITER?: RateLimit;
  CODEMODE_SANDBOX: DurableObjectNamespace<CodemodeSandboxDurableObject>;
  AGENTS: DurableObjectNamespace<CamelAgent>;
  AI: Ai;
  MODEL: string;
  API_TOKEN: string;
  AGENT_SECRETS_KEY?: string;
  AGENT_PUBLIC_URL?: string;
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
              .filter(([, item]) => item !== undefined)
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
  private historyIndex = new AgentHistory(this.ctx.storage.sql, (fn) =>
    this.ctx.storage.transactionSync(fn),
  );
  private eventLog = new DurableEventLog(this.ctx.storage.sql);
  private recentEvents = new RecentEvents(this.ctx.storage.sql);
  private registry = createRegistry();
  private codeExtension?: Extension;
  private attached = new AttachedTools();
  private promptAttachments = new PromptAttachments(this.ctx.storage, this.env);
  private promptPreparations = new PromptPreparations(this.ctx.storage, async receipt => {
    await releaseTurn(this.env, receipt.tenant, receipt.agent, receipt.requestId);
    await this.env.TENANTS.getByName(receipt.tenant).release(`${receipt.agent}:${receipt.requestId}`);
  });
  private socketsRestored = this.restoreWebSockets();
  private delegateWakeLimit = (this.env as Env & { AGENT_WAKES_PER_HOUR?: string }).AGENT_WAKES_PER_HOUR;
  private wakeBudget = new DelegationWakeBudget(this.ctx.storage, this.delegateWakeLimit ? Number(this.delegateWakeLimit) : undefined);
  async admitDelegateWake(id: string): Promise<WakeDecision> {
    return this.wakeBudget.admit(id);
  }
  async receiveAgentMessage(
    request: NoticeRequest,
    notice: RuntimeNotice,
  ): Promise<unknown> {
    return this.notifications.deliverMessage(request, notice);
  }
  async receiveAgentProgress(report: ChildProgressReport): Promise<unknown> {
    return this.delegation.recordProgress(report);
  }
  async hasBackgroundChild(id: string): Promise<boolean> {
    return (await this.delegation.children()).some(child => child.background && child.id === id);
  }
  private notifications = new DelegationNotifications({
    storage: this.ctx.storage,
    canLand: async () => !(await this.activity()).busy,
    isBusy: async () => (await this.activity()).busy,
    wakeLimit: this.delegateWakeLimit ? Number(this.delegateWakeLimit) : undefined,
    submit: (request, notice, delivery) =>
      this.submit(request, notice, delivery),
    admitWake: (root, id) =>
      root === this.ctx.id.name
        ? this.admitDelegateWake(id)
        : this.env.AGENTS.getByName(root).admitDelegateWake(id),
    humanPending: async () => {
      const pi = await this.harness.pi(),
        root = await pi.root(BACKGROUND_CONTEXT);
      return Object.values(
        (await pi.snapshot(HumanInputs, BACKGROUND_CONTEXT))?.requests ?? {},
      ).some((input) => input.answer === undefined);
    },
    retry: (at) => this.arm(at),
  });
  private delegation: Delegation = new Delegation({
    storage: this.ctx.storage,
    secret: this.env.API_TOKEN,
    context: async (api) => {
      const conf = await this.config();
      const run = await this.currentRun(api);
      return { id: conf.id, config: conf.config as never, run: run as never };
    },
    remainingBudget: async (background, api): Promise<number | undefined> => {
      const conf = await this.config(),
        run = await this.currentRun(api);
      const spend = await this.agentSpend(conf);
      let left = spend ? spend.usd - spend.spent : Infinity;
      const perRun =
        "params" in run
          ? (run.params?.spendLimit as { usd?: number } | undefined)?.usd
          : undefined;
      if (!background && perRun !== undefined) {
        const used = await withSql(this.env, (sql) =>
          runSpend(sql, conf.tenantId, conf.id, run.id),
        );
        left = Math.min(
          left,
          perRun - used - (await this.delegation.cost(run.id)),
        );
      }
      return Number.isFinite(left) ? Math.max(0, left) : undefined;
    },
    create: async (config, key, parent) => {
      const conf = await this.config();
      const directory = new Directory(this.env, conf.tenantId);
      const entry = await directory.upsert(
        config,
        key,
        conf.runtimeOrigin,
      );
      if ("failed" in entry)
        throw Object.assign(new Error(entry.error), { status: entry.status });
      if (parent) await recordChildParent(this.env, conf.tenantId, entry.id, parent.agent, parent.run);
      return entry;
    },
    remove: async (id) => {
      const conf = await this.ctx.storage.get<Config>("configuration");
      if (!conf) return;
      const result = await new Directory(this.env, conf.tenantId).remove(id);
      if (result && typeof result === "object" && "failed" in result)
        throw new Error(result.error);
    },
    target: async (ref) => {
      const conf = await this.config();
      if (ref.definition) {
        const definition = await resolveDefinition(this.env, conf.tenantId, ref.definition);
        return { config: await provisionDefinition(this.env, conf.tenantId, { definition: definition.id }) as never,
          description: definition.spec.description };
      }
      const entry = await new Directory(this.env, conf.tenantId).get(
        ref.agent!,
      );
      if (!entry) throw new BadRequest("Unknown delegate agent");
      return { id: entry.id, config: entry.config as never };
    },
    fetch: (id, request) => this.env.AGENTS.getByName(id).fetch(request),
    cancelRequest: (id, requestId) =>
      this.env.AGENTS.getByName(id).cancelRequest(requestId),
    inheritComputer: async (parent, child) => {
      const conf = await this.config();
      await inheritComputer(this.env, conf.tenantId, parent, child);
    },
    emit: (event) => this.emit(event),
    waitUntil: (promise) => this.ctx.waitUntil(promise),
    notify: (child) => this.notifications.deliver(child),
    sendMessage: (id, request, notice) =>
      this.env.AGENTS.getByName(id).receiveAgentMessage(request, notice),
    reportProgress: (id, report) =>
      this.env.AGENTS.getByName(id).receiveAgentProgress(report),
    retry: (afterMs = 1000) => this.arm(Date.now() + afterMs),
  });
  private decisions = decisionService(
    this.env,
    async (api) => {
      const conf = await this.config();
      const run = await this.currentRun(api);
      const params = "params" in run ? run.params : undefined;
      return {
        tenant: conf.tenantId,
        agent: conf.id,
        requestId: run.id === "background" ? undefined : run.id,
        spendLimit: (params?.spendLimit as { usd?: number } | undefined)?.usd,
        actor: params?.actor as string | undefined,
        identity: {
          subject: conf.config.subject,
          context: conf.config.context,
        },
        keyScope: conf.config.keyScope,
        dataCollection: conf.config.dataCollection,
      };
    },
    async (context, usage) => {
      const conf = await this.config();
      await recordDecision(
        this.env,
        context,
        usage,
        conf.id,
        context.requestId,
      );
    },
  );
  private limits = new AgentRunLimits(this.ctx.storage, async () => {
    const conf = await this.config();
    return {
      config: conf.config,
      run: await this.currentRun(),
      agentId: conf.id,
      spend: await this.agentSpend(conf),
      most: await tenantRunCaps(this.env, conf.tenantId),
    };
  });
  private async currentRun(api?: ToolExecutionApi) {
    if (api) {
      const id = await hostExecutionRequest(
        await this.harness.pi(),
        api.conversationId,
      );
      if (id) {
        const record = await this.ctx.storage.get<RequestRecord>(reqKey(id));
        if (!record) throw new Error("The executing request is missing");
        return record;
      }
    }
    return (
      (this.active
        ? await this.ctx.storage.get<RequestRecord>(reqKey(this.active))
        : undefined) ??
      (await this.records()).find((record) => record.state === "running") ?? {
        id: "background",
      }
    );
  }
  private async agentSpend(conf: Config) {
    const spend = conf.config.spendLimit
      ? await readAgentSpendLimit(this.env, conf.tenantId, conf.id)
      : null;
    return spend
      ? {
          ...spend,
          spent: spend.spent + (await this.delegation.costSince(spend.setAt)),
        }
      : null;
  }
  private async imageTools() {
    return agentMediaTools(
      this.env,
      async (api) => {
        const conf = await this.config(),
          run = await this.currentRun(api);
        const params = "params" in run ? run.params : undefined;
        const spendLimit = (params?.spendLimit as { usd?: number } | undefined)
          ?.usd;
        const spend = await this.agentSpend(conf);
        let budget = spend ? Math.max(0, spend.usd - spend.spent) : Infinity;
        if (spendLimit !== undefined) {
          const used = await withSql(this.env, (sql) =>
            runSpend(sql, conf.tenantId, conf.id, run.id),
          );
          budget = Math.min(
            budget,
            Math.max(
              0,
              spendLimit - used - (await this.delegation.cost(run.id)),
            ),
          );
        }
        return {
          tenant: conf.tenantId,
          agent: conf.id,
          requestId: run.id === "background" ? undefined : run.id,
          spendLimit,
          budget: Number.isFinite(budget) ? budget : undefined,
          builtins: conf.config.builtins,
          keyScope: conf.config.keyScope,
          identity: {
            subject: conf.config.subject,
            context: conf.config.context,
          },
          actor: params?.actor as string | undefined,
          bucket: (params?.bucket as string | undefined) ?? conf.config.bucket,
          mounts: (conf.config.mounts ?? []) as import("./files.ts").Mount[],
        };
      },
      {
        storage: this.ctx.storage,
        onWrite: async (file, scope) => {
          if (!scope.requestId)
            throw new Error("Image output has no executing request");
          await writtenFile(this.ctx.storage, scope.requestId, file);
        },
      },
    );
  }
  private async admitRequest(conf: Config, id: string) {
    let acquired = false;
    try {
      const refusal = agentSpendRefusal(conf.id, await this.agentSpend(conf));
      if (refusal)
        throw Object.assign(new Error(refusal.error), {
          status: 402,
          code: "SPEND_LIMIT",
        });
      const { accounts } = await keyServices(this.env);
      const limited = await accounts.runLimit(conf.tenantId);
      if (limited)
        throw typeof limited === "string"
          ? Object.assign(new Error(limited), { status: 402 })
          : limited;
      const { limit } = await accounts.billing.busyLimit(conf.tenantId);
      acquired = await this.env.TENANTS.getByName(conf.tenantId).acquire(
        `${conf.id}:${id}`,
        Math.min(
          limit,
          Number(this.env.TENANT_MAX_ACTIVE ?? Number.MAX_SAFE_INTEGER),
        ),
      );
      if (!acquired)
        throw Object.assign(new Error("Tenant concurrency limit"), {
          status: 429,
          code: "BUSY_AGENT_LIMIT",
        });
      await runAdmission(this.env, conf.tenantId);
      await reserveTurn(this.env, conf.tenantId, conf.id, id);
    } catch (error) {
      if (acquired)
        await this.env.TENANTS.getByName(conf.tenantId).release(
          `${conf.id}:${id}`,
        );
      await this.ctx.storage.delete(reqKey(id));
      throw error;
    }
  }
  private async sourceIdentity(api?: ToolExecutionApi) {
    const conf = await this.config(),
      run = await this.currentRun(api),
      params = "params" in run ? run.params : undefined;
    const issuer = this.env.AGENT_PUBLIC_URL || conf.runtimeOrigin;
    if (!issuer) throw new Error("Runtime public URL is not configured");
    const call = api ? await toolCallSite(api) : undefined;
    const lineage = await this.delegation.lineage(conf.id, run);
    if (call?.assistant !== undefined) {
      const pi = await this.harness.pi();
      await this.historyIndex.sync(await pi.root(BACKGROUND_CONTEXT));
      call.messageIndex = this.historyIndex.messageIndex(call.assistant);
    }
    return {
      issuer,
      ...(call ? { call } : {}),
      spawn: (tool: string, directive: unknown, currentApi: import('@earendil-works/pi-durable').ToolExecutionApi, context: import('@earendil-works/chord').Context) => this.delegation.toolSpawn(tool, directive, currentApi, context),
      progress: async (event: unknown) => {
        if (run.id !== "background") await this.emit({ type: "event", requestId: run.id, event });
      },
      intent: typeof params?.text === "string" ? params.text : undefined,
      elicit: !!(conf.config.humanInput || conf.config.builtins?.includes("ask_user") || this.attached.connected),
      claims: {
        tenant: conf.tenantId,
        agent: conf.id,
        definition: conf.config.definition,
        sub: conf.config.subject,
        ctx: conf.config.context,
        act: (params?.actor ??
          (params?.from as { id?: string } | undefined)?.id) as
          | string
          | undefined,
        req: run.id === "background" ? undefined : run.id,
        tcid: call?.toolCallId,
        ...(lineage ? { par: lineage.parent, root: lineage.root } : {}),
      },
    };
  }
  private retryModelFailure = true;
  private modelCompaction?: ReturnType<typeof modelCompactionSettings>;
  private models = modelRuntime(
    this.env,
    async () => (await this.config()).tenantId,
    {
      agentId: async () => (await this.config()).id,
      // Pi batches its live document. Project the provider's individual deltas
      // through the same projection so short chunks remain observable.
      onStreamEvent: async (event) => {
        if (event.type === "error") {
          const conf = await this.config();
          const endpoints = (await keyServices(this.env)).tenants.modelEndpoints(conf.tenantId);
          const provider = (conf.config.model ?? this.env.MODEL).split("/")[0];
          this.retryModelFailure = retriesModelError(event.error, { ownEndpoint: !!endpoints?.[provider] });
        } else if (event.type === "done") this.retryModelFailure = true;
        if (!("partial" in event)) return;
        await this.eventsProcessed;
        const run = await this.currentRun();
        await this.markBegan(run.id);
        this.partial = event.partial;
        await this.projectMessage(run.id, event.partial, false);
      },
      onDiscardedOutput: async (message) => {
        const run = await this.currentRun();
        await this.ctx.storage.put({ [`discarded-output:${run.id}`]: message, [`output-reminded:${run.id}`]: true });
        await this.projectMessage(run.id, message, true);
        this.nextMessage--;
        this.partial = null;
        await this.emit({ type: "event", requestId: run.id, event: { type: "message_retracted", index: this.nextMessage } });
      },
      onStall: async (stall) => {
        const run = await this.currentRun();
        await this.emit({ type: "event", requestId: run.id, event: { type: "model_stream_stalled", ...stall } });
      },
      beforeRequest: async () => {
        const stopped = await this.limits.check();
        if (stopped) throw new Error(stopped.error);
        await assertContextRange(
          contextRangeLimit((this.env as Env & { AGENT_CONTEXT_RANGE_MAX_BYTES?: string }).AGENT_CONTEXT_RANGE_MAX_BYTES),
          await (await this.harness.pi()).root(BACKGROUND_CONTEXT),
          async failure => { await this.ctx.storage.put(`run-limit:${(await this.currentRun()).id}`, failure); },
        );
      },
      wrapProvider: (provider) =>
        meterProvider(
          provider,
          this.env,
          async () => {
            const conf = await this.config(),
              run = await this.currentRun();
            const params = "params" in run ? run.params : undefined;
            return {
              tenant: conf.tenantId,
              agent: conf.id,
              requestId: run.id === "background" ? undefined : run.id,
              subject: conf.config.subject,
              context: conf.config.context,
              bucket:
                (params?.bucket as string | undefined) ?? conf.config.bucket,
              actor: params?.actor as string | undefined,
              keyScope: conf.config.keyScope,
              spendLimit: (params?.spendLimit as { usd?: number } | undefined)
                ?.usd,
              platform: this.env.TEST_MODEL !== "1",
            };
          },
          async (receipt) => {
            const key = `model-billing:${receipt.event.id}`;
            await this.ctx.storage.put(key, receipt);
            await applyModelReceipt(this.env, receipt);
            await this.ctx.storage.delete(key);
          },
        ),
      settings: async () => {
        const conf = await this.config();
        const run = await this.currentRun();
        const params = "params" in run ? run.params : undefined;
        return {
          ...conf.config,
          ...params,
          requestId: run.id,
          outputReminded: !!(await this.ctx.storage.get(`output-reminded:${run.id}`)),
          runLimits: {
            ...conf.config.runLimits,
            ...(params?.runLimits as object),
          },
        };
      },
      credentials: async (provider) => {
        const conf = await this.config();
        return resolveModelCredentials(
          this.env,
          conf.tenantId,
          provider,
          await this.sourceIdentity(),
          conf.config.keyScope,
        );
      },
    },
  );
  private sourceFailures: SourceFailure[] = [];
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
    return new Set(
      (await new ComputerService(this.env, conf.tenantId).tools(conf.id)).map(
        (tool) => tool.name,
      ),
    );
  }
  private async refreshComputerTools() {
    const conf = await this.config();
    const pi = await this.harness.pi(),
      root = await pi.root(BACKGROUND_CONTEXT);
    const enabled = await this.enabledTools(conf.config);
    await root.configure(enabled, BACKGROUND_CONTEXT);
  }
  private async enabledTools(config: AgentConfiguration) {
    const names = await this.computerNames();
    const disabled = new Set([
      HOST_EXECUTION_TOOL, "computer", "exec",
      ...(config.codeMode === false ? ["codemode"] : []),
      ...(!config.builtins?.includes("ask_user") ? ["ask_user"] : []),
      ...(!config.builtins?.includes("ask_human") ? ["ask_human"] : []),
    ]);
    const available = this.availableTools.filter(
      (tool) =>
        !disabled.has(tool.name) &&
        (!/^(computer_|browser_)/.test(tool.name) || names.has(tool.name)),
    );
    return selectFileTools(available, new Set(this.workspaceToolNames), config);
  }
  private workspaceToolNames: string[] = [];
  private fileVersions = new DurableFileVersions(this.ctx.storage);
  // Pi can reopen its Harness after a storage failure without replacing this
  // agent. Keep admission here so old remote work still occupies its slots.
  private readonly sandboxRemote = isolatedSandboxRemote({
    agentKey: this.ctx.id.toString(),
    getByName: (key) => this.env.CODEMODE_SANDBOX.getByName(key),
    maxConcurrent: 3,
  });
  private harness = new PiHarness({
    defaults: { model: this.models.model },
    harness: async ({ storage, context, onWake }) => {
      const registry = this.registry;
      const conf = await this.config();
      // A recreated object must register the stored custom model before Pi resumes tasks.
      const model = this.models.resolve(
        conf.config.model,
        conf.config.runLimits?.contextTokens,
        await resolveCustomProviders(
          this.env,
          conf.tenantId,
          conf.config.keyScope,
        ),
        (await keyServices(this.env)).tenants.modelEndpoints(conf.tenantId),
        conf.resolvedModel,
      );
      this.modelCompaction = modelCompactionSettings(model, conf.config.maxOutputTokens);
      registry.install(
        runtimePromptSections(
          async () => {
            const config = (await this.config()).config;
            const run = await this.currentRun();
            return { ...config, output: "params" in run ? run.params?.output : undefined } as never;
          },
        ),
      );
      registry.install(senderExtension());
      registry.install(humanInputExtension());
      registry.install(toolOutputExtension(this.env, async (api, callId) => {
        const conf = await this.config(), pi = await this.harness.pi();
        const site = await toolCallSite({ taskId: api.taskId, callId, getTask: pi.getTask.bind(pi) } as ToolExecutionApi);
        if (site.assistant !== undefined) {
          await this.historyIndex.sync(await pi.root(BACKGROUND_CONTEXT));
          site.messageIndex = this.historyIndex.messageIndex(site.assistant);
        }
        return { tenant: conf.tenantId, agent: conf.id, mounts: (conf.config.mounts ?? []) as Mount[], fileTools: conf.config.fileTools, codeMode: conf.config.codeMode, call: site };
      }));
      registry.install(this.limits.extension());
      registry.install(contextRangeExtension(
        contextRangeLimit((this.env as Env & { AGENT_CONTEXT_RANGE_MAX_BYTES?: string }).AGENT_CONTEXT_RANGE_MAX_BYTES),
        async () => (await this.harness.pi()).root(BACKGROUND_CONTEXT),
        async failure => { await this.ctx.storage.put(`run-limit:${(await this.currentRun()).id}`, failure); },
      ));
      // User files live in the volume DO/R2; code runs in the separate sandbox.
      const templates = volumeTools(
        this.env,
        "_uninitialized",
        "_uninitialized",
      );
      const tools: ToolRegistration[] = compatibleFileTools(
        templates.map((tool, index) => ({
          ...tool,
          execute: async (args, api, context) => {
            const config = await this.config();
            const impl = volumeTools(
              this.env,
              config.tenantId,
              config.id,
              async () => (config.config.mounts as never) ?? [],
              async (file, volumePath) => {
                await presentedFile(
                  this.ctx.storage,
                  this.env,
                  {
                    requestId: await this.fileRequestId(api.conversationId),
                    callId: api.callId,
                    tenant: config.tenantId,
                    origin: await this.ctx.storage.get<string>("file-origin"),
                  },
                  file,
                  volumePath,
                  (event) => this.emit(event),
                );
              },
              async (file) =>
                writtenFile(
                  this.ctx.storage,
                  await this.fileRequestId(api.conversationId),
                  file,
                ),
              this.fileVersions,
            )[index];
            return impl.execute(args as never, api, context);
          },
        })),
      );
      this.workspaceToolNames = tools.map((tool) => tool.name);
      registry.install({
        name: "camel.files",
        tools,
        sections: [],
      });
      registry.install({ name: "camel.human", tools: [askHuman, askUser] });
      registry.install({
        name: "camel.images",
        tools: await this.imageTools(),
      });
      registry.install({
        name: "camel.computers",
        tools: attachedComputerTools(
          this.env,
          () => this.config(),
          (run) =>
            this.serializeComputer(async () => {
              try {
                return await run();
              } finally {
                await this.arm();
              }
            }),
        ),
      });
      registry.install({
        name: "camel.application",
        tools: this.attached.tools(conf.config.mcp?.tools ?? [], (api) =>
          this.sourceIdentity(api),
        ),
      });
      registry.install({
        name: "camel.sources",
        tools: await sourceTools(
          this.env,
          conf.tenantId,
          conf.config.definition,
          conf.config as never,
          undefined,
          (api) => this.sourceIdentity(api),
          (failures) => { this.sourceFailures = failures; },
          (input, api, context) => this.decisions.judge(input, context.abortSignal ?? new AbortController().signal, api),
        ),
      });
      registry.install({
        name: "camel.web",
        tools: await agentBuiltins(this.env, async (api) => {
          const conf = await this.config();
          const run = await this.currentRun(api);
          const params = "params" in run ? run.params : undefined;
          return {
            tenant: conf.tenantId,
            agent: conf.id,
            requestId: run.id === "background" ? undefined : run.id,
            spendLimit: (params?.spendLimit as { usd?: number } | undefined)
              ?.usd,
            builtins: conf.config.builtins,
            webSearch: conf.config.webSearch,
            keyScope: conf.config.keyScope,
            files: await toolResultFiles(this.env, { tenant: conf.tenantId, agent: conf.id, mounts: (conf.config.mounts ?? []) as Mount[], tool: "web_fetch", call: String(api?.taskId ?? run.id) }),
          };
        }),
      });
      registry.install({
        name: "camel.decisions",
        tools:
          offersDecisions(conf.config) && (await this.decisions.available())
            ? [this.decisions.tool()]
            : [],
      });
      registry.install({
        name: "camel.output",
        tools: [
          {
            name: "final_output",
            description: "End the run with the requested structured output.",
            parameters: { type: "object", additionalProperties: true },
            callers: ["model"],
            replay: "safe",
            execute: async (args, api) => {
              const run = await this.currentRun(api);
              const schema = (
                "params" in run ? run.params?.output : undefined
              ) as { schema?: object } | undefined;
              if (!schema?.schema)
                throw new Error("This run has no output schema");
              if (!schemaAccepts(schema.schema, args)) {
                throw new Error('Validation failed for tool "final_output": arguments do not match the requested schema');
              }
              await this.ctx.storage.put(`output:${run.id}`, args);
              return {
                output: [{ type: "text", text: "Accepted." }],
                details: { output: args },
                control: { terminate: true },
              };
            },
          },
        ],
      });
      registry.install({
        name: "camel.delegation",
        tools: await this.delegation.toolsFor(
          conf.config.delegate ?? {},
          conf.config.builtins ?? [],
          conf.config.type === "subagent",
        ),
      });
      registry.install({
        name: "camel.linux",
        tools: [computerTool(this.env, this.ctx.id.toString())],
      });
      const sandbox = new SessionCodemodeSandbox({
        remote: this.sandboxRemote,
        workflow: conf.config.type === "workflow",
      });
      registry.install({ name: "camel.workflow", tools: await workflowTools({
        sandbox: new SessionCodemodeSandbox({ remote: this.sandboxRemote, workflow: true }),
        delegation: this.delegation, settings: conf.config.workflow,
        context: api => this.currentRun(api), emit: event => this.emit(event),
      }) });
      registry.install({
        name: "camel.host-execute",
        tools: [hostExecutionTool(sandbox)],
      });
      this.codeExtension = createCodemodeExtension({
        sandbox,
        // Keep provider calls outside the script's capability set.
        models: false,
      });
      registry.install(this.codeExtension);
      this.availableTools = prioritizedTools(registry.snapshot().tools());
      return Harness.open(
        storage,
        {
          models: this.models.models,
          registry,
          onWake,
          settings: () => ({
            afterFailedRun: "withdraw",
            compaction: this.modelCompaction,
            retry: { enabled: this.retryModelFailure, maxRetries: 2, baseDelayMs: 500 },
          }),
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
  private readonly initialCursor = Date.now() * 1000;
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
  private async emit(event: unknown, delivery?: TerminalDelivery) {
    const work = this.serial.then(async () => {
      const cursor = await this.ctx.storage.transaction(async (tx) => {
        if (delivery && !(await acknowledgeTerminalEvent(tx, delivery)))
          return undefined;
        const next = ((await tx.get<number>("cursor")) ?? this.initialCursor) + 1;
        await tx.put("cursor", next);
        const value = event as any;
        const live = { cursor: next, events: [], turn: await tx.get<LiveTurn>("live-turn"), partial: this.partial };
        if (value.type === "event" && value.event?.type === "agent_start" && live.turn?.requestId !== value.requestId)
          live.turn = { requestId: value.requestId, count: 0, bytes: 0, messages: [] };
        followLiveTurn(live, value, JSON.stringify(value), false);
        if (live.turn) await tx.put("live-turn", live.turn);
        else await tx.delete("live-turn");
        this.eventLog.append(next, event);
        this.recentEvents.append(next, event);
        return next;
      });
      if (cursor === undefined) return;
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
  private async flushTerminalEvents() {
    if (
      this.env.TEST_MODEL === "1" &&
      (await this.ctx.storage.get("test:crash-events")) &&
      (await this.ctx.storage.get("test:crash-owner")) === this.instanceId
    )
      return;
    for (const [key, pending] of await this.ctx.storage.list<TerminalEvents>({
      prefix: TERMINAL_EVENTS_PREFIX,
      limit: 100,
    }))
      for (let index = pending.next; index < pending.events.length; index++)
        await this.emit(pending.events[index], { key, index });
  }
  private lastEntry = 0;
  private messageProjection = new MessageProjection();
  private nextMessage = 0;
  private async markBegan(id: string) {
    const started = await this.ctx.storage.transaction(async (tx) => {
      const record = await tx.get<RequestRecord>(reqKey(id));
      if (!record || record.began) return false;
      record.began = Date.now();
      record.state = "running";
      await tx.put(reqKey(id), record);
      return true;
    });
    if (started) {
      await this.emit({
        type: "event",
        requestId: id,
        event: { type: "agent_start" },
      });
      await this.arm();
    }
  }
  private async observe() {
    return (this.observer ??= (async () => {
      const watch = await this.harness.session().watch();
      const pi = await this.harness.pi();
      const root = await pi.root(BACKGROUND_CONTEXT);
      await this.historyIndex.sync(root);
      this.nextMessage = this.historyIndex.total();
      await root.commit(async (tx) => {
        await tx.doc(HumanInputs);
      }, BACKGROUND_CONTEXT);
      const human = (await pi.watchDoc(HumanInputs, BACKGROUND_CONTEXT))!;
      human.start(async (call) => {
        if (call.kind !== "value") return;
        const processing = this.eventsProcessed.then(() =>
          this.onHuman(call.value),
        );
        this.eventsProcessed = processing.catch(() => {});
        return processing;
      });
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
      if (status?.requestId) {
        const record = await this.ctx.storage.get<RequestRecord>(
          reqKey(status.requestId),
        );
        return (
          (await this.ctx.storage.get<string>(
            `resume-for:${status.requestId}`,
          )) ??
          record?.steeredInto ??
          status.requestId
        );
      }
    }
  }
  private async fileRequestId(
    conversationId?: Parameters<typeof hostExecutionRequest>[1],
  ) {
    if (conversationId !== undefined) {
      const requestId = await hostExecutionRequest(
        await this.harness.pi(),
        conversationId,
      );
      if (requestId) return requestId;
    }
    const watch = await this.harness.session().watch();
    const live = watch.value.docs["pi.live"] as LiveState | undefined;
    const id =
      (await this.requestForInputs(live?.run?.inputs ?? [])) ?? this.active;
    if (!id) throw new Error("Files can be presented only during a run");
    return id;
  }
  private async projectMessage(id: string, message: Message, ended: boolean) {
    if (message.role === "system") return;
    message = attachmentMessage(message);
    if (message.role === "user") {
      const record = await this.ctx.storage.get<RequestRecord>(reqKey(id));
      if (ended)
        await this.emit({
          type: "event",
          requestId: id,
          event: { type: "turn_opened", index: this.nextMessage },
        });
      message = {
        ...message,
        requestId: id,
        ...(record?.metadata ? { metadata: record.metadata } : {}),
        ...(record?.params?.from ? { from: record.params.from } : {}),
      } as Message;
    }
    for (const event of this.messageProjection.events(message, ended))
      await this.emit({ type: "event", requestId: id, event });
    if (ended) this.nextMessage++;
  }
  private async onView(view: ConversationView) {
    // A paused Pi turn keeps its original input ID. New output belongs to its
    // admitted resume alias, including snapshots delivered just after answer().
    if (this.active)
      this.active =
        (await this.ctx.storage.get<string>(`resume-for:${this.active}`)) ??
        this.active;
    else
      this.active = (await this.records()).find(
        (record) => record.method === "resume" && record.state === "running",
      )?.id;
    // Input labels retain attribution when several turns share one callback.
    for (const entry of view.entries) {
      if (Number(entry.id) <= this.lastEntry) continue;
      if (entry.kind === "camel.context" || entry.kind === "pi.reset") {
        this.lastEntry = Number(entry.id);
        continue;
      }
      if (entry.kind === "camel.prompt") {
        const original = (entry.data as { requestId: string }).requestId;
        this.active =
          (await this.ctx.storage.get<string>(`resume-for:${original}`)) ??
          original;
        await this.markBegan(this.active);
      }
      if (entry.kind === "camel.steer") {
        const id = (entry.data as { requestId: string }).requestId;
        const record = await this.ctx.storage.get<RequestRecord>(reqKey(id));
        if (record && record.state !== 'completed' && !record.steeredInto) {
          this.active = id;
          await this.markBegan(id);
        }
        if (record?.steeredInto && record.state !== "completed") {
          record.state = "completed";
          record.status = "completed";
          record.endedAt = Date.now();
          record.outcome = {
            result: { steeredInto: record.steeredInto },
          };
          await this.ctx.storage.put(reqKey(id), record);
          await this.emit({
            type: "event",
            requestId: id,
            event: { type: "steer_taken", id, steeredInto: record.steeredInto },
          });
          await this.emit({ type: "response", id, outcome: record.outcome });
          const conf = await this.config();
          await releaseTurn(this.env, conf.tenantId, conf.id, id);
          await this.env.TENANTS.getByName(conf.tenantId).release(
            `${conf.id}:${id}`,
          );
        }
      }
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
      await this.markBegan(id);
      // Provider deltas are projected before Pi batches this live document.
    } else if (this.active) {
      const record = await this.ctx.storage.get<RequestRecord>(
        reqKey(this.active),
      );
      if (record?.state === "completed" && record.status !== "input_required")
        this.active = undefined;
    }
    if (live?.tools?.length) {
      const pi = await this.harness.pi();
      const inputs = await pi.snapshot(HumanInputs, BACKGROUND_CONTEXT);
      if (inputs && Object.values(inputs.requests).some(input => input.answer === undefined))
        await this.onHuman(inputs);
    }
  }
  private async onHuman(doc: { requests: Record<string, HumanInput> }) {
    const pending = Object.entries(doc?.requests ?? {}).filter(
      ([, input]) => input.answer === undefined,
    );
    const owners = new Map<string, Array<[string, HumanInput]>>();
    const deadlines: number[] = [];
    for (const [key, input] of pending) {
      const id = input.requestId ?? await this.ctx.storage.get<string>(`input-owner:${key}`)
        ?? this.active ?? (await this.currentRun()).id;
      if (await this.ctx.storage.get(`cancelled-request:${id}`)) continue;
      const entries = owners.get(id) ?? [];
      entries.push([key, input]);
      owners.set(id, entries);
    }
    for (const [id, entries] of owners) {
      const conf = await this.config();
      const record = await this.ctx.storage.get<RequestRecord>(reqKey(id));
      const actor = record?.params?.actor as string | undefined ?? (record?.params?.from as { id?: string } | undefined)?.id;
      const bound = entries.map(([key, input]) => [key, bindHumanInput(input, id, actor, conf.config.humanInput, conf.expiresAt ?? null)] as const);
      deadlines.push(...bound.flatMap(([, input]) => input.expiresAt === undefined ? [] : [input.expiresAt]));
      if (bound.some(([, input], index) => input !== entries[index][1])) {
        const pi = await this.harness.pi(), root = await pi.root(BACKGROUND_CONTEXT);
        await root.commit(async tx => {
          const doc = await tx.doc(HumanInputs);
          for (const [key, input] of bound) {
            const current = doc.requests[key];
            if (current && !current.policyBound) Object.assign(current, { requestId: input.requestId, responders: input.responders, expiresAt: input.expiresAt, policyBound: true, ...(input.resumeOnExpire ? { resumeOnExpire: true } : {}) });
          }
        }, BACKGROUND_CONTEXT);
      }
      const inputs = bound.map(([key, input]) =>
        humanInputView(key, input, conf.id, id),
      );
      for (const input of inputs)
        if (!(await this.ctx.storage.get(`input-owner:${input.id}`))) {
          await this.ctx.storage.put(`input-owner:${input.id}`, id);
          await this.emit({
            type: "event",
            requestId: id,
            event: { type: "input_required", input },
          });
        }
      if (record?.state === "running") {
        // A host script waits on its own ToolTask, not the root model submission.
        // Keep that request live so answering resumes and settles the same task.
        if (record.method === "execute") {
          record.status = "input_required";
          await this.ctx.storage.put(reqKey(id), record);
          continue;
        }
        const live = (await this.harness.session().watch()).value.docs["pi.live"] as LiveState | undefined;
        const waiting = new Set(bound.map(([, input]) => input.toolCallId));
        if (live?.tools?.some(tool => tool.status !== "done" && !waiting.has(tool.callId))) continue;
        const conf = await this.config();
        record.state = "completed";
        record.status = "input_required";
        record.endedAt = Date.now();
        const usage = await this.usageForRequest(record.piId ?? id);
        record.outcome = {
          result: { stopped: "input_required", inputs, reply: "", usage: this.usageView(usage),
            ...(usage.toolCalls?.length ? { toolCalls: usage.toolCalls.map(call => waiting.has(call.toolCallId) ? { ...call, ok: false, code: "input_required" } : call) } : {}),
            ...(usage.toolErrors?.length ? { toolErrors: usage.toolErrors } : {}),
          },
        };
        await this.ctx.storage.transaction(async (tx) => {
          await tx.put(reqKey(id), record);
          await tx.put(`billing:${id}`, {
            tenantId: conf.tenantId,
            agentId: conf.id,
            requestId: id,
            modelMetered: true,
            costMicros: 0,
            activeMs: Math.max(
              0,
              record.endedAt! - (record.began ?? record.endedAt!),
            ),
            startedAt: record.startedAt,
            subject: conf.config.subject,
            bucket:
              (record.params?.bucket as string | undefined) ??
              conf.config.bucket,
            responses: 0,
          } satisfies BillingReceipt);
          await enqueueTerminalEvents(tx, id, record.outcome, false);
        });
        await this.flushBilling();
        await this.flushTerminalEvents();
      }
    }
    if (deadlines.length) await this.ctx.storage.put("human-input-deadline", Math.min(...deadlines));
    else await this.ctx.storage.delete("human-input-deadline");
    await this.arm();
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
    if (record.state === "completed" || !record.accepted) return record;
    if (record.method === "execute") {
      const signal = waitMs ? AbortSignal.timeout(waitMs) : undefined;
      let result;
      try {
        result = await waitHostExecution(
          await this.harness.pi(), record.task as never,
          signal ? withAbortSignal(signal, BACKGROUND_CONTEXT) : BACKGROUND_CONTEXT,
        );
      } catch (error) {
        if (signal?.aborted) return (await this.ctx.storage.get<RequestRecord>(reqKey(id))) ?? record;
        throw error;
      }
      const current = await this.ctx.storage.get<RequestRecord>(reqKey(id));
      if (current?.state === "completed") return current;
      const completed: RequestRecord = {
        ...record,
        state: "completed",
        status: result.error ? "failed" : "completed",
        endedAt: Date.now(),
        outcome: result.error
          ? {
              error: result.error.message,
              ...(/may or may not have taken effect|connection lost|outcome may be unknown/i.test(
                result.error.message,
              )
                ? { code: "connection_lost", uncertain: true }
                : { code: result.error.kind }),
            }
          : { result: { ...result, ...(await fileOutputs(this.ctx.storage, id)) } },
      };
      const terminal = await this.ctx.storage.transaction(async (tx) => {
        const latest = await tx.get<RequestRecord>(reqKey(id));
        if (latest?.state === "completed") return latest;
        await tx.put(reqKey(id), completed);
        await enqueueTerminalEvents(tx, id, completed.outcome, false);
        return completed;
      });
      await this.flushTerminalEvents();
      return terminal;
    }
    try {
      let result = await this.harness.wait(
        record.piId ?? id,
        waitMs ? { signal: AbortSignal.timeout(waitMs) } : undefined,
      );
      // Pi wakes result waiters as it commits; let its queued event batches reach
      // the adapter before exposing completion to an SDK stream.
      await new Promise((resolve) => setTimeout(resolve, 0));
      await this.eventsProcessed;
      if (!record.steeredInto) {
        const joined = new Set<string>();
        for (;;) {
          const steers = (await this.records()).filter(
            (item) => item.steeredInto === id && !joined.has(item.id),
          );
          if (!steers.length) break;
          for (const steer of steers) {
            result = await this.harness.wait(steer.id);
            joined.add(steer.id);
          }
          await this.eventsProcessed;
        }
      }
      const current = await this.ctx.storage.get<RequestRecord>(reqKey(id));
      if (current?.state === "completed") return current;
      const usage = await this.usageForRequest(record.piId ?? id);
      const stored = await this.ctx.storage.get<Config>("configuration");
      const requestedOutput = record.params?.output;
      const outputValue = await this.ctx.storage.get(`output:${id}`);
      const limit = await this.ctx.storage.get<RuntimeLimit>(`run-limit:${id}`);
      const runUsage = this.usageView(usage);
      const outcome = limit
        ? { result: { ...limit, usage: runUsage } }
        : result.status === "done"
          ? {
              result: {
                reply: result.text ?? "",
                error: null,
                usage: runUsage,
                servedModel: usage.last
                  ? `${usage.last.provider}/${usage.last.model}`
                  : (record.billing?.model ?? stored?.config.model),
                ...(usage.toolCalls?.length ? { toolCalls: usage.toolCalls } : {}),
                ...(usage.toolErrors?.length ? { toolErrors: usage.toolErrors } : {}),
                ...(this.sourceFailures.length ? { sourceErrors: this.sourceFailures } : {}),
                replyIndex: usage.replyIndex,
                ...(await fileOutputs(this.ctx.storage, id)),
                ...(outputValue !== undefined
                  ? { output: outputValue }
                  : requestedOutput
                    ? {
                        error: "The model ended its turn without calling final_output, so the run has no output in its schema",
                        code: "output_missing",
                      }
                    : {}),
              },
            }
          : (projectRunFailure({
              reason:
                usage.last?.errorMessage ??
                result.reason ??
                "Model operation failed",
              last: usage.last,
            }) ?? { error: "Model operation failed" });
      if ("result" in outcome && outcome.result) Object.assign(outcome.result, { usage: runUsage });
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
          status:
            !limit &&
            result.status === "done" &&
            (!requestedOutput || outputValue !== undefined)
              ? "completed"
              : "failed",
          ...(result.status !== "done"
            ? { error: usage.last?.errorMessage ?? result.reason ?? "Model operation failed" }
            : requestedOutput && outputValue === undefined && "result" in outcome
              ? { error: outcome.result.error ?? undefined }
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
            activeMs: Math.max(
              0,
              Date.now() - (latest?.began ?? record.began ?? Date.now()),
            ),
            startedAt: record.startedAt,
            responses: usage.responses,
            subject: conf.config.subject,
            bucket:
              (record.params?.bucket as string | undefined) ??
              conf.config.bucket,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            model: record.billing?.model ?? conf.config.model,
          } satisfies BillingReceipt);
        await tx.put(reqKey(id), completed);
        await enqueueTerminalEvents(tx, id, outcome);
        changed = true;
        return completed;
      });
      // Receipt and terminal state commit together. A lost PG acknowledgement
      // only replays this immutable receipt; money remains one PG transaction.
      await this.flushBilling();
      if (changed) {
        metric(
          this.env,
          "turn_metrics",
          {
            Turns: 1,
            TurnDurationMs: terminal.endedAt! - terminal.startedAt,
            ModelResponses: usage.responses,
          },
          {
            Outcome: terminal.status ?? "completed",
            ErrorClass: errorClass(terminal.error),
            Model: terminal.billing?.model ?? "unknown",
            Provider: (terminal.billing?.model ?? "unknown").split("/")[0],
          },
        );
        await this.flushTerminalEvents();
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
  private async submit(
    input: unknown,
    notice?: RuntimeNotice,
    delivery?: NoticeDelivery,
  ) {
    // Directory applies configuration through this object's /configuration endpoint.
    // Do not hold the admission queue while making that round trip.
    if (
      input &&
      typeof input === "object" &&
      (input as { method?: string }).method === "configure"
    )
      return this.configureRequest(input);
    const result = this.admission.then(() =>
      this.admit(input, notice, delivery),
    );
    this.admission = result.catch(() => {});
    return result;
  }
  private async abortRequests(queued: 'cancel' | 'keep' = 'cancel', keepChildren = false) {
    if (queued === 'cancel') {
      await this.promptPreparations.cancel();
      const held = await this.ctx.storage.list({ prefix: 'held-steer:' });
      await this.ctx.storage.delete([...held.keys()]);
    }
    const pending = await this.harness.pending();
    const cancelled = queued === 'keep' ? [] : pending
      .filter((item) => item.status === "queued")
      .map((item) => item.operationId);
    const running = pending.filter(item => item.status === 'running').map(item => item.operationId);
    const keepTask = queued === 'keep'
      ? ((await this.harness.session().watch()).value.docs['pi.live'] as LiveState | undefined)?.run?.taskId
      : undefined;
    if (queued === 'cancel') await this.markCancelledRequests();
    else await this.ctx.storage.transaction(async tx => {
      for (const id of running) await tx.put(`cancelled-request:${id}`, 'keep-queue');
      if (keepTask !== undefined) await tx.put('resume-kept-queue', { taskId: keepTask });
    });
    if (queued === 'cancel') {
      if (!keepChildren) await this.delegation.cancel();
      await this.cancelHumanInputs();
      await this.abortExecutions();
      await this.harness.session().abort();
    } else {
      for (const queued of pending.filter(item => item.status === 'queued')) {
        const record = await this.ctx.storage.get<RequestRecord>(reqKey(queued.operationId));
        if (record?.steeredInto) {
          delete record.steeredInto;
          record.steer = 'queued';
          await this.ctx.storage.put(reqKey(record.id), record);
        }
      }
      for (const id of running) {
        await this.cancelHumanInputs(id);
        if (!keepChildren) await this.delegation.cancel(id);
      }
      await this.resumeKeptQueue();
    }
    const conf = await this.config();
    for (const id of cancelled) {
      const record = await this.ctx.storage.get<RequestRecord>(reqKey(id));
      if (!record) continue;
      record.state = "completed";
      record.status = "failed";
      record.endedAt = Date.now();
      record.outcome = {
        result: { error: "Queued run cancelled", code: "cancelled" },
      };
      await this.ctx.storage.put(reqKey(id), record);
      await releaseTurn(this.env, conf.tenantId, conf.id, id);
      await this.env.TENANTS.getByName(conf.tenantId).release(
        `${conf.id}:${id}`,
      );
      await this.emit({ type: 'event', requestId: id, event: { type: 'run_cancelled', reason: 'stopped' } });
      await this.emit({ type: "response", id, outcome: record.outcome });
    }
    return { aborted: true, cancelled };
  }
  private async resumeKeptQueue() {
    const intent = await this.ctx.storage.get<{ taskId: number }>('resume-kept-queue');
    if (!intent) return;
    const pi = await this.harness.pi();
    // A generation abort preserves the inbox but does not advance it. Repeating
    // the abort and the identified continue also finishes an interrupted stop.
    await pi.abortTask(intent.taskId as never, BACKGROUND_CONTEXT);
    await pi.waitForTask(intent.taskId as never, BACKGROUND_CONTEXT);
    if ((await this.harness.pending()).some(item => item.status === 'queued')) {
      const root = await pi.root(BACKGROUND_CONTEXT);
      await root.submit({ type: 'continue', requestId: `kept-queue-${intent.taskId}` }, BACKGROUND_CONTEXT);
    }
    await this.ctx.storage.delete('resume-kept-queue');
  }
  /** Withdraw only this delegated input, including a cancellation that arrives before it. */
  async cancelRequest(id: string) {
    const cancel = this.admission.then(async () => {
      await this.ctx.storage.put(`cancelled-request:${id}`, true);
      const record = await this.ctx.storage.get<RequestRecord>(reqKey(id));
      if (!record || (record.state === "completed" && record.status !== "input_required")) return false;
      this.resumeCancellation(record);
      return true;
    });
    this.admission = cancel.catch(() => {});
    const cancelled = await cancel;
    return cancelled;
  }
  private cancellations = new Set<string>();
  private resumeCancellation(record: RequestRecord) {
    if (this.cancellations.has(record.id)) return;
    this.cancellations.add(record.id);
    // A child tool may be waiting on its parent's admission queue. Acknowledge
    // the durable cancellation before draining tools or calling another object.
    const work = (async () => {
      await this.cancelHumanInputs(record.id);
      if (record.method === "execute")
        await abortHostExecution(await this.harness.pi(), record.id);
      else await this.harness.session().abort(record.piId ?? record.id);
      await this.delegation.cancel(record.id);
      if (record.method === "execute" && !record.accepted)
        await this.cancelHostIntent(record);
      else this.track(record.id);
    })()
      .catch(async () => {
        await this.arm(Date.now() + 1000);
      })
      .finally(() => this.cancellations.delete(record.id));
    this.ctx.waitUntil(work);
  }
  private async restoreCancellations() {
    for (const record of await this.records()) {
      if (record.state === "completed" && record.status !== "input_required") continue;
      const cancelled = await this.ctx.storage.get(`cancelled-request:${record.id}`);
      if (cancelled === 'keep-queue') this.track(record.id);
      else if (cancelled) this.resumeCancellation(record);
    }
  }
  private async abortExecutions() {
    const pi = await this.harness.pi();
    for (const record of await this.records())
      if (record.method === "execute" && record.state !== "completed") {
        await abortHostExecution(pi, record.id);
        if (!record.accepted) await this.cancelHostIntent(record);
      }
  }
  private async markCancelledRequests() {
    for (const record of await this.records())
      if (record.state !== "completed" || record.status === "input_required")
        await this.ctx.storage.put(`cancelled-request:${record.id}`, true);
  }
  private async cancelHostIntent(record: RequestRecord) {
    const completed = { ...record, state: "completed" as const, status: "failed", endedAt: Date.now(),
      outcome: { error: "Execution aborted", result: { code: "aborted" } } };
    await this.ctx.storage.put(reqKey(record.id), completed);
    await this.emit({ type: "response", id: record.id, outcome: completed.outcome });
  }
  private async cancelHumanInputs(requestId?: string) {
    const pi = await this.harness.pi();
    const snapshot = await pi.snapshot(HumanInputs, BACKGROUND_CONTEXT);
    const cancelled: Array<{ key: string; owner?: string }> = [];
    for (const [key, input] of Object.entries(snapshot?.requests ?? {})) {
      const owner = input.requestId ?? await this.ctx.storage.get<string>(`input-owner:${key}`);
      if (input.answer === undefined && (requestId === undefined || owner === requestId))
        cancelled.push({ key, owner });
    }
    if (!cancelled.length) return;
    await pi.commit(async tx => {
      const doc = await tx.doc(HumanInputs);
      for (const { key } of cancelled) doc.requests[key] = cancelledHumanInput(doc.requests[key]);
    }, BACKGROUND_CONTEXT);
    for (const { key, owner } of cancelled)
      await this.emit({ type: "event", requestId: owner, event: { type: "input_resolved", id: key, state: "cancelled" } });
  }
  private async startHostRequest(intent: RequestRecord) {
    if (await this.ctx.storage.get(`cancelled-request:${intent.id}`)) {
      await abortHostExecution(await this.harness.pi(), intent.id);
      await this.cancelHostIntent(intent);
      return (await this.ctx.storage.get<RequestRecord>(reqKey(intent.id)))!;
    }
    const record = await admitHostExecution(this.ctx.storage, reqKey(intent.id), intent, async saved => {
      const pi = await this.harness.pi(), root = await pi.root(BACKGROUND_CONTEXT);
      const tool = this.availableTools.find(tool => tool.name === HOST_EXECUTION_TOOL)!;
      const { code, timeoutMs, maxOutputCharacters } = saved.params!;
      return Number(await startHostExecution(pi, root, saved.id, { code, timeoutMs, maxOutputCharacters }, tool));
    });
    this.track(record.id);
    return record;
  }
  private async restoreHostAdmissions() {
    for (const record of await this.records())
      if (record.method === "execute" && !record.accepted && record.state !== "completed")
        await this.startHostRequest(record);
  }
  private async configureRequest(input: unknown) {
    const request = object(input, ["id", "method", "params"]);
    const id = boundedText(request.id, "id", 80);
    if (!/^[A-Za-z0-9_-]+$/.test(id))
      throw new BadRequest("Invalid request id");
    if (await this.ctx.storage.get(`cancelled-request:${id}`))
      throw Object.assign(new Error("Request cancelled"), {
        status: 409,
        code: "aborted",
      });
    if (!request.params || typeof request.params !== "object" || Array.isArray(request.params))
      throw new BadRequest("Expected configuration object");
    const conf = await this.config();
    const params = request.params as Record<string, unknown>;
    const patched = configuration({ ...conf.config, ...params }, conf.config.model ?? this.env.MODEL).config;
    const modelError = (params.model !== undefined || params.keyScope !== undefined)
      ? await configurationModelError(this.env, conf.tenantId, patched) : undefined;
    const fingerprint = canonical(request);
    const previous = await this.ctx.storage.transaction(async (tx) => {
      const old = await tx.get<RequestRecord>(reqKey(id));
      if (old && old.fingerprint !== fingerprint)
        throw Object.assign(
          new Error("Request id reused with different input"),
          { status: 409 },
        );
      if (!old)
        await tx.put(reqKey(id), {
          id,
          method: "configure",
          fingerprint,
          state: "running",
          startedAt: Date.now(),
        } satisfies RequestRecord);
      return old;
    });
    if (previous?.state === "completed") return previous;
    if (modelError) {
      const failed: RequestRecord = { id, method: "configure", fingerprint, state: "completed", startedAt: previous?.startedAt ?? Date.now(), endedAt: Date.now(), outcome: { error: modelError } };
      await this.ctx.storage.put(reqKey(id), failed);
      await this.emit({ type: "response", id, outcome: failed.outcome });
      return failed;
    }
    const directory = new Directory(this.env, conf.tenantId);
    const current = await directory.get(conf.id);
    if (!current)
      throw Object.assign(new Error("Unknown agent"), { status: 404 });
    const updated = await directory.upsert(
      await configurationPatch(this.env, conf.tenantId, current.config, params),
      current.key ?? current.id,
      conf.runtimeOrigin,
    );
    if ("failed" in updated)
      throw Object.assign(new Error(updated.error), {
        status: updated.status,
        code: updated.code,
      });
    if (Object.hasOwn(params, "spendLimit"))
      await setAgentSpendLimit(
        this.env,
        conf.tenantId,
        conf.id,
        params.spendLimit,
      );
    const record: RequestRecord = {
      id,
      method: "configure",
      fingerprint,
      state: "completed",
      startedAt: previous?.startedAt ?? Date.now(),
      endedAt: Date.now(),
      outcome: { result: { configured: true, configHash: updated.configHash } },
    };
    await this.ctx.storage.put(reqKey(id), record);
    await this.emit({ type: "response", id, outcome: record.outcome });
    return record;
  }
  private async admit(
    input: unknown,
    notice?: RuntimeNotice,
    delivery?: NoticeDelivery,
  ) {
    await this.config();
    const request = object(input, ["id", "method", "params"]);
    const id = boundedText(request.id, "id", 80);
    if (!/^[A-Za-z0-9_-]+$/.test(id))
      throw new BadRequest("Invalid request id");
    if (await this.ctx.storage.get(`cancelled-request:${id}`))
      throw Object.assign(new Error("Request cancelled"), {
        status: 409,
        code: "aborted",
      });
    if (request.method === "execute") {
      let params;
      const raw = object(request.params, [
        "code",
        "timeoutMs",
        "maxOutputCharacters",
        "actor",
        "allowDisconnected",
      ]);
      const { actor, allowDisconnected, ...code } = raw;
      try {
        params = executionParams(code);
      } catch (error) {
        throw new BadRequest((error as Error).message);
      }
      if (
        actor !== undefined &&
        (typeof actor !== "string" || actor.length > 512)
      )
        throw new BadRequest("Invalid actor");
      const fingerprint = canonical({
        method: "execute",
        params,
        actor,
        allowDisconnected,
      });
      const old = await this.ctx.storage.get<RequestRecord>(reqKey(id));
      if (old && old.fingerprint !== fingerprint)
        throw Object.assign(
          new Error("Request id reused with different input"),
          { status: 409 },
        );
      if (old) return old.accepted || old.state === "completed" ? old : this.startHostRequest(old);
      await refreshIdleLifetime(this.env, this.ctx.storage, await this.config());
      const record: RequestRecord = {
        id,
        method: "execute",
        fingerprint,
        params: { ...params, ...(actor ? { actor } : {}) },
        accepted: false,
        state: "queued",
        startedAt: Date.now(),
      };
      return this.startHostRequest(record);
    }
    if (request.method === "abort") {
      const params = object(request.params ?? {}, ["queued", "children"]);
      if (params.queued !== undefined && !['cancel', 'keep'].includes(String(params.queued)))
        throw new BadRequest('queued is cancel or keep');
      if (params.children !== undefined && !['cancel', 'keep'].includes(String(params.children)))
        throw new BadRequest('children is cancel or keep');
      const fingerprint = canonical({ method: "abort", params });
      const previous = await this.ctx.storage.get<RequestRecord>(reqKey(id));
      if (previous && previous.fingerprint !== fingerprint)
        throw Object.assign(
          new Error("Request id reused with different input"),
          { status: 409 },
        );
      if (previous?.state === "completed") return previous;
      const stopped = await this.abortRequests(params.queued === 'keep' ? 'keep' : 'cancel', params.children === 'keep');
      await this.state();
      const record: RequestRecord = {
        id,
        method: "abort",
        fingerprint,
        state: "completed",
        startedAt: Date.now(),
        endedAt: Date.now(),
        outcome: { result: stopped },
      };
      await this.ctx.storage.put(reqKey(id), record);
      await this.emit({ type: "response", id, outcome: record.outcome });
      return record;
    }
    if (["status", "compact"].includes(String(request.method))) {
      const pi = await this.harness.pi(),
        root = await pi.root(BACKGROUND_CONTEXT);
      if (request.method === "compact") {
        const params = object(request.params ?? {}, ["instructions"]);
        await pi.waitForTask(
          await root.compact(
            params.instructions as string | undefined,
            BACKGROUND_CONTEXT,
          ),
          BACKGROUND_CONTEXT,
        );
      }
      const record: RequestRecord = {
        id,
        method: String(request.method),
        fingerprint: canonical(request),
        state: "completed",
        startedAt: Date.now(),
        endedAt: Date.now(),
        outcome: {
          result:
            request.method === "status"
              ? {
                  ...(await this.activity()),
                  connected: this.attached.connected,
                }
              : { compacted: true },
        },
      };
      await this.ctx.storage.put(reqKey(id), record);
      await this.emit({ type: "response", id, outcome: record.outcome });
      return record;
    }
    if (request.method !== "prompt" && request.method !== "continue" && request.method !== 'steer')
      throw new BadRequest("Unsupported request method");
    const params = object(request.params, [
      "text",
      "allowDisconnected",
      "history",
      "metadata",
      "from",
      "attachments",
      "files",
      "images",
      "whileRunning",
      "output",
      "spendLimit",
      "runLimits",
      "actor",
      "bucket",
    ]);
    const text =
      request.method === "continue"
        ? ""
        : (params.text === undefined || (typeof params.text === "string" && !params.text.trim() &&
            new TextEncoder().encode(params.text).length <= 100_000)) &&
            Array.isArray(params.files) && params.files.length > 0
          ? ""
        : boundedText(params.text, "text", 100_000);
    if (notice) {
      params.whileRunning =
        notice.metadata.kind === "message" ? "steer" : "queue";
    } else {
      if (params.metadata !== undefined)
        params.metadata = metadataInput(params.metadata);
      if (params.from !== undefined) params.from = senderInput(params.from);
    }
    try {
      if (params.actor !== undefined) params.actor = actorInput(params.actor);
      if (params.bucket !== undefined)
        params.bucket = bucketInput(params.bucket);
      if (params.output !== undefined)
        params.output = outputInput(params.output);
      if (params.spendLimit !== undefined) {
        const usd = spendInput(params.spendLimit);
        params.spendLimit = usd === null ? null : { usd };
      }
      if (params.runLimits !== undefined) {
        const limits = runLimitsInput(params.runLimits);
        if (
          !limits ||
          Object.keys(limits).some(
            (key) => !["maxResponses", "maxSeconds"].includes(key),
          )
        )
          throw new Error(
            "runLimits is {maxResponses?, maxSeconds?} for a run",
          );
        params.runLimits = limits;
      }
    } catch (error) {
      throw new BadRequest((error as Error).message);
    }
    if (
      params.whileRunning !== undefined &&
      !["queue", "steer"].includes(String(params.whileRunning))
    )
      throw new BadRequest("Invalid whileRunning");
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
    if (request.method === 'steer') params.whileRunning = 'steer';
    if (params.output !== undefined && params.whileRunning === "steer")
      throw new BadRequest("output is for a prompt that starts its own turn, not whileRunning: steer");
    const fingerprint =
      params.files === undefined
        ? canonical({ method: request.method, params })
        : await digest(canonical({ method: request.method, params }));
    const old = await this.ctx.storage.get<RequestRecord>(reqKey(id));
    if (old && old.fingerprint !== fingerprint)
      throw Object.assign(new Error("Request id reused with different input"), {
        status: 409,
      });
    if (old?.state === "completed") return old;
    if (!old && request.method !== "steer" && (await this.records()).filter(record => record.state !== "completed").length >= MAX_OPEN_REQUESTS)
      throw Object.assign(new Error("Too many requests queued for this agent"), { status: 429 });
    const conf = await this.config();
    if (!old) await refreshIdleLifetime(this.env, this.ctx.storage, conf);
    if (conf.config.spendLimit) await this.flushBilling(true);
    const spend = await this.agentSpend(conf);
    const refusal = agentSpendRefusal(conf.id, spend);
    if (refusal)
      throw Object.assign(new Error(refusal.error), {
        status: 402,
        code: refusal.code,
      });
    const running = (await this.harness.pending()).find(
      (item) => item.status === "running",
    );
    if (
      conf.config.mcp?.tools?.length &&
      !(await this.attached.waitUntilReady()) &&
      params.allowDisconnected !== true
    )
      throw Object.assign(
        new Error("APPLICATION_NOT_CONNECTED: this agent's tools are answered by its application, and none is connected. Connect it: upsert the agent with its tools in a process that stays up (TypeScript agents.upsert(key, { tools }), Python agents.upsert(key, tools=[…]); lower down, connectAgent or connect_agent), or send allowDisconnected: true (allow_disconnected=True) to run anyway"),
        { status: 409, code: "APPLICATION_NOT_CONNECTED" },
      );
    const preparing = params.files !== undefined && !old?.admitted && !(delivery && !delivery.run && notice);
    if (preparing) {
      await this.promptPreparations.begin({ tenant: conf.tenantId, agent: conf.id, requestId: id, fingerprint }, () => this.admitRequest(conf, id));
      await this.arm();
    }
    let files: Awaited<ReturnType<PromptAttachments["attach"]>> | undefined;
    try {
    const audioRunLimit = (params.spendLimit as { usd?: number } | undefined)?.usd;
    const audioBudget = params.files === undefined ? Infinity : Math.min(
      spend ? Math.max(0, spend.usd - spend.spent) : Infinity,
      audioRunLimit === undefined ? Infinity : Math.max(0,
        audioRunLimit - await withSql(this.env, sql => runSpend(sql, conf.tenantId, conf.id, id)) - await this.delegation.cost(id)),
    );
    files =
      params.files === undefined
        ? undefined
        : await this.promptAttachments.attach(
            {
              tenant: conf.tenantId,
              agent: conf.id,
              requestId: id,
              mounts: (conf.config.mounts ?? []) as Mount[],
              spendLimit: (params.spendLimit as { usd?: number } | undefined)?.usd,
              ...(Number.isFinite(audioBudget) ? { budget: audioBudget } : {}),
              keyScope: conf.config.keyScope,
              identity: { subject: conf.config.subject, context: conf.config.context },
              actor: params.actor as string | undefined,
              bucket: (params.bucket as string | undefined) ?? conf.config.bucket,
            },
            params.files,
          );
    if (request.method !== "continue" && !text.trim() && !files?.some(file => file.transcript))
      throw new BadRequest("Give the agent some text, or audio to transcribe");
    if (await this.ctx.storage.get(`cancelled-request:${id}`))
      throw Object.assign(new Error("Request cancelled"), { status: 409, code: "aborted" });
    if (files) params.files = attachmentFiles(files);
    } catch (error) {
      if (preparing) await this.promptPreparations.fail(id);
      throw error;
    }
    if (request.method === "prompt" && !notice && !old?.accepted)
      await this.closeHumanInputs("superseded");
    const record: RequestRecord = old ?? {
      id,
      method: String(request.method),
      billing: {
        tenantId: conf.tenantId,
        agentId: conf.id,
        model: conf.config.model,
      },
      params,
      agentSpendAt: spend?.setAt ?? null,
      ...(params.metadata !== undefined ? { metadata: params.metadata } : {}),
      ...((params.actor ?? (params.from as { id?: string } | undefined)?.id) ? { actor: String(params.actor ?? (params.from as { id: string }).id) } : {}),
      fingerprint,
      state: running ? "queued" : "running",
      ...(params.whileRunning === "steer"
        ? running
          ? { steer: "accepted" as const, steeredInto: running.operationId }
          : { steer: "queued" as const }
        : {}),
      startedAt: Date.now(),
    };
    const prompt = files
      ? attachmentInput(text, files)
      : params.images
        ? imageReferenceInput(text, params.images as ImageRef[], conf.tenantId)
        : text;
    if (request.method === 'steer' && !running) {
      record.state = 'completed';
      record.status = 'completed';
      record.endedAt = Date.now();
      record.outcome = { result: { queued: true } };
      await this.ctx.storage.put(`held-steer:${id}`, { id, prompt, startedAt: record.startedAt });
      await this.ctx.storage.put(reqKey(id), record);
      if (preparing) {
        await this.promptPreparations.finish(id);
        await releaseTurn(this.env, conf.tenantId, conf.id, id);
        await this.env.TENANTS.getByName(conf.tenantId).release(`${conf.id}:${id}`);
      }
      await this.emit({ type: 'response', id, outcome: record.outcome });
      return record;
    }
    if (preparing) record.admitted = true;
    await this.ctx.storage.put(reqKey(id), record);
    if (preparing) await this.promptPreparations.finish(id);
    if (delivery && !delivery.run && notice) {
      const pi = await this.harness.pi(),
        root = await pi.root(BACKGROUND_CONTEXT);
      const saved = await root.submit(
        {
          type: "write",
          requestId: id,
          entry: {
            kind: "camel.prompt",
            data: { requestId: id, ...notice } as never,
            model: [
              { role: "user", content: text, timestamp: Date.now() },
            ] as never,
          },
        },
        BACKGROUND_CONTEXT,
      );
      await saved.wait(BACKGROUND_CONTEXT);
      record.state = "completed";
      record.endedAt = Date.now();
      record.outcome = {
        result: { error: delivery.message, code: delivery.stopped },
      };
      await this.ctx.storage.put(reqKey(id), record);
      await this.emit({ type: "response", id, outcome: record.outcome });
      return record;
    }
    await this.arm(Date.now() + 1000);
    if (!record.admitted) {
      await this.admitRequest(conf, id);
      record.admitted = true;
    }
    await this.ctx.storage.put(reqKey(id), record);
    await this.observe();
    // Attachment changes take effect on the next turn, including inherited ones.
    await this.refreshComputerTools();
    // No successful acceptance response until Pi has durably recorded the input.
    if (request.method === "continue")
      await this.harness.continue({ operationId: id });
    else {
      const held = !running ? await this.ctx.storage.list<{ id: string; prompt: typeof prompt; startedAt: number }>({ prefix: 'held-steer:' }) : new Map();
      const submission = {
        operationId: id,
        whenBusy: params.whileRunning === "steer" ? "steer" as const : "followUp" as const,
        entry: {
          kind: record.steeredInto ? "camel.steer" : "camel.prompt",
          data: {
            requestId: id,
            ...((notice?.metadata ?? params.metadata)
              ? { metadata: notice?.metadata ?? params.metadata }
              : {}),
            ...(params.from ? { from: params.from } : {}),
            ...(notice ? { source: notice.source } : {}),
          } as never,
        },
      };
      if (!held.size) await this.harness.submit(prompt, submission);
      else {
        const pi = await this.harness.pi(), root = await pi.root(BACKGROUND_CONTEXT);
        await root.commit(async tx => {
          if (await tx.submissionByRequest(root.id, id)) return;
          await root.submit(tx, { type: 'input', requestId: id, content: prompt, whenBusy: submission.whenBusy, entry: submission.entry });
          for (const value of [...held.values()].sort((a, b) => a.startedAt - b.startedAt))
            await tx.appendEntry(root.id, { kind: 'camel.steer', data: { requestId: value.id }, model: [{ role: 'user', content: value.prompt, timestamp: Date.now() }] });
        }, BACKGROUND_CONTEXT);
        await this.ctx.storage.delete([...held.keys()]);
      }
    }
    const accepted = await this.ctx.storage.transaction(async (tx) => {
      const latest = (await tx.get<RequestRecord>(reqKey(id))) ?? record;
      const accepted = { ...latest, accepted: true };
      await tx.put(reqKey(id), accepted);
      return accepted;
    });
    this.track(id);
    await this.arm();
    return accepted;
  }
  private async activity() {
    const records = (await this.records()).filter(record => ["prompt", "continue", "resume"].includes(record.method) && record.state !== "completed");
    const active = records.find(record => record.state === "running" && !record.steeredInto);
    return { busy: records.length > 0, activeRun: active?.id ?? null, queuedRuns: records.filter(record => record !== active).length };
  }
  private async state() {
    const records = await this.records();
    for (const record of records)
      if (record.method === "execute" && record.state !== "completed")
        this.track(record.id);
    await Promise.all(
      records
        .filter(
          (record) => record.state === "running" && record.method !== "execute",
        )
        .slice(0, 100)
        .map((record) => this.settle(record.id, 1)),
    );
    const activity = await this.activity();
    const lastActive = Math.max(this.recentEvents.lastActivity() ?? 0, (await this.ctx.storage.get<number>("last-active")) ?? 0);
    return {
      cursor: (await this.ctx.storage.get<number>("cursor")) ?? this.initialCursor,
      connected: this.attached.connected,
      ...activity,
      running: activity.busy || Date.now() - lastActive < Number((this.env as Env & { AGENT_IDLE_MS?: string }).AGENT_IDLE_MS ?? 60_000),
      events: this.recentEvents.read(),
      requests: await Promise.all((await this.records()).map(requestView)),
      ...(this.env.TEST_MODEL === "1"
        ? { localInstanceId: this.instanceId }
        : {}),
    };
  }
  private async history(url: URL) {
    const pi = await this.harness.pi(),
      root = await pi.root(BACKGROUND_CONTEXT);
    await this.historyIndex.sync(root);
    return this.historyIndex.read(url);
  }

  private async answerHumanInputs(answers: Array<{ id: string; body: unknown }>, via: "api" | "agent", system?: "expired" | "superseded") {
    if (!answers.length || answers.length > 100 || new Set(answers.map(entry => entry.id)).size !== answers.length)
      throw Object.assign(new Error("Answer 1 to 100 different inputs"), { status: 400 });
    // Pi can resume a tool during this commit. Install all resume records first,
    // and hold projection until the whole answer batch has committed.
    let releaseProjection!: () => void;
    const gate = new Promise<void>(resolve => { releaseProjection = resolve; });
    const before = this.eventsProcessed;
    this.eventsProcessed = before.then(() => gate);
    await before;
    const created: RequestRecord[] = [];
    let conf: Config | undefined;
    try {
      const pi = await this.harness.pi(), root = await pi.root(BACKGROUND_CONTEXT);
      conf = await this.config();
      const snapshot = await pi.snapshot(HumanInputs, BACKGROUND_CONTEXT);
      const checked: Array<{ id: string; body: unknown; pending: HumanInput; owner: string | undefined; answer: ReturnType<typeof answerHuman> | ReturnType<typeof systemHumanAnswer> }> = [];
      for (const entry of answers) {
        const pending = snapshot?.requests[entry.id];
        if (!pending) throw Object.assign(new Error(`Unknown input ${entry.id}`), { status: 404 });
        const owner = pending.requestId ?? await this.ctx.storage.get<string>(`input-owner:${entry.id}`) ?? this.active;
        const view = humanInputView(entry.id, pending, conf.id, owner);
        if (!system && owner && await this.ctx.storage.get(`cancelled-request:${owner}`))
          throw Object.assign(new Error("This input is cancelled"), { status: 409, input: view });
        checked.push({ ...entry, pending, owner, answer: system ? systemHumanAnswer(system) : answerHuman(pending, entry.body, via, conf.config.humanInput?.approvers as string[] | undefined) });
      }
      const fresh = checked.every(entry => entry.pending.answer === undefined);
      if (!fresh && !checked.every(entry => sameHumanAnswer(entry.pending, entry.answer)))
        throw Object.assign(new Error("An input is already settled"), { status: 409, input: checked.length === 1 ? humanInputView(checked[0].id, checked[0].pending, conf.id, checked[0].owner) : checked.map(entry => humanInputView(entry.id, entry.pending, conf!.id, entry.owner)) });
      const selected = new Set(answers.map(entry => entry.id));
      const unresolved = new Set(await Promise.all(Object.entries(snapshot?.requests ?? {})
        .filter(([key, input]) => !selected.has(key) && input.answer === undefined)
        .map(async ([key, input]) => input.requestId ?? await this.ctx.storage.get<string>(`input-owner:${key}`))));
      const requests: RequestRecord[] = [], resumeOwners = new Map<string, string>();
      for (const owner of new Set(checked.map(entry => entry.owner))) {
        if (!owner || unresolved.has(owner)) continue;
        const old = await this.ctx.storage.get<RequestRecord>(reqKey(owner));
        if (!old) throw Object.assign(new Error("The input's request is unavailable"), { status: 409 });
        if (old.method === "execute") {
          if (old.state === "completed" && fresh) throw Object.assign(new Error("The script has already ended"), { status: 409 });
          const resumed = old.state === "completed" ? old : { ...old, status: undefined };
          if (old.state !== "completed") await this.ctx.storage.put(reqKey(owner), resumed);
          requests.push(resumed);
          continue;
        }
        // An answer can arrive while sibling calls are still starting. Pi is
        // already running that turn; only a published suspension needs an alias.
        if (old.status !== "input_required") continue;
        const piId = old.piId ?? owner, resumeId = `resume_${(await digest(owner)).slice(0, 40)}`;
        let resumed = await this.ctx.storage.get<RequestRecord>(reqKey(resumeId));
        if (!resumed) {
          await this.flushBilling(true);
          if (!system) await this.admitRequest(conf, resumeId);
          resumed = { ...old, id: resumeId, piId, method: "resume", state: "running", status: undefined,
            outcome: undefined, startedAt: Date.now(), began: Date.now(), endedAt: undefined };
          await this.ctx.storage.put(reqKey(resumeId), resumed);
          await this.ctx.storage.put(`resume-for:${piId}`, resumeId);
          created.push(resumed);
        }
        this.active = resumeId;
        requests.push(resumed);
        resumeOwners.set(resumed.id, owner);
      }
      const inputs: ReturnType<typeof humanInputView>[] = [];
      await root.commit(async tx => {
        const doc = await tx.doc(HumanInputs);
        for (const entry of checked) {
          const current = doc.requests[entry.id];
          if (current.answer !== undefined && !sameHumanAnswer(current, entry.answer))
            throw Object.assign(new Error("An input is already settled"), { status: 409, input: humanInputView(entry.id, current, conf!.id, entry.owner) });
        }
        for (const entry of checked) {
          const current = doc.requests[entry.id];
          if (current.answer === undefined) Object.assign(current, entry.answer);
          inputs.push(humanInputView(entry.id, JSON.parse(JSON.stringify(current)), conf!.id, entry.owner));
        }
      }, BACKGROUND_CONTEXT);
      if (fresh && !system) for (const resumed of requests.filter(request => request.method === 'resume')) {
        const events = await resumedHumanTools(pi, checked.filter(entry => entry.owner === resumeOwners.get(resumed.id)).map(entry => entry.id), BACKGROUND_CONTEXT);
        for (const event of events) await this.emit({ type: 'event', requestId: resumed.id, event });
      }
      if (fresh) for (const entry of checked)
        await this.emit({ type: "event", requestId: entry.owner, event: { type: "input_resolved", id: entry.id } });
      for (const request of requests) this.track(request.id);
      if (requests.length) await this.arm();
      return { status: fresh ? 202 : 200, inputs, requests };
    } catch (error) {
      for (const resume of created) {
        await this.ctx.storage.delete(reqKey(resume.id));
        await this.ctx.storage.delete(`resume-for:${resume.piId}`);
        await releaseTurn(this.env, conf!.tenantId, conf!.id, resume.id);
        await this.env.TENANTS.getByName(conf!.tenantId).release(`${conf!.id}:${resume.id}`);
      }
      throw error;
    } finally { releaseProjection(); }
  }

  private async closeHumanInputs(system: "expired" | "superseded") {
    const pi = await this.harness.pi();
    const doc = await pi.snapshot(HumanInputs, BACKGROUND_CONTEXT);
    const answers = Object.entries(doc?.requests ?? {}).filter(([, input]) => input.answer === undefined &&
      (system === "expired" ? input.expiresAt !== undefined && input.expiresAt <= Date.now() : input.requestId !== undefined));
    const selected: Array<{ id: string; body: { action: string } }> = [];
    for (const [id, input] of answers) {
      const owner = input.requestId ?? await this.ctx.storage.get<string>(`input-owner:${id}`);
      const record = owner ? await this.ctx.storage.get<RequestRecord>(reqKey(owner)) : undefined;
      // A user message supersedes the model's questions, not independent host scripts.
      if (system === "superseded" && record?.method === "execute") continue;
      selected.push({ id, body: { action: "cancel" } });
    }
    if (selected.length) await this.answerHumanInputs(selected, "api", system);
  }

  async fetch(request: Request): Promise<Response> {
    return withMoneyMetrics(this.env, () => this.fetchRequest(request));
  }
  private async fetchRequest(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url),
        path = url.pathname;
      if (path === "/configuration" && request.method === "PUT") {
        const incoming = (await body(request, 17 * 1024 * 1024)) as Config;
        const mutation = this.admission.then(async () => {
          const old = await this.ctx.storage.get<Config>("configuration");
          if (await this.ctx.storage.get("deleted"))
            return json({ error: "Agent deleted" }, 410);
          if (old && incoming.revision < old.revision) return json(old);
          incoming.runtimeOrigin ??= old?.runtimeOrigin;
          const providers = await resolveCustomProviders(
            this.env,
            incoming.tenantId,
            incoming.config.keyScope,
          );
          const model = this.models.resolve(
            incoming.config.model,
            incoming.config.runLimits?.contextTokens,
            providers,
            (await keyServices(this.env)).tenants.modelEndpoints(incoming.tenantId),
            incoming.resolvedModel,
          );
          this.modelCompaction = modelCompactionSettings(model, incoming.config.maxOutputTokens);
          const refusal = modelSettingsRefusal(model, incoming.config as never);
          if (refusal) throw new BadRequest(refusal);
          if (
            old &&
            canonical(old.config) !== canonical(incoming.config) &&
            (await this.harness.session().busy())
          )
            return json({ error: "Agent is busy" }, 409);
          if (
            canonical(old?.config.spendLimit ?? null) !==
            canonical(incoming.config.spendLimit ?? null)
          )
            await setAgentSpendLimit(
              this.env,
              incoming.tenantId,
              incoming.id,
              incoming.config.spendLimit ?? null,
            );
          await this.ctx.storage.put("configuration", incoming);
          await this.ctx.storage.put("last-active", Date.now());
          const pi = await this.harness.pi(),
            root = await pi.root(BACKGROUND_CONTEXT);
          if (!old && incoming.config.initialMessages?.length) {
            await seedHistory(root, incoming.config.initialMessages);
          }
          this.registry.install({
            name: "camel.application",
            tools: this.attached.tools(
              incoming.config.mcp?.tools ?? [],
              (api) => this.sourceIdentity(api),
            ),
          });
          this.registry.install({
            name: "camel.sources",
            tools: await sourceTools(
              this.env,
              incoming.tenantId,
              incoming.config.definition,
              incoming.config as never,
              undefined,
              (api) => this.sourceIdentity(api),
          (failures) => { this.sourceFailures = failures; },
          (input, api, context) => this.decisions.judge(input, context.abortSignal ?? new AbortController().signal, api),
            ),
          });
          this.registry.install({
            name: "camel.web",
            tools: await agentBuiltins(this.env, async (api) => {
              const conf = await this.config();
              const run = await this.currentRun(api);
              const params = "params" in run ? run.params : undefined;
              return {
                tenant: conf.tenantId,
                agent: conf.id,
                requestId: run.id === "background" ? undefined : run.id,
                spendLimit: (params?.spendLimit as { usd?: number } | undefined)
                  ?.usd,
                builtins: conf.config.builtins,
                webSearch: conf.config.webSearch,
                keyScope: conf.config.keyScope,
                files: await toolResultFiles(this.env, { tenant: conf.tenantId, agent: conf.id, mounts: (conf.config.mounts ?? []) as Mount[], tool: "web_fetch", call: String(api?.taskId ?? run.id) }),
              };
            }),
          });
          this.registry.install({
            name: "camel.decisions",
            tools:
              offersDecisions(incoming.config) &&
              (await this.decisions.available())
                ? [this.decisions.tool()]
                : [],
          });
          this.registry.install({
            name: "camel.images",
            tools: await this.imageTools(),
          });
          this.registry.install({
            name: "camel.delegation",
            tools: await this.delegation.toolsFor(
              incoming.config.delegate ?? {},
              incoming.config.builtins ?? [],
              incoming.config.type === "subagent",
            ),
          });
          this.registry.install({ name: "camel.workflow", tools: await workflowTools({
            sandbox: new SessionCodemodeSandbox({ remote: this.sandboxRemote, workflow: true }),
            delegation: this.delegation, settings: incoming.config.workflow,
            context: api => this.currentRun(api), emit: event => this.emit(event),
          }) });
          this.availableTools = prioritizedTools(this.registry.snapshot().tools());
          const enabled = await this.enabledTools(incoming.config);
          await root.configure(
            {
              model: { provider: model.provider, modelId: model.id },
              instructions: null,
              maxTurns: null,
              extensions:
                incoming.config.codeMode === false
                  ? { remove: [this.codeExtension!] }
                  : { add: [this.codeExtension!] },
              thinkingLevel: incoming.config.thinkingLevel as never,
              ...enabled,
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
          await this.promptPreparations.cancel();
          const conf = await this.ctx.storage.get<Config>("configuration");
          await this.markCancelledRequests();
          await this.abortExecutions();
          if (conf)
            await this.serializeComputer(() =>
              new ComputerService(this.env, conf.tenantId).removeAgent(conf.id),
            );
          await this.ctx.storage.put("deleted", true);
          await this.delegation.destroy();
          await this.harness.session().abort();
          await this.cancelHumanInputs();
          if (conf)
            await releasePresentedFiles(
              this.ctx.storage,
              this.env,
              conf.tenantId,
              conf.id,
            );
          for (const listener of this.listeners) listener(0, null);
          return json({ deleted: true });
        });
        this.admission = deletion.catch(() => {});
        return deletion;
      }
      if (path === "/__computer" && request.method === "POST") {
        const input = (await body(request)) as any;
        const conf =
          input.operation === "sweep"
            ? await this.ctx.storage.get<Config>("configuration")
            : await this.config();
        if (!conf) return json({ error: "Agent not found" }, 404);
        if (input.tenant !== conf.tenantId)
          return json({ error: "Forbidden" }, 403);
        return await this.serializeComputer(async () => {
          const service = new ComputerService(this.env, conf.tenantId);
          if (input.operation === "sweep") {
            await service.sweepAgent(conf.id);
            await this.arm();
            return json({ swept: true });
          }
          if (input.operation === "refresh") {
            await this.refreshComputerTools();
            return json({ refreshed: true });
          }
          if (input.operation === "remove") {
            const removed = await service.remove(conf.id);
            await this.refreshComputerTools();
            return json(removed);
          }
          if (input.operation === "confirm-cleanup")
            return json(await service.confirmCleanup(conf.id));
          try {
            return json(
              await service.call(
                conf.id,
                input.operation,
                input.args ?? {},
                input.key,
              ),
            );
          } finally {
            await this.arm();
          }
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
        await this.ctx.storage.delete("test:crash-owner");
        await this.ctx.storage.put(
          "test:crash-events",
          ((await body(request)) as { events?: boolean }).events === true,
        );
        await this.ctx.storage.put("test:crash-settlement", true);
        return json({ armed: true });
      }
      if (path === "/schedules" && request.method === "GET")
        return json([
          ...(await this.ctx.storage
            .list<Schedule>({ prefix: "schedule:" })
            .then((x) =>
              [...x.values()].sort(
                (a, b) => a.dueAt - b.dueAt || a.id.localeCompare(b.id),
              ),
            )),
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
        const input = object(await body(request, 6 * 1024 * 1024), [
          "text",
          "idempotencyKey",
          "history",
          "metadata",
          "allowDisconnected",
          "from",
          "requestId",
          "whileRunning",
          "output",
          "spendLimit",
          "runLimits",
          "actor",
          "images",
          "attachments",
          "files",
        ]);
        const { idempotencyKey, requestId, ...params } = input;
        return json(
          await requestView(
            await this.submit({
              id: requestId ?? idempotencyKey ?? crypto.randomUUID(),
              method: "prompt",
              params,
            }),
          ),
          202,
        );
      }
      if (path === "/configuration" && request.method === "GET")
        return json(await this.config());
      if (path === "/tool-sources" && request.method === "GET") {
        const conf = await this.config();
        const refresh = url.searchParams.get("refresh");
        if (refresh !== null && !["true", "false"].includes(refresh))
          throw new BadRequest("refresh must be true or false");
        if (refresh === "true") {
          const tools = await sourceTools(
            this.env,
            conf.tenantId,
            conf.config.definition,
            conf.config as never,
            undefined,
            (api) => this.sourceIdentity(api),
          (failures) => { this.sourceFailures = failures; },
          (input, api, context) => this.decisions.judge(input, context.abortSignal ?? new AbortController().signal, api),
          );
          this.registry.install({ name: "camel.sources", tools });
          this.availableTools = prioritizedTools(this.registry.snapshot().tools());
        }
        const sources = toolSourceViews(
          conf.config as never,
          (await this.enabledTools(conf.config)).tools,
          this.attached.connected,
          this.sourceFailures,
          refresh === "true" || (await this.state()).running,
        );
        if (url.searchParams.get("schemas") !== "true")
          for (const source of sources)
            source.tools = source.tools.map((tool) => {
              const {
                inputSchema: _schema,
                parameters: _parameters,
                ...summary
              } = tool as Record<string, unknown>;
              return summary;
            });
        return json(sources);
      }
      if (path === "/state" && request.method === "GET")
        return json(await this.state());
      if (path === "/requests" && request.method === "POST")
        return json(
          await requestView(
            await this.submit(await body(request, 6 * 1024 * 1024)),
          ),
          202,
        );
      if (path.startsWith("/requests/") && request.method === "GET") {
        const seconds = Number(url.searchParams.get("wait") ?? 0);
        if (!Number.isFinite(seconds) || seconds < 0) throw new BadRequest("wait is a number of seconds");
        const wait = Math.max(1, Math.min(25000, seconds * 1000));
        return json(
          await requestView(
            await this.settle(decodeURIComponent(path.slice(10)), wait),
          ),
        );
      }
      if (path === "/history" && request.method === "GET") {
        const run = url.searchParams.get("run");
        if (run) {
          const record = await this.ctx.storage.get<RequestRecord>(reqKey(run));
          if (!record || record.endedAt && record.endedAt + Number(url.searchParams.get("retentionMs")) <= Date.now())
            return json({ error: "Run retention expired", code: "NOT_FOUND" }, 404);
        }
        return json(await this.history(url));
      }
      if (path === "/fork-snapshot" && request.method === "POST") {
        const input = object(await body(request), ["atMessage"]);
        const pi = await this.harness.pi();
        const running = new Set((await this.records()).filter(record => record.state !== "completed" || record.status === "input_required").map(record => record.id));
        return json(await forkSnapshot(await pi.root(BACKGROUND_CONTEXT), this.historyIndex, input.atMessage as number | string | undefined, running));
      }
      if (path === "/context/import" && request.method === "POST") {
        const input = object(await body(request), ["model", "pinnedVolumes"]);
        if (!Array.isArray(input.model)) throw new BadRequest("Expected model context");
        if (Array.isArray(input.pinnedVolumes)) {
          const pinned = await this.ctx.storage.get<string[]>("file-pin-volumes") ?? [];
          await this.ctx.storage.put("file-pin-volumes", [...new Set([...pinned, ...input.pinnedVolumes])]);
        }
        if (!await this.ctx.storage.get("fork-context-imported")) {
          await writeModelContext(await (await this.harness.pi()).root(BACKGROUND_CONTEXT), input.model as Message[]);
          await this.ctx.storage.put("fork-context-imported", true);
        }
        return json({ imported: true });
      }
      if (path === "/inputs" && request.method === "GET") {
        const pi = await this.harness.pi(),
          root = await pi.root(BACKGROUND_CONTEXT);
        const doc = await pi.snapshot(HumanInputs, BACKGROUND_CONTEXT),
          conf = await this.config();
        const values = [];
        const state = url.searchParams.get("state") ?? "all";
        if (
          ![
            "all",
            "pending",
            "answered",
            "declined",
            "cancelled",
            "expired",
            "superseded",
          ].includes(state)
        )
          throw new BadRequest("Invalid input state");
        for (const [id, item] of Object.entries(doc?.requests ?? {}))
          if (state === "all" || (item.state ?? "pending") === state)
            values.push(
              humanInputView(
                id,
                item,
                conf.id,
                (await this.ctx.storage.get<string>(`input-owner:${id}`)) ??
                  this.active,
              ),
            );
        return json(values.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id)).slice(0, 100));
      }
      if ((path === "/inputs" || path.startsWith("/inputs/")) && request.method === "POST") {
        const input = await body(request, 1024 * 1024);
        const batch = path === "/inputs";
        const answers = batch ? answerList(input) : [{ id: decodeURIComponent(path.slice(8)), body: input }];
        const answering = this.admission.then(() => this.answerHumanInputs(answers, request.headers.get("x-camel-input-via") === "agent" ? "agent" : "api"));
        this.admission = answering.catch(() => {});
        const answered = await answering;
        return json(batch ? { inputs: answered.inputs, requests: answered.requests } : { input: answered.inputs[0], request: answered.requests[0] ?? null }, answered.status);
      }
      if (path === "/abort" && request.method === "POST") {
        const params = object(request.body ? await body(request) : {}, ['queued', 'children']);
        if (params.queued !== undefined && !['cancel', 'keep'].includes(String(params.queued))) throw new BadRequest('queued is cancel or keep');
        if (params.children !== undefined && !['cancel', 'keep'].includes(String(params.children))) throw new BadRequest('children is cancel or keep');
        const aborting = this.admission.then(async () => {
          const stopped = await this.abortRequests(params.queued === 'keep' ? 'keep' : 'cancel', params.children === 'keep');
          await this.state();
          return json(stopped);
        });
        this.admission = aborting.catch(() => {});
        return aborting;
      }
      if (path === "/context/reset" && request.method === "POST") {
        const input = object(await body(request), ["summary", "keepMessages"]);
        const work = this.admission.then(async () => {
          const pi = await this.harness.pi(),
            root = await pi.root(BACKGROUND_CONTEXT);
          if (await this.harness.session().busy())
            throw Object.assign(new Error("Agent is busy"), { status: 409, code: "AGENT_BUSY" });
          await this.historyIndex.sync(root);
          return resetContext(root, input, () =>
            this.historyIndex.tail(Number(input.keepMessages ?? 0)),
          );
        });
        this.admission = work.catch(() => {});
        return json({ reset: true, ...(await work) });
      }
      if (path === "/compact" && request.method === "POST") {
        const input = object(await body(request), ["instructions"]),
          pi = await this.harness.pi(),
          root = await pi.root(BACKGROUND_CONTEXT);
        const task = await root.compact(
          input.instructions as string | undefined,
          BACKGROUND_CONTEXT,
        );
        await pi.waitForTask(task, BACKGROUND_CONTEXT);
        return json({ compacted: true });
      }
      if (path === "/mcp" && request.method === "POST") {
        this.attached.receive(
          await body(request, 2 * 1024 * 1024),
          request.headers.get("X-Agent-Connection"),
        );
        return json({ ok: true });
      }
      if (path === "/events" && request.method === "GET") {
        const selected = await this.negotiateAgentEvents(request);
        if (selected) return selected;
        return request.headers.get("upgrade")?.toLowerCase() === "websocket"
          ? this.webSocketEvents(request)
          : this.events(request);
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
      if (
        path === "/files" ||
        path === "/links" ||
        path.startsWith("/uploads/")
      ) {
        const conf = await this.config();
        return (await handleAgentFilesRoute(
          request,
          this.env,
          conf.tenantId,
          conf.id,
          (conf.config.mounts ?? []) as never,
          path,
        ))!;
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
          ...(typeof (error as { code?: unknown }).code === "string"
            ? { code: (error as { code: string }).code }
            : {}),
          ...("input" in Object(error) ? { input: (error as { input: unknown }).input } : {}),
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
  private usageView(usage: Awaited<ReturnType<CamelAgent["usageForRequest"]>>) {
    return {
                  responses: usage.responses,
                  input: usage.inputTokens,
                  output: usage.outputTokens,
                  cacheRead: usage.cacheRead,
                  cacheWrite: usage.cacheWrite,
                  costUsd: usage.costMicros / 1_000_000,
                  ...(usage.imageCostUsd > 0
                    ? { imageCostUsd: usage.imageCostUsd }
                    : {}),
                  ...(usage.transcriptionCostUsd > 0
                    ? { transcriptionCostUsd: usage.transcriptionCostUsd }
                    : {}),
                  ...(usage.decisionCostUsd > 0
                    ? { decisionCostUsd: usage.decisionCostUsd }
                    : {}),
                  ...(usage.webCostUsd > 0
                    ? { webCostUsd: usage.webCostUsd }
                    : {}),
                  ...(usage.subagentCostUsd > 0
                    ? { subagentCostUsd: usage.subagentCostUsd }
                    : {}),
                };
  }
  private async usageForRequest(id: string) {
    const pi = await this.harness.pi(),
      root = await pi.root(BACKGROUND_CONTEXT);
    const conf = await this.config();
    const [auxiliary, subagentCostUsd] = await Promise.all([
      auxiliaryRunCosts(this.env, conf.tenantId, conf.id, id),
      this.delegation.cost(id),
    ]);
    const children = new Map((await this.delegation.children()).filter(child => child.parentRequestId === id).map(child => [child.toolCallId, child.id]));
    const projection = new RunProjection(id, children);
    let cursor,
      active: string | undefined,
      inputTokens = 0,
      outputTokens = 0,
      cacheRead = 0,
      cacheWrite = 0,
      responses = 0,
      cost = 0,
      last: AssistantMessage | undefined;
    do {
      const page = await root.entries(
        { order: "ascending" },
        256,
        cursor,
        BACKGROUND_CONTEXT,
      );
      for (const entry of page.items) {
        projection.add(entry);
        if (entry.kind === "camel.prompt")
          active = (entry.data as { requestId: string }).requestId;
        if (active !== id) continue;
        for (const message of entry.model ?? [])
          if (message.role === "assistant") {
            last = message;
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
    const discarded = await this.ctx.storage.get<AssistantMessage>(`discarded-output:${id}`);
    if (discarded) {
      responses++;
      inputTokens += discarded.usage.input;
      outputTokens += discarded.usage.output;
      cacheRead += discarded.usage.cacheRead;
      cacheWrite += discarded.usage.cacheWrite;
      cost += discarded.usage.cost.total;
    }
    return {
      last,
      ...projection.finish(),
      inputTokens,
      outputTokens,
      cacheRead,
      cacheWrite,
      responses,
      costUsd: cost,
      costMicros: Math.max(0, Math.round(cost * 1_000_000)),
      ...auxiliary,
      subagentCostUsd,
    };
  }
  private async flushBilling(propagate = false) {
    try {
      await flushAttachmentTranscriptions(this.env, this.ctx.storage);
      await flushAgentMediaUsage(this.env, this.ctx.storage);
    } catch (error) {
      await this.arm(Date.now() + 1000);
      if (propagate) throw error;
    }
    for (const [key, receipt] of await this.ctx.storage.list<ModelReceipt>({
      prefix: "model-billing:",
    })) {
      try {
        await applyModelReceipt(this.env, receipt);
        await this.ctx.storage.delete(key);
      } catch (error) {
        await this.arm(Date.now() + 1000);
        if (propagate) throw error;
      }
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
            await tx.put("test:crash-owner", this.instanceId);
          });
        }
        if (
          (await this.ctx.storage.get("test:crash-owner")) === this.instanceId
        ) {
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
      !conf.config.delegate.agents.some(
        (target) => target.agent === definition || target.name === definition,
      )
    )
      throw Object.assign(new Error("Delegate is not allowed"), {
        status: 403,
      });
    const entry = await directory.upsert(
      {
        ...(base?.config ?? conf.config),
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
    if (
      (await this.ctx.storage.list({ prefix: "schedule:", limit: 100 })).size >=
      100
    )
      throw new BadRequest("At most 100 schedules per agent");
    const conf = await this.config();
    const schedule = await newSchedule(this.env, conf.tenantId, conf.id, raw);
    await this.ctx.storage.put(`schedule:${schedule.id}`, schedule);
    await this.arm();
    return schedule;
  }
  private async arm(retry?: number) {
    const schedules = await this.ctx.storage.list<Schedule>({
      prefix: "schedule:",
      limit: 100,
    });
    const pendingBilling =
      (await this.ctx.storage.list({ prefix: "billing:", limit: 1 })).size ||
      (await this.ctx.storage.list({ prefix: "image-billing:", limit: 1 }))
        .size ||
      (await this.ctx.storage.list({ prefix: "transcription-billing:", limit: 1 }))
        .size ||
      (await this.ctx.storage.list({ prefix: "model-billing:", limit: 1 }))
        .size;
    const pendingEvents = (
      await this.ctx.storage.list({ prefix: TERMINAL_EVENTS_PREFIX, limit: 1 })
    ).size;
    const config = await this.ctx.storage.get<Config>("configuration");
    const pendingRun = (await this.records()).some(
      (record) => record.accepted && record.state !== "completed",
    );
    const next = Math.min(
      config?.expiresAt ?? Infinity,
      config
        ? ((await new ComputerService(this.env, config.tenantId).nextDeadline(
            config.id,
          )) ?? Infinity)
        : Infinity,
      ...[...schedules.values()].map((item) => item.retryAt ?? item.dueAt),
      retry ?? Infinity,
      pendingBilling ? Date.now() + 5000 : Infinity,
      pendingEvents ? Date.now() + 1000 : Infinity,
      pendingRun ? Date.now() + 1000 : Infinity,
      await this.promptPreparations.deadline(),
      await this.ctx.storage.get<number>("human-input-deadline") ?? Infinity,
      await this.limits.deadline(),
    );
    if (Number.isFinite(next))
      await this.lifecycle.jobs.push({
        id: "camel-wake",
        fn: "camel-wake",
        time: Math.max(Date.now() + 1, next),
      });
  }
  async onStart() {
    return withMoneyMetrics(this.env, () => this.restorePending());
  }
  private async restorePending() {
    await this.promptPreparations.sweep(Date.now(), true);
    await this.resumeKeptQueue();
    await this.restoreCancellations();
    await this.restoreHostAdmissions();
    await this.delegation.recover();
    await this.notifications.drain();
    // Pi restores its own work on startup. Restore the adapter's result/receipt
    // waiters too, so completion is billed without requiring a client poll.
    for (const record of await this.records())
      if (record.accepted && record.state !== "completed")
        this.track(record.id);
    if (
      (await this.ctx.storage.list({ prefix: "billing:", limit: 1 })).size ||
      (await this.ctx.storage.list({ prefix: "image-billing:", limit: 1 }))
        .size ||
      (await this.ctx.storage.list({ prefix: "transcription-billing:", limit: 1 }))
        .size ||
      (await this.ctx.storage.list({ prefix: "model-billing:", limit: 1 })).size
    )
      this.ctx.waitUntil(this.flushBilling());
    this.ctx.waitUntil(this.flushTerminalEvents());
  }
  async onJob(context: { job: { fn: string } }) {
    return withMoneyMetrics(this.env, async () => {
      if (context.job.fn === "camel-wake") await this.wake();
    });
  }
  private async wake() {
    await this.promptPreparations.sweep();
    await this.resumeKeptQueue();
    await this.restoreCancellations();
    const conf = await this.ctx.storage.get<Config>("configuration");
    if (conf)
      await this.serializeComputer(() =>
        new ComputerService(this.env, conf.tenantId).sweepAgent(conf.id),
      ).catch(() =>
        console.error(
          JSON.stringify({ type: "computer_cleanup_failed", agent: conf.id }),
        ),
      );
    if (conf?.expiresAt && conf.expiresAt <= Date.now()) {
      await this.promptPreparations.cancel();
      await this.markCancelledRequests();
      await this.abortExecutions();
      await this.ctx.storage.put("deleted", true);
      await this.delegation.destroy();
      await this.harness.session().abort();
      await this.cancelHumanInputs();
      // Unsettled turns are still charged from their durable receipts below.
      await this.flushBilling();
      return;
    }
    await this.flushBilling();
    await this.flushTerminalEvents();
    const expire = this.admission.then(() => this.closeHumanInputs("expired"));
    this.admission = expire.catch(() => {});
    await expire;
    await this.restoreHostAdmissions();
    if (await this.limits.check()) await this.harness.session().abort();
    await this.delegation.recover();
    await this.notifications.drain();
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
        await queueScheduleEmail(this.env, schedule, occurrence);
        await this.submit({
          id: occurrence,
          method: schedule.code === undefined ? "prompt" : "execute",
          params:
            schedule.code === undefined
              ? {
                  text: schedule.calendar
                    ? calendarPrompt(
                        schedule.text!,
                        schedule.calendar,
                        schedule.dueAt,
                      )
                    : schedule.text,
                  allowDisconnected: true,
                }
              : { code: schedule.code, allowDisconnected: true },
        });
        if (schedule.email) await publishScheduleEmails(this.env);
        if (schedule.calendar || schedule.everySeconds) {
          delete schedule.retryAt;
          schedule.failures = 0;
          delete schedule.lastError;
          schedule.dueAt = nextOccurrence(schedule);
          await this.ctx.storage.put(key, schedule);
        } else await this.ctx.storage.delete(key);
      } catch (error) {
        const status = (error as { status?: number }).status;
        const attempt = (schedule.attempts ?? 0) + 1;
        const delay = retryable(status)
          ? RETRY_DELAYS_MS[attempt - 1]
          : undefined;
        const next =
          schedule.calendar || schedule.everySeconds
            ? nextOccurrence(schedule)
            : undefined;
        schedule.lastError = safeError(error);
        schedule.lastErrorAt = Date.now();
        if (status === 404 || status === 410)
          await this.ctx.storage.delete(key);
        else if (
          delay !== undefined &&
          (next === undefined || Date.now() + delay < next)
        ) {
          schedule.attempts = attempt;
          schedule.retryAt = Date.now() + delay;
          await this.ctx.storage.put(key, schedule);
        } else if (next !== undefined) {
          schedule.failures = (schedule.failures ?? 0) + 1;
          schedule.attempts = 0;
          delete schedule.retryAt;
          schedule.dueAt = next;
          await this.ctx.storage.put(key, schedule);
        } else await this.ctx.storage.delete(key);
        metric(
          this.env,
          "schedule_delivery_failed",
          { ScheduleDeliveryFailures: 1 },
          {
            ErrorClass: errorClass(error instanceof Error ? error.message : ""),
          },
        );
      }
    }
    await this.arm();
  }
  private async webSocketEvents(request: Request): Promise<Response> {
    await this.observe();
    const state = await this.state();
    const replay = await this.replayEvents(request);
    const conf = await this.config();
    const url = new URL(request.url);
    const watch = url.searchParams.get("watch") === "1";
    const previous =
      request.headers.get("X-Agent-Connection") ??
      url.searchParams.get("connection") ??
      undefined;
    const takeover = url.searchParams.get("takeover") === "true";
    if (!watch) await this.attached.prepareAttach(previous, takeover);
    const pair = new WebSocketPair();
    const socket = pair[1];
    this.ctx.acceptWebSocket(socket);
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );
    const connection = watch
      ? undefined
      : this.attached.attach(
          (event) => this.sendAttachedSocket(socket, event),
          previous,
          takeover,
          () => this.retireAttachedSocket(socket),
        );
    if (connection) {
      for (const other of this.ctx.getWebSockets()) {
        if (other === socket) continue;
        const attachment = other.deserializeAttachment();
        if (attachment?.type === "camel.application" && attachment.serving) {
          other.serializeAttachment({ ...attachment, serving: false });
        }
      }
      socket.serializeAttachment({
        type: "camel.application",
        connection: connection.id,
        serving: true,
        initialized: false,
      });
    }
    socket.send(
      eventFrame(
        {
          version: 5,
          agentId: conf.id,
          connection: connection?.id,
          toolsHash: await digest(JSON.stringify(conf.config.mcp?.tools ?? [])),
        },
        undefined,
        "ready",
      ),
    );
    if (connection)
      void connection
        .start()
        .then(() => {
          const attachment = socket.deserializeAttachment();
          socket.serializeAttachment({ ...attachment, initialized: true });
        })
        .catch(() => this.retireAttachedSocket(socket));
    if (replay.snapshot) socket.send(eventFrame(replay.snapshot, replay.snapshot.cursor));
    for (const row of replay.events) socket.send(eventFrame(row.data, row.id));
    const selected = request.headers
      .get("sec-websocket-protocol")
      ?.split(",")
      .map((x) => x.trim())
      .includes(EVENT_PROTOCOL);
    return new Response(null, {
      status: 101,
      webSocket: pair[0],
      headers: selected ? { "Sec-WebSocket-Protocol": EVENT_PROTOCOL } : {},
    });
  }
  /** Check ownership before returning the capability response: upgrade failures
   * cannot carry the SDK's typed HTTP refusal. */
  private async negotiateAgentEvents(
    request: Request,
  ): Promise<Response | undefined> {
    const selected = negotiateEvents(request);
    if (!selected) return;
    const url = new URL(request.url);
    if (url.searchParams.get("watch") !== "1" && !url.searchParams.has("runId"))
      await this.attached.prepareAttach(
        request.headers.get("X-Agent-Connection") ?? undefined,
        url.searchParams.get("takeover") === "true",
      );
    // Directory forwarding strips the public prefix. The capability must point
    // the SDK back through the authenticated public route, not internal /events.
    const conf = await this.config();
    return Response.json(
      {
        transport: "websocket",
        protocol: EVENT_PROTOCOL,
        url: `${request.headers.get("x-camel-events-path") ?? `/clients/${conf.id}/events`}${url.search}`,
      },
      { headers: selected.headers },
    );
  }
  /** Socket attachments hold routing metadata only; credentials remain in the
   * authenticated request and are never retained in hibernation state. */
  private restoreWebSockets() {
    for (const socket of this.ctx.getWebSockets()) {
      const value = socket.deserializeAttachment();
      if (value?.type !== "camel.application") continue;
      if (!value.serving || !value.initialized || this.attached.connected) {
        this.retireAttachedSocket(socket);
        continue;
      }
      this.attached.restore(
        value.connection,
        (event) => this.sendAttachedSocket(socket, event),
        () => this.retireAttachedSocket(socket),
      );
    }
  }
  private sendAttachedSocket(socket: WebSocket, event: unknown) {
    try {
      socket.send(eventFrame(event));
    } catch {
      const attachment = socket.deserializeAttachment();
      if (attachment?.type === "camel.application")
        this.attached.close(attachment.connection);
      try {
        socket.close(1011, "Send failed");
      } catch {}
    }
  }
  private retireAttachedSocket(socket: WebSocket) {
    const attachment = socket.deserializeAttachment();
    if (attachment?.type === "camel.application")
      socket.serializeAttachment({ ...attachment, serving: false });
    try {
      socket.send(eventFrame({}, undefined, "closed"));
    } catch {}
    try {
      socket.close(1000, "Connection retired");
    } catch {}
  }
  async webSocketMessage(socket: WebSocket, _data: string | ArrayBuffer) {
    const attachment = socket.deserializeAttachment();
    if (attachment?.type === "camel.application")
      this.attached.close(attachment.connection);
    socket.close(1008, "Read-only event stream");
  }
  async webSocketClose(socket: WebSocket, code: number) {
    const attachment = socket.deserializeAttachment();
    if (attachment?.type === "camel.application")
      this.attached.close(attachment.connection);
    try {
      socket.close(
        code === 1000 || code === 1001 || (code >= 3000 && code <= 4999)
          ? code
          : 1000,
        "Closed",
      );
    } catch {}
  }
  async webSocketError(socket: WebSocket) {
    await this.webSocketClose(socket, 1011);
  }
  private async replayEvents(request: Request) {
    const state = await this.state();
    const watch = new URL(request.url).searchParams.get("watch") === "1";
    const asked = new URL(request.url).searchParams.get("snapshot");
    return replayEvents({ cursor: state.cursor, events: state.events,
      turn: await this.ctx.storage.get<LiveTurn>("live-turn"), partial: this.partial },
      request.headers.get("Last-Event-ID") ?? "0", watch ? asked !== "0" : asked === "1",
      Number((this.env as Env & { AGENT_SNAPSHOT_BYTES?: string }).AGENT_SNAPSHOT_BYTES) || undefined);
  }
  private async events(request: Request): Promise<Response> {
    const runId = new URL(request.url).searchParams.get("runId");
    if (runId)
      return runEventStream(request, runId, this.eventLog, (receive) => {
        this.listeners.add(receive);
        return () => this.listeners.delete(receive);
      });
    await this.observe();
    const state = await this.state();
    let replay = await this.replayEvents(request);
    if (new URL(request.url).searchParams.get("poll") === "1") {
      const seconds = Number(new URL(request.url).searchParams.get("wait") ?? 0);
      if (!Number.isFinite(seconds) || seconds < 0) throw new BadRequest("wait is a number of seconds");
      const wait = Math.min(25_000, seconds * 1000);
      if (!replay.snapshot && !replay.events.length && wait) {
        await new Promise<void>(resolve => {
          const wake = () => { clearTimeout(timer); this.listeners.delete(wake); request.signal.removeEventListener("abort", wake); resolve(); };
          const timer = setTimeout(wake, wait);
          this.listeners.add(wake);
          request.signal.addEventListener("abort", wake, { once: true });
        });
        replay = await this.replayEvents(request);
      }
      return json({ cursor: replay.events.at(-1)?.id ?? (replay.cursor || state.cursor), events: [...(replay.snapshot ? [{ id: replay.snapshot.cursor, data: replay.snapshot }] : []), ...replay.events] });
    }
    const encoder = new TextEncoder();
    const conf = await this.config();
    const toolsHash = await digest(
      JSON.stringify(conf.config.mcp?.tools ?? []),
    );
    const watch =
      new URL(request.url).searchParams.get("watch") === "1" ||
      request.headers.get("authorization")?.startsWith("Bearer cbt_");
    const previous = request.headers.get("X-Agent-Connection") ?? undefined;
    const takeover =
      new URL(request.url).searchParams.get("takeover") === "true";
    if (!watch) await this.attached.prepareAttach(previous, takeover);
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
          const connection = watch
            ? undefined
            : this.attached.attach(
                (event) => {
                  if (closed) return;
                  if ((controller.desiredSize ?? 0) <= 0) {
                    cleanup();
                    controller.close();
                    return;
                  }
                  // MCP is a live RPC channel; replay cursors belong only to agent events.
                  controller.enqueue(
                    encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
                  );
                },
                previous,
                takeover,
                () => {
                  if (closed) return;
                  controller.enqueue(
                    encoder.encode("event: closed\ndata: {}\n\n"),
                  );
                  cleanup();
                  controller.close();
                },
              );
          cleanup = () => {
            if (closed) return;
            closed = true;
            clearInterval(heartbeat);
            this.listeners.delete(send);
            connection?.close();
          };
          this.listeners.add(send);
          controller.enqueue(
            encoder.encode(
              `event: ready\ndata: ${JSON.stringify({ version: 5, agentId: conf.id, connection: connection?.id, toolsHash })}\n\n`,
            ),
          );
          connection?.start();
          if (replay.snapshot) send(replay.snapshot.cursor, replay.snapshot);
          for (const event of replay.events) send(event.id, event.data);
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
