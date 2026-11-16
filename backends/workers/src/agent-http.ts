import { agentRepoId } from "./repos/identity.ts";
import { workspaceRefKey } from "./repos/tree-cache.ts";
import type { AgentInvocation } from "./agent-invocation.ts";
import { placementOf, type Placement } from "../../../shared/owner.ts";
import { checkRequest } from "../../../shared/monitors.ts";
import { monitorRoutes, monitorToolsHost } from "./agent-monitors.ts";
import { answerInboxGroup, type InboxAnswer } from "../../../shared/inbox-answers.ts";
import { answerInput, mayAnswer } from "./input-policy.ts";
import { HttpError } from "./errors.ts";
import { inputView } from "./decision-inputs.ts";
import { decisionInputs, answerDecisions } from "./inbox-decisions.ts";
import { repairInputMirrors } from "./agent-input-mirror.ts";
import { forkComputerInto } from "./computers/child-fork.ts";
import { modelCompactionSettings } from "./model-context.ts";
import { forkSnapshot } from "./fork-snapshot.ts";
import { seedHistory, writeModelContext } from "./history-seed.ts";
import { errorCode, errorStatus } from "./errors.ts";
import { failure } from "./observability.ts";
import { withMoneyMetrics } from "./money-metrics.ts";
import { type Message } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { BadRequest, object, body } from "./validation.ts";
import { humanInputView, HumanInputs } from "./human.ts";
import { answerList } from "./input-policy.ts";
import { handleAgentFileRequest, handleAgentFilesRoute } from "./files.ts";
import { ComputerService } from "./computers/service.ts";
import { deliverScheduledRun, scheduleDeliveries, type StoredSchedule as Schedule } from "./schedules.ts";
import { keyServices } from "./security-services.ts";
import { admissionHeaders, admissionError, errorFields, errorHeaders } from "./admission.ts";
import { requestView } from "./request-view.ts";
import { childrenView } from "./delegation.ts";
import { waitForRequest } from "./request-wait.ts";
import { wordedFileTools } from "./file-tool-selection.ts";
import type { DefinitionTarget } from "./definitions.ts";
import { prioritizedTools } from "./tool-priority.ts";
import { sourceTools, toolSourceViews } from "./tool-sources.ts";
import { resolveCustomProviders } from "./model-credentials.ts";
import { offersDecisions } from "./decision-runtime.ts";
import { waitHostExecution } from "./host-execution.ts";
import { modelSettingsRefusal } from "./model-policy.ts";
import { agentBuiltins } from "./agent-builtins.ts";
import { resetContext } from "./context-reset.ts";
import { setAgentSpendLimit } from "./agent-spend.ts";
import { flushCompletedSettlement } from "./agent-turn-loop.ts";
import { Config, RequestRecord, Env, json, canonical, reqKey } from "./agent-types.ts";
import type { AgentRuntime } from "./agent-runtime.ts";

export function replayedRequestImpl(this: AgentRuntime,
  record: RequestRecord) {
    this.replayedRequests.add(record);
    return record;
  }

export async function requestResponseImpl(this: AgentRuntime,
  invocation: AgentInvocation,
  record: RequestRecord) {
    const headers = admissionHeaders(this.runRates.get(record.id));
    this.runRates.delete(record.id);
    const replayed = this.replayedRequests.has(record);
    if (replayed && record.state === "completed" && await this.ctx.storage.get(`billing:${record.id}`)) {
      await flushCompletedSettlement(propagate => this.flushBilling(invocation, propagate));
      const latest = await this.ctx.storage.get<RequestRecord>(reqKey(record.id));
      if (!latest) throw new HttpError(404, "Unknown request");
      record = latest;
    }
    return requestView(record).then(value => Response.json(value, { status: replayed ? 200 : 202, headers }));
  }

export async function activityImpl(this: AgentRuntime) {
    const records = (await this.records()).filter(record => !record.noticeQueued && ["prompt", "continue", "resume"].includes(record.method) && record.state !== "completed");
    const active = records.find(record => record.state === "running" && !record.steeredInto);
    return { busy: records.length > 0, activeRun: active?.id ?? null, queuedRuns: records.filter(record => record !== active).length };
  }

export async function stateImpl(this: AgentRuntime, invocation: AgentInvocation) {
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
        .map((record) => this.settle(record.id, 1, invocation)),
    );
    const activity = await this.activity();
    const spend = await this.agentSpend(await this.config(), undefined, invocation);
    const lastActive = Math.max(this.recentEvents.lastActivity() ?? 0, (await this.ctx.storage.get<number>("last-active")) ?? 0);
    // A turn that suspended from code left nothing running: the agent is idle at once, until anything happens again.
    const unloaded = (await this.ctx.storage.get<number>("unloaded-at")) ?? 0;
    return {
      cursor: (await this.ctx.storage.get<number>("cursor")) ?? this.initialCursor,
      connected: this.attached.connected,
      spendLimit: spend ? { usd: spend.usd, spent: spend.spent } : null,
      ...activity,
      running: activity.busy || lastActive > unloaded && Date.now() - lastActive < Number((this.env as Env & { AGENT_IDLE_MS?: string }).AGENT_IDLE_MS ?? 60_000),
      events: this.recentEvents.read(),
      // A monitor's checks are not listed with the agent's requests: its own check log has them.
      requests: await Promise.all((await this.records()).filter(record => !checkRequest(record.id)).map(requestView)),
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

export async function fetchImpl(this: AgentRuntime, invocation: AgentInvocation,
  request: Request): Promise<Response> {
    this.invalidateMaintenance();
    return withMoneyMetrics(this.env, () => this.fetchRequest(invocation, request));
  }

/**
 * A child run its owner starts (delegation.ts `submitChild`): admitted like a prompt, with its placement stored on the
 * run. Binding-only, so a placement never comes from a public request. Refusals answer as the HTTP route would.
 */
export async function admitDelegatedImpl(this: AgentRuntime, invocation: AgentInvocation,
  input: unknown, placement: Placement): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
    this.invalidateMaintenance();
    return withMoneyMetrics(this.env, async () => {
      try {
        await this.config();
        // As the HTTP path did for a child's start (`fetch POST https://agent/requests` stored its request's origin).
        await this.ctx.storage.put("file-origin", "https://agent");
        await this.submit(invocation, input, undefined, undefined, undefined, undefined, placementOf(placement));
        return { ok: true as const };
      } catch (error) {
        const limited = admissionError(error);
        if (limited) {
          const detail = await limited.json().catch(() => undefined) as { error?: unknown } | undefined;
          return { ok: false as const, status: limited.status, error: typeof detail?.error === "string" ? detail.error : "Child submission refused" };
        }
        const status = error instanceof BadRequest ? 400 : ((error as { status?: number }).status ?? errorStatus(error, 500));
        if (status >= 500) failure(this.env, "agent_http_failed", error);
        return { ok: false as const, status, error: status >= 500 ? "Backend operation failed" : error instanceof Error ? error.message : "Backend failure" };
      }
    });
  }

export async function fetchRequestImpl(this: AgentRuntime, invocation: AgentInvocation,
  request: Request): Promise<Response> {
    try {
      const url = new URL(request.url),
        path = url.pathname;
      // Public configuration edits become /requests; POST is the directory's
      // already-provisioned replacement for an existing keyed agent.
      if ((path === "/configuration" || path === "/configuration-target" || path === "/upsert") && request.method === "POST") {
        let record: RequestRecord;
        if (path === "/configuration-target") {
          // A definition revision, merged with this agent's configuration when it applies (applyConfigurationRequest).
          const target = await body(request) as { id: string; definition: DefinitionTarget; origin?: string };
          record = await this.configureRequest({ id: target.id, method: 'configure', params: { applyDefinition: target.definition } }, true, target.origin);
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
            invocation,
          );
          const model = this.models.resolve(
            incoming.config.model,
            incoming.config.runLimits?.contextTokens,
            providers,
            (await keyServices(this.env, invocation)).tenants.modelEndpoints(incoming.tenantId),
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
              undefined,
              invocation,
            );
          await this.ctx.storage.put("configuration", incoming);
          const workspace = agentRepoId(incoming.tenantId, incoming.id);
          this.repoTrees.retainHeads((incoming.config.mounts ?? []).filter(mount => mount.repo === workspace)
            .map(mount => workspaceRefKey(`${incoming.tenantId}:${workspace}`, mount.ref ?? "main")));
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
            // A sub-agent has no schedules (createScheduleImpl refuses them): it is offered no schedule tools.
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
                networking: conf.config.networking,
                builtins: conf.config.builtins,
                webSearch: conf.config.webSearch,
                keyScope: conf.config.keyScope,
                identity: { subject: (params?.endUser as string | undefined) ?? conf.config.subject, context: conf.config.context },
                actor: ("actor" in run ? run.actor : undefined) ?? params?.actor as string | undefined,
                bucket: (params?.bucket as string | undefined) ?? conf.config.bucket ?? await this.ctx.storage.get<string>("run-bucket") ?? "default",
                files: (await this.sourceIdentity(api)).toolFiles('web_fetch'),
              };
            }, { schedules: incoming.config.type === "subagent" ? undefined : this.scheduleTools(), monitors: incoming.config.type === "subagent" ? undefined : monitorToolsHost(this) }),
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
          const messaging = this.channels.messaging(async () => this.config(), async api => { const run = await this.currentRun(api as never); return run.id === "background" ? undefined : run.id; },
            incoming.config.type === "channel", await this.delegation.toolsFor(incoming.config.delegate ?? {}, incoming.config.builtins ?? [], incoming.config.type === "subagent"));
          this.registry.install({ name: "camel.channels", tools: messaging.channels });
          this.registry.install({ name: "camel.delegation", tools: messaging.delegation });
          this.registry.install({ name: "camel.files", tools: wordedFileTools(this.workspaceFileTools, incoming.config), sections: [] });
          this.availableTools = prioritizedTools(this.registry.snapshot().tools());
          const enabled = await this.enabledTools(incoming.config, invocation);
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
          await this.arm(undefined, invocation);
          await this.observe();
          return json(incoming);
        });
        this.admission = mutation.catch(() => {});
        // Awaited, so a failed apply answers here (the directory's retry applies it again) rather than rejecting the stub's fetch.
        return await mutation;
      }
      if (request.method === "DELETE" && path === "/") {
        const deletion = this.admission.then(async () => {
          if (await this.ctx.storage.get("deleted")) return json({ deleted: true });
          this.shuttingDown = true;
          await this.promptPreparations.cancel();
          const conf = await this.ctx.storage.get<Config>("configuration");
          await this.markCancelledRequests();
          await this.abortExecutions(invocation);
          // Its bash VMs end before its files are released: a VM's ref lease would refuse the ref deletion.
          if (conf) await this.bashSessions.stopAll();
          if (conf)
            await this.serializeComputer(() =>
              new ComputerService(this.env, conf.tenantId, undefined, {
                agent: conf.id, clearComputerAttached: () => this.clearComputerAttached(),
              }).removeAgent(conf.id),
            );
          await this.delegation.destroy();
          await this.harness.session().abort();
          const retired = await this.env.COMPUTER_CONTAINERS?.getByName(this.ctx.id.toString()).purge();
          if (retired?.settled === false) throw new HttpError(503, "Computer usage settlement is pending");
          await this.cancelHumanInputs();
          // Settling still reads configuration and writes durable charge receipts.
          // Keep it available until every accepted operation has drained.
          for (const record of await this.records())
            if (record.accepted && record.state !== "completed") this.track(record.id);
          await Promise.all(this.pendingWaits.values());
          await this.eventsProcessed;
          if ((await this.records()).some(record => record.accepted && record.state !== "completed"))
            throw new Error("Agent shutdown is still settling accepted operations");
          await this.flushBilling(invocation, true);
          await this.ctx.storage.put("deleted", true);
          this.repoTrees.retainHeads([]);
          if (conf) await this.closeWatchers(conf.tenantId, conf.id);
          for (const listener of this.listeners) listener(0, null);
          // Planned as a deleted agent now: it wakes only for what it still owes, or goes quiet (settleDeleted).
          await this.arm(undefined, invocation);
          return json({ deleted: true });
        });
        this.admission = deletion.catch(() => {});
        // Awaited, so a failed shutdown answers here (a retry finishes it) rather than rejecting the stub's fetch.
        return await deletion;
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
        // Connections change outside this object; recheck before skipping a lease deadline.
        await this.clearComputerAttached();
        // The fork route: its snapshot takes the serial queue itself (forkChildComputers), so it runs outside it.
        if (input.operation === "fork")
          return json(await forkComputerInto(this.env, conf.tenantId, conf.id, input.args.agents,
            run => this.serializeComputer(run), input.args.byConnection === true), 201);
        return await this.serializeComputer(async () => {
          const service = new ComputerService(this.env, conf.tenantId, undefined, {
            agent: conf.id, clearComputerAttached: () => this.clearComputerAttached(),
          });
          if (input.operation === "sweep") {
            await service.sweepAgent(conf.id);
            await this.arm(undefined, invocation);
            return json({ swept: true });
          }
          if (input.operation === "refresh") {
            await this.refreshComputerTools(invocation);
            return json({ refreshed: true });
          }
          if (input.operation === "remove") {
            const removed = await service.remove(conf.id);
            await this.refreshComputerTools(invocation);
            return json(removed);
          }
          if (input.operation === "confirm-cleanup")
            return json(await service.confirmCleanup(conf.id));
          if (input.operation === "release") {
            await service.release(conf.id);
            await this.arm(undefined, invocation);
            return json({ released: true });
          }
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
            await this.arm(undefined, invocation);
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
        await this.flushBilling(invocation, true);
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
          inputEmitReached: !!(await this.testStorage.get("test:input-emit-owner")),
          pending: (await this.ctx.storage.list({ prefix: "billing:" })).size,
          settleFailing: (await this.ctx.storage.list({ prefix: "settle-failing:", limit: 1 })).size > 0,
          hostFinishedAt: await this.testStorage.get<number>("test:host-finished-at"),
          unacceptedFinishedAt: unaccepted === undefined ? undefined : (await waitHostExecution(await this.harness.pi(), unaccepted as never)).endedAt,
        });
      }
      if (path === "/__test/crash-input-before-emit" && this.env.TEST_HOOKS === "1" && request.method === "POST") {
        await this.testStorage.put("test:crash-input-emit", true);
        return json({ armed: true });
      }
      if (
        path === "/__test/crash-next-settlement" &&
        this.env.TEST_HOOKS === "1" &&
        request.method === "POST"
      ) {
        await this.testStorage.delete("test:crash-reached");
        await this.testStorage.delete("test:crash-owner");
        const input = (await body(request)) as { events?: boolean; beforeReceipt?: boolean; beforeAcceptance?: boolean; stuckFailures?: number; stuckMs?: number };
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
        if (typeof input.stuckFailures === "number" || typeof input.stuckMs === "number") {
          await this.testStorage.put("test:settle-stuck", { failures: input.stuckFailures, ms: input.stuckMs });
        } else {
          await this.testStorage.delete("test:settle-stuck");
        }
        await this.testStorage.put("test:crash-settlement", true);
        return json({ armed: true });
      }
      if (path === "/schedules" && request.method === "GET")
        return json([
          ...(await this.ctx.storage
            .list<Schedule>({ prefix: "schedule:" })
            .then((x) =>
              [...x.values()].filter((schedule) => !schedule.monitor).sort(
                (a, b) => a.dueAt - b.dueAt || a.id.localeCompare(b.id),
              ),
            )),
        ]);
      const monitors = await monitorRoutes(this, path, request, body);
      if (monitors) return json(monitors.value, monitors.status ?? 200);
      if (path === "/schedules" && request.method === "POST")
        return json(await this.createSchedule(await body(request)), 201);
      if (/^\/schedules\/[^/]+\/run$/.test(path) && request.method === "POST") {
        const schedule=await this.ctx.storage.get<Schedule>(`schedule:${decodeURIComponent(path.split('/')[2])}`);
        // A monitor's check is never run as a plain schedule, as on Node.
        if(!schedule || schedule.monitor) throw new HttpError(404,'Unknown schedule');
        return json(await deliverScheduledRun(this.env,schedule,`schedule-run-${crypto.randomUUID()}`,input=>this.submit(invocation, input),work=>this.ctx.waitUntil(work)),202);
      }
      if (path.startsWith("/schedules/") && request.method === "DELETE") {
        const deleted = await this.ctx.storage.delete(
          `schedule:${decodeURIComponent(path.slice(11))}`,
        );
        await this.arm(undefined, invocation);
        return json({ deleted });
      }
      // Internal lineage for transcript consolidation includes every retained child, including named targets.
      if (path === "/conversation-children" && request.method === "GET")
        return json({ children: [...new Set((await this.delegation.children()).map(child => child.id).filter(Boolean))] });
      // The public list (GET /v1/agents/{id}/children, as on Node).
      if (path === "/children" && request.method === "GET")
        return json({ children: childrenView(await this.delegation.children()) });
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
          "endUser",
          "actor",
          "images",
          "attachments",
          "files",
        ]);
        const { idempotencyKey, requestId, ...params } = input;
        return await this.requestResponse(invocation,
            await this.submit(invocation, {
              id: requestId ?? idempotencyKey ?? crypto.randomUUID(),
              method: "prompt",
              params,
            }, undefined, undefined, undefined, request.headers.get("x-camel-shared-owner") === "1" ? "owner" : undefined),
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
          (await this.enabledTools(conf.config, invocation)).tools,
          this.attached.connected,
          this.sourceFailures,
          refresh === "true" || (await this.state(invocation)).running,
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
        return json(await this.state(invocation));
      if (path === "/requests" && request.method === "POST")
        return await this.requestResponse(invocation, await this.submit(invocation, await body(request, 6 * 1024 * 1024)));
      if (path.startsWith("/requests/") && request.method === "GET") {
        const seconds = Number(url.searchParams.get("wait") ?? 0);
        if (!Number.isFinite(seconds) || seconds < 0) throw new BadRequest("wait is a number of seconds");
        const id = decodeURIComponent(path.slice(10));
        const record = await waitForRequest(() => this.settle(id, 1, invocation), wake => {
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
        const input = object(await body(request, 17 * 1024 * 1024), ["model"]);
        if (!Array.isArray(input.model)) throw new BadRequest("Expected model context");
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
        const values: Array<ReturnType<typeof humanInputView> | ReturnType<typeof inputView>> = (await decisionInputs(this, invocation).list(conf.tenantId, { agent: conf.id, ...(url.searchParams.get("state") ? { state: url.searchParams.get("state")! } : {}) })).filter(row => row.blocking === false).map(row => ({ ...inputView(row), question: row.message }));
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
            "withdrawn",
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
      if (path === "/_input-mirror" && request.method === "POST") {
        const input = await body(request) as { tenant: string; ids: string[] };
        const conf = await this.config();
        if (input.tenant !== conf.tenantId) throw new BadRequest("Tenant mismatch");
        if (!Array.isArray(input.ids) || input.ids.length > 100 || input.ids.some(id => typeof id !== "string"))
          throw new BadRequest("Expected at most 100 input IDs");
        const missing = await repairInputMirrors(this, input.ids);
        return json({ refreshed: true, missing });
      }
      if (path === "/inbox-answers" && request.method === "POST") {
        const input = await body(request) as { answers: InboxAnswer[] };
        const conf = await this.config();
        const internal = (method: string, pathname: string, data?: unknown) => {
          const url = new URL(request.url); url.pathname = pathname;
          return this.fetch(invocation, new Request(url, { method, headers: { "Content-Type": "application/json" }, ...(data ? { body: JSON.stringify(data) } : {}) }));
        };
        const read = async (id: string) => {
          const decision = await decisionInputs(this, invocation).get(id);
          if (decision?.agent === conf.id && decision.tenant === conf.tenantId && decision.blocking === false) return { ...inputView(decision), fixedResponders: decision.stored.fixedResponders };
          const pi = await this.harness.pi(), doc = await pi.snapshot(HumanInputs, BACKGROUND_CONTEXT);
          const pending = doc?.requests[id];
          return pending ? { ...humanInputView(id, pending, conf.id), fixedResponders: pending.fixedResponders, policyBound: pending.policyBound } : undefined;
        };
        const outcomes = await answerInboxGroup(input.answers, read, (view, answer) => {
          if (!mayAnswer(view, { via: "api", actor: answer.actor, from: answer.from }, view.fixedResponders ? [] : conf.config.humanInput?.approvers as string[] | undefined))
            throw Object.assign(new Error("This person may not answer this input"), { status: 403 });
          if (view.blocking && !view.policyBound) throw Object.assign(new Error("The input is not ready"), { status: 409 });
          return answerInput(view, answer);
        }, async answers => {
          const response = await internal("POST", "/inputs", { answers: answers.map(({ id, body }) => ({ ...body, id })) });
          if (!response.ok) {
            const error = await response.json() as { error?: string };
            throw Object.assign(new Error(error.error ?? "Input answer failed"), { status: response.status });
          }
          return { status: response.status };
        }, view => view.blocking === false ? "decision" : "blocking");
        await repairInputMirrors(this, input.answers.map(a => a.id)).catch(error => failure(this.env, "input_mirror_repair_failed", error));
        return json({ outcomes: input.answers.map(a => outcomes.find(o => o.id === a.id)) });
      }

      if ((path === "/inputs" || path.startsWith("/inputs/")) && request.method === "POST") {
        const input = await body(request, 1024 * 1024);
        const batch = path === "/inputs";
        const answers = batch ? answerList(input) : [{ id: decodeURIComponent(path.slice(8)), body: input }];
        const decision = answers.every((entry: { id: string }) => entry.id.startsWith("inp_"));
        // Decisions live in Postgres; blocking inputs live in Pi. The inbox answers route must partition these authorities.
        if (!decision && answers.some((entry: { id: string }) => entry.id.startsWith("inp_"))) throw new BadRequest("Answer decisions and blocking inputs in separate batches");
        const answering = this.admission.then(async () => (decision ? answerDecisions(this, invocation, answers, request.headers.get("x-camel-input-via") === "channel" ? "channel" : "api") : this.answerHumanInputs(invocation, answers, request.headers.get("x-camel-input-via") === "agent" ? "agent" : request.headers.get("x-camel-input-via") === "channel" ? "channel" : "api")));
        this.admission = answering.catch(() => {});
        const answered = await answering.catch(async error => {
          if (errorStatus(error, 500) === 409) {
            await repairInputMirrors(this, answers.map((entry: { id: string }) => entry.id)).catch(error => failure(this.env, "input_mirror_repair_failed", error));
          }
          throw error;
        });
        const requests = answered.requests.map(({ limitsSnapshot: _limitsSnapshot, ...record }) => record);
        return json(batch ? { inputs: answered.inputs, requests } : { input: answered.inputs[0], request: requests[0] ?? null }, answered.status);
      }
      if (path === "/abort" && request.method === "POST") {
        const params = object(await body(request, 32 * 1024, true), ['queued', 'children']);
        if (params.queued !== undefined && !['cancel', 'keep'].includes(String(params.queued))) throw new BadRequest('queued is cancel or keep');
        // abort is the documented value (as on Node and in the SDKs); cancel, which this backend took first, stays an alias.
        if (params.children !== undefined && !['abort', 'keep', 'cancel'].includes(String(params.children))) throw new BadRequest('children is abort or keep');
        const aborting = this.admission.then(async () => {
          const stopped = await this.abortRequests(invocation, params.queued === 'keep' ? 'keep' : 'cancel', params.children === 'keep');
          await this.state(invocation);
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
        const selected = await this.negotiateAgentEvents(invocation, request);
        if (selected) return selected;
        return request.headers.get("upgrade")?.toLowerCase() === "websocket"
          ? await this.webSocketEvents(invocation, request)
          : await this.events(invocation, request);
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
          this.repoTrees,
          invocation,
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
          "turn",
          this.repoTrees,
          invocation,
        );
      }
      return json({ error: "Unsupported backend operation", code: "NOT_FOUND" }, 404);
    } catch (error) {
      const limited = admissionError(error);
      if (limited) return limited;
      // A database that is unreachable or slower than its query timeout (PostgreSQL waits on a lock: a prompt's
      // flushBilling waits on its tenant's turn settlements) answers 503, retryable, as the Worker's own routes do.
      const status =
        error instanceof BadRequest
          ? 400
          : ((error as { status?: number }).status ??
            ((error as { code?: string }).code === "ENOENT" ? 404 : errorStatus(error, 500)));
      const code = errorCode(error, status);
      const settlementPending = code === "SETTLEMENT_PENDING";
      // The Worker logs only errors thrown to it (http_failed); this answer it passes on was logged nowhere.
      if (status >= 500 && !settlementPending) failure(this.env, "agent_http_failed", error);
      return json(
        {
          ...errorFields(error),
          code,
          ...("input" in Object(error) ? { input: (error as { input: unknown }).input } : {}),
          error:
            status >= 500 && !settlementPending
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
