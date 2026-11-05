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
import {
  askHuman,
  askUser,
  answerHuman,
  humanInputView,
  HumanInputs,
  type HumanInput,
} from "./human.ts";
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
import { actorInput, bucketInput } from "./security-policy.ts";
import { MessageProjection } from "./message-projection.ts";
import { OUTPUT_REMINDER } from "./output-policy.ts";
import { runtimePromptSections } from "./prompt-sections.ts";
import { projectRunFailure } from "./run-failure.ts";
import { RunProjection } from "./run-projection.ts";
import { AgentHistory } from "./history.ts";
import type { AgentConfiguration } from "./api-contract.ts";
import { digest } from "./api-contract.ts";
import { AttachedTools } from "./attached-tools.ts";
import { compatibleFileTools } from "./fs-tools.ts";
import { sourceTools, toolSourceViews } from "./tool-sources.ts";
import { Delegation } from "./delegation.ts";
import { resolveDefinition, configurationPatch } from "./definitions.ts";
import {
  resolveProviderKey,
  resolveCustomProviders,
} from "./model-credentials.ts";
import { decisionService, recordDecision } from "./decision-service.ts";
import { offersDecisions } from "./decision-runtime.ts";
import {
  hostExecutionTool,
  hostExecutionRequest,
  startHostExecution,
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
import { forkWorkspaceMounts } from "./agent-workspace.ts";
import { agentMediaTools, flushAgentMediaUsage } from "./agent-media.ts";
import { selectFileTools } from "./file-tool-selection.ts";

type Config = {
  id: string;
  tenantId: string;
  revision: number;
  expiresAt: number | null;
  config: AgentConfiguration;
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
  private registry = createRegistry();
  private codeExtension?: Extension;
  private attached = new AttachedTools();
  private wakeBudget = new DelegationWakeBudget(this.ctx.storage);
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
  private notifications = new DelegationNotifications({
    storage: this.ctx.storage,
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
    context: async () => {
      const conf = await this.config();
      const run = await this.currentRun();
      return { id: conf.id, config: conf.config as never, run: run as never };
    },
    remainingBudget: async (background): Promise<number | undefined> => {
      const conf = await this.config(),
        run = await this.currentRun();
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
    create: async (config, key) => {
      const conf = await this.config();
      const directory = new Directory(this.env, conf.tenantId);
      const workspace = await forkWorkspaceMounts(
        (config as AgentConfiguration).mounts,
        conf.id,
        await directory.id(key),
      );
      const entry = await directory.upsert(
        { ...config, mounts: workspace.mounts },
        key,
        conf.runtimeOrigin,
      );
      if ("failed" in entry)
        throw Object.assign(new Error(entry.error), { status: entry.status });
      return entry;
    },
    target: async (ref) => {
      const conf = await this.config();
      if (ref.definition)
        return {
          config: (
            await resolveDefinition(this.env, conf.tenantId, ref.definition)
          ).spec as never,
        };
      const entry = await new Directory(this.env, conf.tenantId).get(
        ref.agent!,
      );
      if (!entry) throw new BadRequest("Unknown delegate agent");
      return { id: entry.id, config: entry.config as never };
    },
    fetch: (id, request) => this.env.AGENTS.getByName(id).fetch(request),
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
    retry: () => this.arm(Date.now() + 1000),
  });
  private decisions = decisionService(
    this.env,
    async () => {
      const conf = await this.config();
      const run = await this.currentRun();
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
      await recordDecision(this.env, context, usage, conf.id, this.active);
    },
  );
  private limits = new AgentRunLimits(this.ctx.storage, async () => {
    const conf = await this.config();
    return {
      config: conf.config,
      run: await this.currentRun(),
      agentId: conf.id,
      spend: await this.agentSpend(conf),
    };
  });
  private async currentRun() {
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
      async () => {
        const conf = await this.config(),
          run = await this.currentRun();
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
        onWrite: async (file) =>
          writtenFile(this.ctx.storage, await this.fileRequestId(), file),
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
          code: refusal.code,
        });
      const { accounts } = await keyServices(this.env);
      const limited = await accounts.runLimit(conf.tenantId);
      if (limited)
        throw typeof limited === "string"
          ? Object.assign(new Error(limited), { status: 402 })
          : limited;
      const { limit } = await accounts.billing.busyLimit(conf.tenantId);
      await runAdmission(this.env, conf.tenantId);
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
        });
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
      run = await this.currentRun(),
      params = "params" in run ? run.params : undefined;
    const issuer = this.env.AGENT_PUBLIC_URL || conf.runtimeOrigin;
    if (!issuer) throw new Error("Runtime public URL is not configured");
    return {
      issuer,
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
        req: run.id,
        tcid: api?.callId,
      },
    };
  }
  private models = modelRuntime(
    this.env,
    async () => (await this.config()).tenantId,
    {
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
          runLimits: {
            ...conf.config.runLimits,
            ...(params?.runLimits as object),
          },
        };
      },
      credentials: async (provider) => {
        const conf = await this.config();
        return resolveProviderKey(
          this.env,
          conf.tenantId,
          provider,
          conf.config.keyScope,
        );
      },
    },
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
      HOST_EXECUTION_TOOL,
      ...(config.codeMode === false ? ["computer", "exec", "codemode"] : []),
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
      this.models.resolve(
        conf.config.model,
        conf.config.runLimits?.contextTokens,
        await resolveCustomProviders(
          this.env,
          conf.tenantId,
          conf.config.keyScope,
        ),
      );
      registry.install(
        runtimePromptSections(
          async () => (await this.config()).config as never,
        ),
      );
      registry.install(senderExtension());
      registry.install(this.limits.extension());
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
        ),
      });
      registry.install({
        name: "camel.web",
        tools: await agentBuiltins(this.env, async () => {
          const conf = await this.config();
          const run = await this.currentRun();
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
        name: "camel.output-retry",
        hooks: [
          hook(GenerationTask, {
            onYield: async (_answer, api, context) => {
              const run = await this.currentRun();
              if (
                !("params" in run) ||
                !run.params?.output ||
                (await this.ctx.storage.get(`output:${run.id}`)) !== undefined
              )
                return;
              if (await this.ctx.storage.get(`output-reminded:${run.id}`))
                return;
              await this.ctx.storage.put(`output-reminded:${run.id}`, true);
              return { continue: OUTPUT_REMINDER };
            },
          }),
        ],
      });
      registry.install({
        name: "camel.output",
        tools: [
          {
            name: "final_output",
            description: "End the run with the requested structured output.",
            parameters: { type: "object", additionalProperties: true },
            replay: "safe",
            execute: async (args) => {
              const run = await this.currentRun();
              const schema = (
                "params" in run ? run.params?.output : undefined
              ) as { schema?: object } | undefined;
              if (!schema?.schema)
                throw new Error("This run has no output schema");
              if (!schemaAccepts(schema.schema, args)) {
                await this.ctx.storage.put(`output-invalid:${run.id}`, true);
                throw new Error("Output does not match the requested schema");
              }
              await this.ctx.storage.put(`output:${run.id}`, args);
              return {
                output: [{ type: "text", text: JSON.stringify(args) }],
                control: { terminate: true },
              };
            },
          },
        ],
      });
      registry.install({
        name: "camel.delegation",
        tools: this.delegation.tools(
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
  private async emit(event: unknown, delivery?: TerminalDelivery) {
    const work = this.serial.then(async () => {
      const cursor = await this.ctx.storage.transaction(async (tx) => {
        if (delivery && !(await acknowledgeTerminalEvent(tx, delivery)))
          return undefined;
        const next = ((await tx.get<number>("cursor")) ?? 1) + 1;
        await tx.put("cursor", next);
        this.eventLog.append(next, event);
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
        if (record?.steeredInto && record.state !== "completed") {
          record.state = "completed";
          record.endedAt = Date.now();
          record.outcome = {
            result: { steered: true, steeredInto: record.steeredInto },
          };
          await this.ctx.storage.put(reqKey(id), record);
          await this.emit({
            type: "event",
            requestId: record.steeredInto,
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
      if (this.partial) await this.projectMessage(id, this.partial, false);
    } else if (this.active) {
      const record = await this.ctx.storage.get<RequestRecord>(
        reqKey(this.active),
      );
      if (record?.state === "completed" && record.status !== "input_required")
        this.active = undefined;
    }
  }
  private async onHuman(doc: { requests: Record<string, HumanInput> }) {
    const id = this.active ?? (await this.currentRun()).id;
    const pending = Object.entries(doc?.requests ?? {}).filter(
      ([, input]) => input.answer === undefined,
    );
    if (pending.length) {
      const conf = await this.config();
      const inputs = pending.map(([key, input]) =>
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
      const record = await this.ctx.storage.get<RequestRecord>(reqKey(id));
      if (record?.state === "running") {
        const conf = await this.config();
        record.state = "completed";
        record.status = "input_required";
        record.endedAt = Date.now();
        record.outcome = {
          result: { stopped: "input_required", inputs, reply: "" },
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
      const result = await waitHostExecution(
        await this.harness.pi(),
        record.task as never,
      );
      const current = await this.ctx.storage.get<RequestRecord>(reqKey(id));
      if (current?.state === "completed") return current;
      const completed: RequestRecord = {
        ...record,
        state: "completed",
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
          : { result },
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
      const outputInvalid = await this.ctx.storage.get(`output-invalid:${id}`);
      const limit = await this.ctx.storage.get<RuntimeLimit>(`run-limit:${id}`);
      const outcome = limit
        ? { result: limit }
        : result.status === "done"
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
                  ...(usage.imageCostUsd > 0
                    ? { imageCostUsd: usage.imageCostUsd }
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
                },
                servedModel: usage.last
                  ? `${usage.last.provider}/${usage.last.model}`
                  : (record.billing?.model ?? stored?.config.model),
                toolCalls: usage.toolCalls ?? [],
                toolErrors: usage.toolErrors ?? [],
                replyIndex: usage.replyIndex,
                ...(await fileOutputs(this.ctx.storage, id)),
                ...(outputValue !== undefined
                  ? { output: outputValue }
                  : requestedOutput
                    ? {
                        error: outputInvalid
                          ? "The model's output did not match the requested schema"
                          : "The model did not return the requested structured output",
                        code: outputInvalid
                          ? "output_invalid"
                          : "output_missing",
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
  private async abortRequests() {
    const pending = await this.harness.pending();
    const cancelled = pending
      .filter((item) => item.status === "queued")
      .map((item) => item.operationId);
    await this.delegation.cancel();
    for (const running of await this.records())
      if (running.method === "execute" && running.state !== "completed")
        await abortHostExecution(await this.harness.pi(), running.id);
    await this.harness.session().abort();
    const conf = await this.config();
    for (const id of cancelled) {
      const record = await this.ctx.storage.get<RequestRecord>(reqKey(id));
      if (!record || record.state === "completed") continue;
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
      await this.emit({ type: "response", id, outcome: record.outcome });
    }
    return { aborted: true, cancelled };
  }
  private async configureRequest(input: unknown) {
    const request = object(input, ["id", "method", "params"]);
    const id = boundedText(request.id, "id", 80);
    if (!/^[A-Za-z0-9_-]+$/.test(id))
      throw new BadRequest("Invalid request id");
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
    const conf = await this.config();
    if (
      !request.params ||
      typeof request.params !== "object" ||
      Array.isArray(request.params)
    )
      throw new BadRequest("Expected configuration object");
    const params = request.params as Record<string, unknown>;
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
      if (old) return old;
      const pi = await this.harness.pi(),
        root = await pi.root(BACKGROUND_CONTEXT);
      const tool = this.availableTools.find(
        (tool) => tool.name === HOST_EXECUTION_TOOL,
      )!;
      const task = await startHostExecution(pi, root, id, params, tool);
      const record: RequestRecord = {
        id,
        method: "execute",
        fingerprint,
        task: task as number,
        params: { ...params, ...(actor ? { actor } : {}) },
        accepted: true,
        state: "running",
        startedAt: Date.now(),
      };
      await this.ctx.storage.put(reqKey(id), record);
      this.track(id);
      return record;
    }
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
      const stopped = await this.abortRequests();
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
                  busy: await this.harness.session().busy(),
                  connected: this.attached.connected,
                  queuedRuns: (await this.harness.pending()).filter(
                    (item) => item.status === "queued",
                  ).length,
                }
              : { compacted: true },
        },
      };
      await this.ctx.storage.put(reqKey(id), record);
      await this.emit({ type: "response", id, outcome: record.outcome });
      return record;
    }
    if (request.method !== "prompt" && request.method !== "continue")
      throw new BadRequest("Unsupported request method");
    const params = object(request.params, [
      "text",
      "allowDisconnected",
      "history",
      "metadata",
      "from",
      "attachments",
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
    const fingerprint = canonical({ method: request.method, params });
    const old = await this.ctx.storage.get<RequestRecord>(reqKey(id));
    if (old && old.fingerprint !== fingerprint)
      throw Object.assign(new Error("Request id reused with different input"), {
        status: 409,
      });
    if (old?.state === "completed") return old;
    const conf = await this.config();
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
        new Error("No process is connected to serve this agent's tools"),
        { status: 409, code: "APPLICATION_NOT_CONNECTED" },
      );
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
      fingerprint,
      state: running ? "queued" : "running",
      ...(params.whileRunning === "steer"
        ? running
          ? { steer: "accepted" as const, steeredInto: running.operationId }
          : { steer: "queued" as const }
        : {}),
      startedAt: Date.now(),
    };
    const prompt = params.images
      ? imageReferenceInput(text, params.images as ImageRef[], conf.tenantId)
      : text;
    await this.ctx.storage.put(reqKey(id), record);
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
    if (!old?.admitted) {
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
    else
      await this.harness.submit(prompt, {
        operationId: id,
        whenBusy: params.whileRunning === "steer" ? "steer" : "followUp",
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
      });
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
    await this.historyIndex.sync(root);
    return this.historyIndex.read(url);
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
          );
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
          const pi = await this.harness.pi(),
            root = await pi.root(BACKGROUND_CONTEXT);
          if (!old && incoming.config.initialMessages?.length) {
            for (const message of incoming.config.initialMessages) {
              const imported = await root.submit(
                {
                  type: "write",
                  entry: { kind: "camel.import", model: [message] as never },
                },
                BACKGROUND_CONTEXT,
              );
              await imported.wait(BACKGROUND_CONTEXT);
            }
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
            ),
          });
          this.registry.install({
            name: "camel.web",
            tools: await agentBuiltins(this.env, async () => {
              const conf = await this.config();
              const run = await this.currentRun();
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
          this.availableTools = this.registry
            .snapshot()
            .tools()
            .map(({ tool }) => tool);
          const enabled = await this.enabledTools(incoming.config);
          await root.configure(
            {
              model: { provider: model.provider, modelId: model.id },
              instructions: [
                incoming.config.systemPrompt,
                incoming.config.systemPromptAppend,
              ]
                .filter(Boolean)
                .join("\n\n"),
              maxTurns: incoming.config.runLimits?.maxResponses ?? 1000,
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
          const conf = await this.ctx.storage.get<Config>("configuration");
          if (conf)
            await this.serializeComputer(() =>
              new ComputerService(this.env, conf.tenantId).removeAgent(conf.id),
            );
          await this.ctx.storage.put("deleted", true);
          await this.delegation.cancel();
          await this.harness.session().abort();
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
        const input = object(await body(request), [
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
        ]);
        const { idempotencyKey, requestId, ...params } = input;
        return json(
          await this.submit({
            id: requestId ?? idempotencyKey ?? crypto.randomUUID(),
            method: "prompt",
            params,
          }),
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
          );
          this.registry.install({ name: "camel.sources", tools });
          this.availableTools = this.registry
            .snapshot()
            .tools()
            .map(({ tool }) => tool);
        }
        const sources = toolSourceViews(
          conf.config as never,
          (await this.enabledTools(conf.config)).tools,
          this.attached.connected,
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
        return json(values);
      }
      if (path.startsWith("/inputs/") && request.method === "POST") {
        // Answering a native Pi document can resume the tool immediately. Hold
        // projection until its durable resume alias exists, so its result is
        // streamed to the resumed request even when the remote tool is fast.
        let releaseProjection!: () => void;
        const gate = new Promise<void>((resolve) => {
          releaseProjection = resolve;
        });
        const before = this.eventsProcessed;
        this.eventsProcessed = before.then(() => gate);
        await before;
        try {
          const id = decodeURIComponent(path.slice(8)),
            input = await body(request);
          const pi = await this.harness.pi(),
            root = await pi.root(BACKGROUND_CONTEXT),
            conf = await this.config();
          const snapshot = await pi.snapshot(HumanInputs, BACKGROUND_CONTEXT);
          const pending = snapshot?.requests[id];
          if (!pending)
            throw Object.assign(new Error("Unknown input"), { status: 404 });
          const answer = answerHuman(pending, input);
          if (pending.answer !== undefined && pending.answer !== answer.answer)
            throw Object.assign(new Error("Already answered"), { status: 409 });
          const owner =
            (await this.ctx.storage.get<string>(`input-owner:${id}`)) ??
            this.active;
          let resume: RequestRecord | undefined;
          let created = false;
          if (
            owner &&
            !Object.entries(snapshot?.requests ?? {}).some(
              ([key, input]) => key !== id && input.answer === undefined,
            )
          ) {
            const old = (await this.ctx.storage.get<RequestRecord>(
              reqKey(owner),
            ))!;
            const piId = old.piId ?? owner;
            const resumeId = `resume-${id}`.slice(0, 80);
            resume = await this.ctx.storage.get<RequestRecord>(
              reqKey(resumeId),
            );
            if (!resume) {
              await this.flushBilling(true);
              await this.admitRequest(conf, resumeId);
              resume = {
                ...old,
                id: resumeId,
                piId,
                method: "resume",
                state: "running",
                status: undefined,
                outcome: undefined,
                startedAt: Date.now(),
                began: Date.now(),
                endedAt: undefined,
              };
              await this.ctx.storage.put(reqKey(resumeId), resume);
              await this.ctx.storage.put(`resume-for:${piId}`, resumeId);
              created = true;
            }
            this.active = resumeId;
          }
          let item!: HumanInput;
          try {
            await root.commit(async (tx) => {
              const doc = await tx.doc(HumanInputs),
                current = doc.requests[id];
              if (
                current.answer !== undefined &&
                current.answer !== answer.answer
              )
                throw Object.assign(new Error("Already answered"), {
                  status: 409,
                });
              Object.assign(current, answer);
              item = JSON.parse(JSON.stringify(current));
            }, BACKGROUND_CONTEXT);
          } catch (error) {
            if (created && resume) {
              await this.ctx.storage.delete(reqKey(resume.id));
              await this.ctx.storage.delete(`resume-for:${resume.piId}`);
              await releaseTurn(this.env, conf.tenantId, conf.id, resume.id);
              await this.env.TENANTS.getByName(conf.tenantId).release(
                `${conf.id}:${resume.id}`,
              );
              this.active = owner;
            }
            throw error;
          }
          await this.emit({
            type: "event",
            requestId: owner,
            event: { type: "input_resolved", id },
          });
          if (resume) {
            this.track(resume.id);
            await this.arm();
          }
          return json({
            answered: true,
            input: humanInputView(id, item, conf.id, owner),
            request: resume ?? null,
          });
        } finally {
          releaseProjection();
        }
      }
      if (path === "/abort" && request.method === "POST") {
        const stopped = await this.abortRequests();
        await this.state();
        return json(stopped);
      }
      if (path === "/context/reset" && request.method === "POST") {
        const input = object(await body(request), ["summary", "keepMessages"]);
        const work = this.admission.then(async () => {
          const pi = await this.harness.pi(),
            root = await pi.root(BACKGROUND_CONTEXT);
          if (await this.harness.session().busy())
            throw Object.assign(new Error("Agent is busy"), { status: 409 });
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
        const selected = negotiateEvents(request);
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
    const conf = await this.config();
    const [auxiliary, subagentCostUsd] = await Promise.all([
      auxiliaryRunCosts(this.env, conf.tenantId, conf.id, id),
      this.delegation.cost(id),
    ]);
    const projection = new RunProjection(id);
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
      await this.ctx.storage.put("deleted", true);
      await this.delegation.cancel();
      await this.harness.session().abort();
      // Unsettled turns are still charged from their durable receipts below.
      await this.flushBilling();
      return;
    }
    await this.flushBilling();
    await this.flushTerminalEvents();
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
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );
    pair[1].send(eventFrame({}, undefined, "ready"));
    pair[1].send(
      eventFrame(
        {
          type: "snapshot",
          cursor: state.cursor,
          requestId: this.active ?? null,
          turn: this.active
            ? { start: null, count: 0, messages: [], partial: this.partial }
            : null,
        },
        state.cursor,
      ),
    );
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
  async webSocketMessage(socket: WebSocket, _data: string | ArrayBuffer) {
    socket.close(1008, "Read-only event stream");
  }
  async webSocketClose(socket: WebSocket, code: number) {
    socket.close(code, "Closed");
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
