import { modelCompactionSettings } from "./model-context.ts";
import { forkSnapshot } from "./fork-snapshot.ts";
import { seedHistory, writeModelContext } from "./history-seed.ts";
import { errorCode } from "./errors.ts";
import { withMoneyMetrics } from "./money-metrics.ts";
import { type Message } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { BadRequest, boundedText, object, body } from "./validation.ts";
import { computerParameters } from "./computers/tool.ts";
import { compile } from "@earendil-works/pi-schema";
import { humanInputView, HumanInputs } from "./human.ts";
import { answerList } from "./input-policy.ts";
import { handleAgentFileRequest, handleAgentFilesRoute } from "./files.ts";
import { ComputerService } from "./computers/service.ts";
import { scheduleDeliveries, type StoredSchedule as Schedule } from "./schedules.ts";
import { keyServices } from "./security-services.ts";
import { admissionHeaders, admissionError, errorFields, errorHeaders } from "./admission.ts";
import { requestView } from "./request-view.ts";
import { waitForRequest } from "./request-wait.ts";
import type { AgentConfiguration } from "./api-contract.ts";
import { configuration } from "./api-contract.ts";
import { prioritizedTools } from "./tool-priority.ts";
import { sourceTools, toolSourceViews } from "./tool-sources.ts";
import { resolveCustomProviders } from "./model-credentials.ts";
import { offersDecisions } from "./decision-runtime.ts";
import { waitHostExecution } from "./host-execution.ts";
import { modelSettingsRefusal } from "./model-policy.ts";
import { agentBuiltins } from "./agent-builtins.ts";
import { resetContext } from "./context-reset.ts";
import { setAgentSpendLimit } from "./agent-spend.ts";
import { releasePresentedFiles } from "./file-output.ts";
import { Config, RequestRecord, Env, json, canonical, Child, reqKey } from "./agent-types.ts";
import type { AgentRuntime } from "./agent-runtime.ts";

export function replayedRequestImpl(this: AgentRuntime,
  record: RequestRecord) {
    this.replayedRequests.add(record);
    return record;
  }

export function requestResponseImpl(this: AgentRuntime,
  record: RequestRecord) {
    const headers = admissionHeaders(this.runRates.get(record.id));
    this.runRates.delete(record.id);
    return requestView(record).then(value => Response.json(value, { status: this.replayedRequests.has(record) ? 200 : 202, headers }));
  }

export async function activityImpl(this: AgentRuntime) {
    const records = (await this.records()).filter(record => !record.noticeQueued && ["prompt", "continue", "resume"].includes(record.method) && record.state !== "completed");
    const active = records.find(record => record.state === "running" && !record.steeredInto);
    return { busy: records.length > 0, activeRun: active?.id ?? null, queuedRuns: records.filter(record => record !== active).length };
  }

export async function stateImpl(this: AgentRuntime) {
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
    const spend = await this.agentSpend(await this.config());
    const lastActive = Math.max(this.recentEvents.lastActivity() ?? 0, (await this.ctx.storage.get<number>("last-active")) ?? 0);
    return {
      cursor: (await this.ctx.storage.get<number>("cursor")) ?? this.initialCursor,
      connected: this.attached.connected,
      spendLimit: spend ? { usd: spend.usd, spent: spend.spent } : null,
      ...activity,
      running: activity.busy || Date.now() - lastActive < Number((this.env as Env & { AGENT_IDLE_MS?: string }).AGENT_IDLE_MS ?? 60_000),
      events: this.recentEvents.read(),
      requests: await Promise.all((await this.records()).map(requestView)),
      ...(this.env.TEST_MODEL === "1"
        ? { localInstanceId: this.instanceId }
        : {}),
    };
  }

export async function historyImpl(this: AgentRuntime,
  url: URL) {
    const pi = await this.harness.pi(),
      root = await pi.root(BACKGROUND_CONTEXT);
    await this.historyIndex.sync(root);
    return this.historyIndex.read(url);
  }

export async function fetchImpl(this: AgentRuntime,
  request: Request): Promise<Response> {
    this.invalidateMaintenance();
    return withMoneyMetrics(this.env, () => this.fetchRequest(request));
  }

export async function fetchRequestImpl(this: AgentRuntime,
  request: Request): Promise<Response> {
    try {
      const url = new URL(request.url),
        path = url.pathname;
      // Public configuration edits become /requests; POST is the directory's
      // already-provisioned replacement for an existing keyed agent.
      if ((path === "/configuration" || path === "/configuration-target" || path === "/upsert") && request.method === "POST") {
        let record: RequestRecord;
        if (path === "/configuration-target") {
          const target = await body(request) as { id: string; config: AgentConfiguration; origin?: string };
          configuration(target.config, this.env.MODEL);
          record = await this.configureRequest({ id: target.id, method: 'configure', params: target.config }, true, target.origin);
        } else {
          record = await this.configureRequest(await body(request, (path === "/configuration" ? 17 : 6) * 1024 * 1024), true);
        }
        // Acceptance releases admission before application calls back into this DO.
        // A running turn leaves the queue pending and returns without waiting for it.
        await this.configurationQueue.settled();
        return json(await requestView(await this.ctx.storage.get<RequestRecord>(reqKey(record.id)) ?? record), 202);
      }
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
          this.modelCompaction = fixed => modelCompactionSettings(model, incoming.config.maxOutputTokens, fixed);
          const refusal = modelSettingsRefusal(model, incoming.config as never);
          if (refusal) throw new BadRequest(refusal);
          if (
            old &&
            canonical(old.config) !== canonical(incoming.config) &&
            (await this.harness.session().busy())
          )
            return json({ error: "Agent is busy" }, 409);
          if (!old && incoming.config.spendLimit !== undefined)
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
                identity: { subject: conf.config.subject, context: conf.config.context },
                actor: ("actor" in run ? run.actor : undefined) ?? params?.actor as string | undefined,
                bucket: (params?.bucket as string | undefined) ?? conf.config.bucket ?? await this.ctx.storage.get<string>("run-bucket") ?? "default",
                files: (await this.sourceIdentity(api)).toolFiles('web_fetch'),
              };
            }, { schedules: this.scheduleTools() }),
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
          if (await this.ctx.storage.get("deleted")) return json({ deleted: true });
          this.shuttingDown = true;
          await this.promptPreparations.cancel();
          const conf = await this.ctx.storage.get<Config>("configuration");
          await this.markCancelledRequests();
          await this.abortExecutions();
          if (conf)
            await this.serializeComputer(() =>
              new ComputerService(this.env, conf.tenantId).removeAgent(conf.id),
            );
          await this.delegation.destroy();
          await this.harness.session().abort();
          await this.cancelHumanInputs();
          // Settling still reads configuration and writes durable charge receipts.
          // Keep it available until every accepted operation has drained.
          for (const record of await this.records())
            if (record.accepted && record.state !== "completed") this.track(record.id);
          await Promise.all(this.pendingWaits.values());
          await this.eventsProcessed;
          if ((await this.records()).some(record => record.accepted && record.state !== "completed"))
            throw new Error("Agent shutdown is still settling accepted operations");
          await this.flushBilling(true);
          await this.ctx.storage.put("deleted", true);
          if (conf) await this.closeWatchers(conf.tenantId, conf.id);
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
        this.env.TEST_HOOKS === "1" &&
        request.method === "POST"
      ) {
        await this.flushBilling(true);
        return json({
          pending: (await this.ctx.storage.list({ prefix: "billing:" })).size,
        });
      }
      if (
        path === "/__test/settlement-state" &&
        this.env.TEST_HOOKS === "1" &&
        request.method === "GET"
      ) {
        const unaccepted = await this.testStorage.get<number>("test:host-unaccepted-task");
        return json({
          crashReached: !!(await this.testStorage.get("test:crash-reached")),
          pending: (await this.ctx.storage.list({ prefix: "billing:" })).size,
          hostFinishedAt: await this.testStorage.get<number>("test:host-finished-at"),
          unacceptedFinishedAt: unaccepted === undefined ? undefined : (await waitHostExecution(await this.harness.pi(), unaccepted as never)).endedAt,
        });
      }
      if (
        path === "/__test/crash-next-settlement" &&
        this.env.TEST_HOOKS === "1" &&
        request.method === "POST"
      ) {
        await this.testStorage.delete("test:crash-reached");
        await this.testStorage.delete("test:crash-owner");
        const input = (await body(request)) as { events?: boolean; beforeReceipt?: boolean; beforeAcceptance?: boolean };
        if (input.beforeAcceptance === true) {
          await this.testStorage.delete("test:host-unaccepted-task");
          await this.testStorage.put("test:crash-host-acceptance", true);
          return json({ armed: true });
        }
        if (input.beforeReceipt === true) {
          await this.testStorage.delete("test:host-finished-at");
          await this.testStorage.delete("test:host-stop-owner");
          await this.testStorage.put("test:crash-host-settlement", true);
          return json({ armed: true });
        }
        await this.testStorage.put(
          "test:crash-events",
          input.events === true,
        );
        await this.testStorage.put("test:crash-settlement", true);
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
          "bucket",
          "actor",
          "images",
          "attachments",
          "files",
        ]);
        const { idempotencyKey, requestId, ...params } = input;
        return this.requestResponse(
            await this.submit({
              id: requestId ?? idempotencyKey ?? crypto.randomUUID(),
              method: "prompt",
              params,
            }),
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
        return this.requestResponse(await this.submit(await body(request, 6 * 1024 * 1024)));
      if (path.startsWith("/requests/") && request.method === "GET") {
        const seconds = Number(url.searchParams.get("wait") ?? 0);
        if (!Number.isFinite(seconds) || seconds < 0) throw new BadRequest("wait is a number of seconds");
        const id = decodeURIComponent(path.slice(10));
        const record = await waitForRequest(() => this.settle(id, 1), wake => {
          this.listeners.add(wake);
          return () => this.listeners.delete(wake);
        }, Math.min(25000, seconds * 1000), request.signal);
        return json(await requestView(record));
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
        const input = object(await body(request, 17 * 1024 * 1024), ["model", "pinnedVolumes"]);
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
        const params = object(await body(request, 32 * 1024, true), ['queued', 'children']);
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
      if (path === "/credentials/rotate" && request.method === "POST") {
        await this.configurationQueue.settled();
        this.attached.close();
        for (const socket of this.ctx.getWebSockets()) this.retireAttachedSocket(socket);
        return json({ rotated: true });
      }
      if (path === "/events" && request.method === "GET") {
        const selected = await this.negotiateAgentEvents(request);
        if (selected) return selected;
        return request.headers.get("upgrade")?.toLowerCase() === "websocket"
          ? await this.webSocketEvents(request)
          : await this.events(request);
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
      return json({ error: "Unsupported backend operation", code: "NOT_FOUND" }, 404);
    } catch (error) {
      const limited = admissionError(error);
      if (limited) return limited;
      const status =
        error instanceof BadRequest
          ? 400
          : ((error as { status?: number }).status ??
            ((error as { code?: string }).code === "ENOENT" ? 404 : 500));
      return json(
        {
          ...errorFields(error),
          code: errorCode(error, status),
          ...("input" in Object(error) ? { input: (error as { input: unknown }).input } : {}),
          error:
            status >= 500
              ? "Backend operation failed"
              : error instanceof Error
                ? error.message
                : "Backend failure",
        },
        status,
        errorHeaders(error),
      );
    }
  }
