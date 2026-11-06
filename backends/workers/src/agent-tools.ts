import { retriesModelError } from "./model-errors.ts";
import { modelCompactionSettings } from "./model-context.ts";
import { withCompactionPrompt } from "./model-compaction.ts";
import { takesFiles } from './tool-file-schema.ts';
import { toolOutputExtension } from "./tool-output.ts";
import { assertContextRange, contextRangeExtension, contextRangeLimit } from "./context-range.ts";
import { toolCallSite } from "./tool-call-context.ts";
import { Harness, type ToolRegistration } from "@earendil-works/pi-durable";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { SessionCodemodeSandbox } from "../codemode/sandbox.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord";
import { PiHarness } from "agents/harness/pi";
import { computerTool } from "./computers/tool.ts";
import { askHuman, askUser, humanInputExtension } from "./human.ts";
import { volumeTools, type Mount } from "./files.ts";
import { attachedComputerTools } from "./computers/agent-tools.ts";
import { ComputerService } from "./computers/service.ts";
import { modelRuntime } from "./model.ts";
import { meterProvider, applyModelReceipt } from "./model-metering.ts";
import { keyServices } from "./security-services.ts";
import { runtimePromptSections } from "./prompt-sections.ts";
import type { AgentConfiguration } from "./api-contract.ts";
import { prioritizedTools } from "./tool-priority.ts";
import { compatibleFileTools } from "./fs-tools.ts";
import { sourceTools } from "./tool-sources.ts";
import { resolveCustomProviders } from "./model-credentials.ts";
import { resolveModelCredentials } from "./model-endpoints.ts";
import { decisionService, recordDecision } from "./decision-service.ts";
import { offersDecisions } from "./decision-runtime.ts";
import { hostExecutionTool } from "./host-execution.ts";
import { schemaAccepts } from "./output-validation.ts";
import { senderExtension } from "./sender-extension.ts";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { agentBuiltins } from "./agent-builtins.ts";
import { writtenFile, presentedFile } from "./file-output.ts";
import { selectAgentTools, wordedFileTools } from "./file-tool-selection.ts";
import { Env } from "./agent-types.ts";
import type { AgentRuntime } from "./agent-runtime.ts";

export function createDecisions(this: AgentRuntime): ReturnType<typeof decisionService> {
  return decisionService(
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
}

export function createModels(this: AgentRuntime): ReturnType<typeof modelRuntime> {
  return modelRuntime(
    this.env,
    async () => (await this.config()).tenantId,
    {
      agentId: async () => (await this.config()).id,
      onRetryEvent: async (event) => {
        await this.emit({ type: "event", requestId: (await this.currentRun()).id, event });
      },
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
        if (event.type === "toolcall_delta")
          await this.emit({ type: "event", requestId: run.id, event: {
            type: "message_update", assistantMessageEvent: {
              type: "toolcall_delta", contentIndex: event.contentIndex, delta: event.delta,
            },
          } });
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
            await this.dbProfile.run("settle", () => applyModelReceipt(this.env, receipt));
            await this.ctx.storage.delete(key);
          },
          async (context, stop) => {
            if (context.requestId) {
              await this.ctx.storage.put(`run-limit:${context.requestId}`, stop);
              await this.emit({ type: "event", requestId: context.requestId, event: { type: "spend_limit_reached", message: stop.error } });
            }
          },
          action => this.dbProfile.run("admission", action),
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
}

export async function computerNamesImpl(this: AgentRuntime) {
    if (!this.env.HYPERDRIVE) return new Set<string>();
    const conf = await this.config();
    return new Set(
      (await new ComputerService(this.env, conf.tenantId).tools(conf.id)).map(
        (tool) => tool.name,
      ),
    );
  }

export async function refreshComputerToolsImpl(this: AgentRuntime) {
    const conf = await this.config();
    const pi = await this.harness.pi(),
      root = await pi.root(BACKGROUND_CONTEXT);
    const enabled = await this.enabledTools(conf.config);
    await root.configure(enabled, BACKGROUND_CONTEXT);
  }

export async function enabledToolsImpl(this: AgentRuntime,
  config: AgentConfiguration) {
    return selectAgentTools(
      this.availableTools,
      new Set(this.workspaceToolNames),
      config,
      await this.computerNames(),
      this.env,
    );
  }

export function createHarness(this: AgentRuntime): PiHarness {
  return new PiHarness({
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
      this.modelCompaction = fixed => modelCompactionSettings(model, conf.config.maxOutputTokens, fixed);
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
        return { tenant: conf.tenantId, agent: conf.id, mounts: (conf.config.mounts ?? []) as Mount[], fileTools: conf.config.fileTools, codeMode: conf.config.codeMode, fileArguments: Object.fromEntries([...(conf.config.mcpServers ?? []), ...(conf.config.openApi ?? [])].map(source => [source.name, takesFiles(source)])), call: site };
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
      this.workspaceFileTools = tools;
      registry.install({
        name: "camel.files",
        tools: wordedFileTools(tools, conf.config),
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
            identity: { subject: conf.config.subject, context: conf.config.context },
            actor: ("actor" in run ? run.actor : undefined) ?? params?.actor as string | undefined,
            bucket: (params?.bucket as string | undefined) ?? conf.config.bucket ?? await this.ctx.storage.get<string>("run-bucket") ?? "default",
            files: (await this.sourceIdentity(api)).toolFiles('web_fetch'),
          };
        }, { schedules: this.scheduleTools() }),
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
                details: { output: args as JsonValue },
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
      const sandbox = new SessionCodemodeSandbox({ remote: this.sandboxRemote });
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
          registry: withCompactionPrompt(registry, fixed => this.modelCompaction?.(fixed)),
          onWake,
          settings: () => ({
            afterFailedRun: "withdraw",
            compaction: this.modelCompaction?.(0),
            retry: { enabled: this.retryModelFailure, maxRetries: 2, baseDelayMs: 500 },
          }),
        },
        context,
      );
    },
  });
}
