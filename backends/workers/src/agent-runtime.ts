import { BashSessions } from "./camelfs/bash.ts";
import { stageRepoMove, type RefMove } from "./camelfs/notify.ts";
import type { Placement } from "../../../shared/owner.ts";
import { ChildRows } from "./children-table.ts";
import { SharedAgents } from "../../../src/shared-agents.ts";
import { testAgentRuntimes } from "./agent-internals.ts";
import { releaseInputPrompts } from "./input-admission.ts";
import { database } from "./postgres.ts";
import { TestStorage } from "./test-storage.ts";
import { modelCompactionSettings } from "./model-context.ts";
import { RecentEvents } from "./recent-events.ts";
import { type Message, type AssistantMessage } from "@earendil-works/pi-ai";
import { createRegistry, type ToolRegistration, type ConversationView, type Extension } from "@earendil-works/pi-durable";
import { isolatedSandboxRemote } from "../codemode/routing.ts";
import { CODE_MODE_EXCHANGE } from "../codemode/exchange.ts";
import { PiHarness } from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";
import { body } from "./validation.ts";
import { type HumanInput } from "./human.ts";
import { releaseTurn } from "./control.ts";
import { PromptAttachments } from "./prompt-attachments.ts";
import { type StoredSchedule as Schedule } from "./schedules.ts";
import { modelRuntime } from "./model.ts";
import { type RateLimitState } from "./admission.ts";
import { isUnbilledLimitMessage } from "./billing-run-stop.ts";
import { PromptPreparations } from "./prompt-admission.ts";
import { MessageProjection } from "./message-projection.ts";
import { AgentHistory } from "./history.ts";
import type { AgentConfiguration } from "./api-contract.ts";
import { ConfigurationQueue } from "./configuration-queue.ts";
import { replay as replayEvents } from "./live-event-policy.ts";
import { AttachedTools } from "./attached-tools.ts";
import { type SourceFailure } from "./tool-sources.ts";
import { Delegation } from "./delegation.ts";
import { decisionService } from "./decision-service.ts";
import { hostExecutionRequest } from "./host-execution.ts";
import { DelegationNotifications, DelegationWakeBudget, type RuntimeNotice, type NoticeDelivery, type NoticeRequest, type WakeDecision } from "./delegation-notifications.ts";
import type { ChildProgressReport } from "./delegation.ts";
import { ChildOutbox, type ChildEnding, type Receipt } from "./ending-outbox.ts";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { AgentRunLimits } from "./run-limits.ts";
import { DurableEventLog, type TerminalDelivery } from "./event-log.ts";
import { type ScheduleToolsHost } from "./agent-schedules.ts";
import { DurableFileVersions } from "./file-versions.ts";
import { AgentWebhooks } from "./run-webhooks.ts";
import { AgentChannels } from "./agent-channels.ts";
import { BatchQueue } from "./batch-queue.ts";
import type { WebhookEvent } from "./webhook-policy.ts";
import { Config, RequestRecord, Env } from "./agent-types.ts";
import { currentRunImpl, recordsImpl, markBeganImpl, observeImpl, requestForInputsImpl, runningRequestImpl, projectMessageImpl, reconcileSteeringImpl, steeringOwnerImpl, onViewImpl, onHumanImpl, trackImpl, settleImpl, submitImpl, answerHumanInputsImpl, closeHumanInputsImpl, dueHumanInputsImpl } from "./agent-turn-loop.ts";
import { removeMemberImpl, abortRequestsImpl, resumeKeptQueueImpl, cancelRequestImpl, resumeCancellationImpl, restoreCancellationsImpl, abortExecutionsImpl, markCancelledRequestsImpl, cancelHostIntentImpl, cancelHumanInputsImpl, startHostRequestImpl, restoreHostAdmissionsImpl } from "./agent-cancellation.ts";
import { releaseConfigurationWaitersImpl, configureRequestImpl, acceptConfigurationRequestImpl, applyConfigurationRequestImpl, requireApplicationImpl, admitImpl, createConfigurationQueue } from "./agent-admission.ts";
import { imageToolsImpl, sourceIdentityImpl, fileRequestIdImpl } from "./agent-attachments.ts";
import { computerNamesImpl, refreshComputerToolsImpl, enabledToolsImpl, hasNativeComputerImpl, createDecisions, createModels, createHarness } from "./agent-tools.ts";
import { agentSpendImpl, admitRequestImpl, endUserLimitImpl, requestUsageImpl, usageViewImpl, usageForRequestImpl, flushBillingImpl, createLimits } from "./agent-billing.ts";
import { admitDelegateWakeImpl, receiveAgentMessageImpl, receiveProgressImpl, receiveEndingImpl, hasChildImpl, createNotifications, createDelegation, createOutbox } from "./agent-delegation.ts";
import { replayedRequestImpl, requestResponseImpl, activityImpl, stateImpl, historyImpl, fetchImpl, fetchRequestImpl, admitDelegatedImpl } from "./agent-http.ts";
import { emitImpl, flushTerminalEventsImpl, recoverWatchersImpl, closeWatchersImpl, checkWatchersImpl, webSocketEventsImpl, negotiateAgentEventsImpl, restoreWebSocketsImpl, sendAttachedSocketImpl, closeBrowserSocketImpl, retireAttachedSocketImpl, webSocketMessageImpl, webSocketCloseImpl, webSocketErrorImpl, replayEventsImpl, runReplayImpl, eventsImpl } from "./agent-transport.ts";
import { purgeAccountDataImpl, configImpl, scheduleToolsImpl, createScheduleImpl, armImpl, onStartImpl, restorePendingImpl, onJobImpl, wakeImpl } from "./agent-lifecycle.ts";
import type { CamelAgent } from "./agent.ts";
import { DbProfile } from "./db-profile.ts";

class AgentContext {
  readonly ctx: DurableObjectState;
  readonly env: Env;
  readonly host: CamelAgent;
  constructor(ctx: DurableObjectState, env: Env, host: CamelAgent) {
    this.ctx = ctx;
    this.env = env;
    this.host = host;
  }
}

/** Internal state, never exposed as a Durable Object RPC target.
 * Field order follows the original agent so eager initialization is unchanged. */
export class AgentRuntime extends AgentContext {
  constructor(ctx: DurableObjectState, env: Env, host: CamelAgent) {
    super(ctx, env, host);
    if (env.TEST_MODE === "1") testAgentRuntimes.set(host, this);
  }

  readonly sharedAgents = new SharedAgents(database(this.env));
  readonly dbProfile = new DbProfile(this.env.PILOT_DB_PROFILE === "1");

  async databaseProfile(reset = false) {
    if (!this.dbProfile.enabled) throw new Error("Pilot database profiling is disabled");
    await this.serial;
    await this.eventsProcessed;
    await this.webhooks.settled();
    return { epoch: this.instanceId, ...this.dbProfile.snapshot(reset) };
  }

  purgeAccountData(tenant: string, id: string) {
    return purgeAccountDataImpl.call(this, tenant, id);
  }

  instanceId = crypto.randomUUID();
  /** When this instance was made: startup (the SDK's onStart, inside blockConcurrencyWhile) is timed from it. */
  readonly constructedAt = Date.now();

  testStorage = new TestStorage(this.env.TEST_HOOKS === "1", this.ctx.storage);

  shuttingDown = false;

  configurationQueue: ConfigurationQueue<RequestRecord> = createConfigurationQueue.call(this);

  historyIndex = new AgentHistory(this.ctx.storage.sql, (fn) =>
    this.ctx.storage.transactionSync(fn),
    async message => !await isUnbilledLimitMessage(this.ctx.storage, message),
  );

  eventLog = new DurableEventLog(this.ctx.storage.sql);

  recentEvents = new RecentEvents(this.ctx.storage.sql);

  registry = createRegistry();

  codeExtension?: Extension;

  attached = new AttachedTools();

  promptAttachments = new PromptAttachments(this.ctx.storage, this.env);

  promptPreparations = new PromptPreparations(this.ctx.storage, async receipt => {
    await releaseTurn(this.env, receipt.tenant, receipt.agent, receipt.requestId);
    await this.env.TENANTS.getByName(receipt.tenant).release(`${receipt.agent}:${receipt.requestId}`);
  });

  socketsRestored = this.restoreWebSockets();

  watcherRecovery?: Promise<void>;

  delegateWakeLimit = (this.env as Env & { AGENT_WAKES_PER_HOUR?: string }).AGENT_WAKES_PER_HOUR;

  wakeBudget = new DelegationWakeBudget(this.ctx.storage, this.delegateWakeLimit ? Number(this.delegateWakeLimit) : undefined);
  admitDelegateWake(id: string): Promise<WakeDecision> {
    return admitDelegateWakeImpl.call(this, id);
  }

  /** Per method: when a call to this deleted agent was last logged, and how many came since (deleted_agent_rpc). */
  goneLogged = new Map<string, { at: number; since: number }>();
  /**
   * Whether this agent is gone for good: deleted, or past its expiry. Both are durable facts in its own storage (the
   * flag is never cleared, the expiry never moves back), so an agent merely evicted, hibernating or busy is never taken
   * for gone, and a read that fails throws. A call to a gone agent is logged by method and caller kind, at most once a
   * minute per method (every call in tests), so a sender that keeps calling one shows up.
   */
  async gone(method: string, caller: string) {
    const storage = this.ctx.storage;
    if (await storage.get("deleted") !== true) {
      const expiresAt = (await storage.get<Config>("configuration"))?.expiresAt;
      if (!expiresAt || expiresAt > Date.now()) return false;
    }
    const seen = this.goneLogged.get(method), now = Date.now();
    if (!seen || now - seen.at >= 60_000 || (this.env as { TEST_MODE?: string }).TEST_MODE === "1") {
      console.warn(JSON.stringify({ type: "deleted_agent_rpc", agent: this.ctx.id.name ?? null, method, caller, suppressed: seen?.since ?? 0 }));
      this.goneLogged.set(method, { at: now, since: 0 });
    } else seen.since++;
    return true;
  }

  receiveAgentMessage(
    request: NoticeRequest,
    notice: RuntimeNotice,
  ): Promise<unknown> {
    return receiveAgentMessageImpl.call(this, request, notice);
  }

  receiveProgress(report: ChildProgressReport): Promise<Receipt> {
    return receiveProgressImpl.call(this, report);
  }

  receiveEnding(ending: ChildEnding): Promise<Receipt> {
    return receiveEndingImpl.call(this, ending);
  }

  hasChild(id: string): Promise<boolean> {
    return hasChildImpl.call(this, id);
  }

  /** This agent's children (children-table.ts), shared by its delegation and its notifications. */
  children = new ChildRows(this.ctx.storage);

  notifications: DelegationNotifications = createNotifications.call(this);

  delegation: Delegation = createDelegation.call(this);

  decisions: ReturnType<typeof decisionService> = createDecisions.call(this);

  limits: AgentRunLimits = createLimits.call(this);

  currentRun(api?: ToolExecutionApi) {
    return currentRunImpl.call(this, api);
  }

  agentSpend(conf: Config, requestId?: string) {
    return agentSpendImpl.call(this, conf, requestId);
  }

  imageTools() {
    return imageToolsImpl.call(this);
  }

  admitRequest(conf: Config, id: string, bucket?: string, endUser?: string) {
    return this.dbProfile.run("admission", () => admitRequestImpl.call(this, conf, id, bucket, endUser));
  }

  toolFileBudgets = new Map<string, { left: number }>();

  runRates = new Map<string, RateLimitState>();

  replayedRequests = new WeakSet<RequestRecord>();
  replayedRequest(record: RequestRecord) {
    return replayedRequestImpl.call(this, record);
  }

  requestResponse(record: RequestRecord) {
    return requestResponseImpl.call(this, record);
  }

  endUserLimit(conf: Config, bucket?: string, endUser?: string) {
    return endUserLimitImpl.call(this, conf, bucket, endUser);
  }

  sourceIdentity(api?: ToolExecutionApi) {
    return sourceIdentityImpl.call(this, api);
  }

  retryModelFailure = true;

  modelCompaction?: (fixedTokens: number) => ReturnType<typeof modelCompactionSettings>;

  models: ReturnType<typeof modelRuntime> = createModels.call(this);

  sourceFailures: SourceFailure[] = [];

  availableTools: ToolRegistration[] = [];

  computerSerial: Promise<unknown> = Promise.resolve();

  serializeComputer<T>(run: () => Promise<T>): Promise<T> {
    const next = this.computerSerial.then(run);
    this.computerSerial = next.catch(() => {});
    return next;
  }
  computerNames() {
    return computerNamesImpl.call(this);
  }

  hasNativeComputer(config?: AgentConfiguration) {
    return hasNativeComputerImpl.call(this, config);
  }

  refreshComputerTools() {
    return refreshComputerToolsImpl.call(this);
  }

  enabledTools(config: AgentConfiguration) {
    return enabledToolsImpl.call(this, config);
  }

  workspaceToolNames: string[] = [];
  /** The file tools as made, before wordedFileTools fits their descriptions to the configuration. */
  workspaceFileTools: ToolRegistration[] = [];

  private sessions?: BashSessions;
  get bashSessions() {
    return this.sessions ??= new BashSessions(this.ctx.storage, this.env, work => this.ctx.waitUntil(work), at => this.arm(at),
      (callId, requestId, checkpointError) => this.emit({ type: "event", requestId, event: { type: "bash_checkpoint_failed", callId, checkpointError } }));
  }

  // K5b2 supplies the provider for this runtime.
  vmFiles?: import("./repos/vm-route.ts").VmFilesProvider;
  fileVersions = new DurableFileVersions(this.ctx.storage);

  // Pi can reopen its Harness after a storage failure without replacing this
  // agent. Keep admission here so old remote work still occupies its slots.
  readonly sandboxRemote = isolatedSandboxRemote({
    agentKey: this.ctx.id.toString(),
    getByName: (key) => this.env.CODEMODE_SANDBOX.getByName(key),
    exchange: CODE_MODE_EXCHANGE,
    maxConcurrent: 3,
  });

  harness: PiHarness = createHarness.call(this);

  lifecycle = Lifecycle.install(this.host).use(this.harness);

  observer?: Promise<void>;

  listeners = new Set<(cursor: number, event: unknown) => void>();

  partial: AssistantMessage | null = null;

  emittedText = "";

  active?: string;

  serial: Promise<unknown> = Promise.resolve();

  readonly initialCursor = Date.now() * 1000;

  pendingWaits = new Map<string, Promise<void>>();

  billingFlush?: Promise<void>;

  // A durable watchdog must survive losing in-memory waiters. Live waiters
  // need limit checks; other maintenance can wait for its actual deadline.
  maintenance: { at: number; tracksRuns: boolean } | undefined;
  maintenanceGeneration = 0;
  invalidateMaintenance() {
    this.maintenance = undefined;
    this.maintenanceGeneration++;
  }

  admission: Promise<unknown> = Promise.resolve();

  /** Prompts held for a batch, for an agent whose queue batches (batch-queue.ts). */
  batchQueue = new BatchQueue(this);

  /** Whether the agent's queue batches, for Pi's settings (steeringMode and followUpMode "all"), which read it synchronously; set as its configuration is read. */
  batching = false;

  eventsProcessed: Promise<void> = Promise.resolve();
  records() {
    return recordsImpl.call(this);
  }

  config() {
    return configImpl.call(this);
  }


  readonly webhooks = new AgentWebhooks(this.ctx.storage, this.env);
  /** A channel agent's typing indicator, replies and send_message (agent-channels.ts). */
  readonly channels = new AgentChannels(this.ctx, this.env);
  /** This agent's outbox to its owner: its runs' endings and progress reports (ending-outbox.ts). */
  outbox: ChildOutbox = createOutbox.call(this);

  emit(event: unknown, delivery?: TerminalDelivery, webhook?: WebhookEvent) {
    return emitImpl.call(this, event, delivery, webhook);
  }

  flushTerminalEvents() {
    return flushTerminalEventsImpl.call(this);
  }

  lastEntry = 0;

  messageProjection = new MessageProjection();

  nextMessage = 0;
  markBegan(id: string) {
    return markBeganImpl.call(this, id);
  }

  observe() {
    return observeImpl.call(this);
  }

  requestForInputs(
    inputs: readonly number[],
  ): Promise<string | undefined> {
    return requestForInputsImpl.call(this, inputs);
  }

  runningRequest(): Promise<{ owner: string; nativeRequest: string; resumeOwner?: string } | undefined> {
    return runningRequestImpl.call(this);
  }

  fileRequestId(
    conversationId?: Parameters<typeof hostExecutionRequest>[1],
  ) {
    return fileRequestIdImpl.call(this, conversationId);
  }

  projectMessage(id: string, message: Message, ended: boolean, member?: string) {
    return projectMessageImpl.call(this, id, message, ended, member);
  }

  reconcileSteering(record: RequestRecord, inputs: readonly number[]) {
    return reconcileSteeringImpl.call(this, record, inputs);
  }

  steeringOwner(record: RequestRecord, owner: string | null) {
    return steeringOwnerImpl.call(this, record, owner);
  }

  onView(view: ConversationView) {
    return onViewImpl.call(this, view);
  }

  onHuman(doc: { requests: Record<string, HumanInput> }) {
    return onHumanImpl.call(this, doc);
  }

  track(id: string) {
    return trackImpl.call(this, id);
  }

  settle(id: string, waitMs: number): Promise<RequestRecord> {
    return settleImpl.call(this, id, waitMs);
  }

  submit(
    input: unknown,
    notice?: RuntimeNotice,
    delivery?: NoticeDelivery,
    acceptedFingerprint?: string,
    member?: string,
    placement?: Placement,
  ) {
    return submitImpl.call(this, input, notice, delivery, acceptedFingerprint, member, placement);
  }

  admitDelegated(input: unknown, placement: Placement) {
    return admitDelegatedImpl.call(this, input, placement);
  }

  /** A settled input, including cancellation or expiry, releases prompts waiting behind it. */
  kickInputPrompts() {
    const work = this.admission.then(() => releaseInputPrompts(this));
    this.admission = work.catch(() => {});
    this.ctx.waitUntil(work);
  }

  abortRequests(queued: 'cancel' | 'keep' = 'cancel', keepChildren = false) {
    return abortRequestsImpl.call(this, queued, keepChildren);
  }

  resumeKeptQueue() {
    return resumeKeptQueueImpl.call(this);
  }

  /** A notify delivery for a repo this agent watches: an idempotent outbox row, drained by the alarm. */
  stageRepoMove(move: RefMove) { return stageRepoMove(this.ctx.storage, move); }
  vmEnded(delivery: string, vm: string) { return this.bashSessions.ended(delivery, vm); }

  removeMember(member: string) {
    return removeMemberImpl.call(this, member);
  }

  cancelRequest(id: string) {
    return cancelRequestImpl.call(this, id);
  }

  cancellations = new Set<string>();
  resumeCancellation(record: RequestRecord) {
    return resumeCancellationImpl.call(this, record);
  }

  restoreCancellations() {
    return restoreCancellationsImpl.call(this);
  }

  abortExecutions() {
    return abortExecutionsImpl.call(this);
  }

  markCancelledRequests() {
    return markCancelledRequestsImpl.call(this);
  }

  cancelHostIntent(record: RequestRecord) {
    return cancelHostIntentImpl.call(this, record);
  }

  cancelHumanInputs(requestId?: string) {
    return cancelHumanInputsImpl.call(this, requestId);
  }

  startHostRequest(intent: RequestRecord) {
    return startHostRequestImpl.call(this, intent);
  }

  restoreHostAdmissions() {
    return restoreHostAdmissionsImpl.call(this);
  }

  releaseConfigurationWaiters(order: number) {
    return releaseConfigurationWaitersImpl.call(this, order);
  }

  configureRequest(input: unknown, replacement = false, origin?: string) {
    return configureRequestImpl.call(this, input, replacement, origin);
  }

  acceptConfigurationRequest(input: unknown, replacement: boolean, origin?: string) {
    return acceptConfigurationRequestImpl.call(this, input, replacement, origin);
  }

  applyConfigurationRequest(input: unknown, origin?: string) {
    return applyConfigurationRequestImpl.call(this, input, origin);
  }

  requireApplication(allowDisconnected: unknown) {
    return requireApplicationImpl.call(this, allowDisconnected);
  }

  admit(
    input: unknown,
    notice?: RuntimeNotice,
    delivery?: NoticeDelivery,
    acceptedFingerprint?: string,
    member?: string,
    placement?: Placement,
  ) {
    return admitImpl.call(this, input, notice, delivery, acceptedFingerprint, member, placement);
  }

  activity() {
    return activityImpl.call(this);
  }

  state() {
    return stateImpl.call(this);
  }

  history(url: URL) {
    return historyImpl.call(this, url);
  }

  answerHumanInputs(answers: Array<{ id: string; body: unknown }>, via: "api" | "agent" | "channel", system?: "expired" | "superseded") {
    return answerHumanInputsImpl.call(this, answers, via, system);
  }

  closeHumanInputs(system: "expired" | "superseded", sender?: string, shared = false) {
    return closeHumanInputsImpl.call(this, system, sender, shared);
  }

  dueHumanInputs(at: number) {
    return dueHumanInputsImpl.call(this, at);
  }

  fetch(request: Request): Promise<Response> {
    return this.dbProfile.run(new URL(request.url).pathname === "/history" ? "history" : "other", () => fetchImpl.call(this, request));
  }

  fetchRequest(request: Request): Promise<Response> {
    return fetchRequestImpl.call(this, request);
  }

  requestUsage(record: RequestRecord, usage: Awaited<ReturnType<AgentRuntime["usageForRequest"]>>) {
    return requestUsageImpl.call(this, record, usage);
  }

  usageView(usage: Awaited<ReturnType<AgentRuntime["usageForRequest"]>>) {
    return usageViewImpl.call(this, usage);
  }

  usageForRequest(id: string) {
    return usageForRequestImpl.call(this, id);
  }

  flushBilling(propagate = false) {
    return flushBillingImpl.call(this, propagate);
  }

  scheduleTools(): ScheduleToolsHost {
    return scheduleToolsImpl.call(this);
  }

  createSchedule(raw: unknown): Promise<Schedule> {
    return createScheduleImpl.call(this, raw);
  }

  arm(retry?: number) {
    return armImpl.call(this, retry);
  }

  onStart() {
    return this.dbProfile.run("other", () => onStartImpl.call(this));
  }

  restorePending() {
    return restorePendingImpl.call(this);
  }

  onJob(context: { job: { fn: string } }) {
    return this.dbProfile.run("other", () => onJobImpl.call(this, context));
  }

  wake() {
    return wakeImpl.call(this);
  }

  recoverWatchers() {
    return recoverWatchersImpl.call(this);
  }

  closeWatchers(tenant: string, agent: string) {
    return closeWatchersImpl.call(this, tenant, agent);
  }

  checkWatchers(tenant: string, agent: string) {
    return checkWatchersImpl.call(this, tenant, agent);
  }

  webSocketEvents(request: Request): Promise<Response> {
    return webSocketEventsImpl.call(this, request);
  }

  negotiateAgentEvents(
    request: Request,
  ): Promise<Response | undefined> {
    return negotiateAgentEventsImpl.call(this, request);
  }

  restoreWebSockets() {
    return restoreWebSocketsImpl.call(this);
  }

  sendAttachedSocket(socket: WebSocket, event: unknown) {
    return sendAttachedSocketImpl.call(this, socket, event);
  }

  closeBrowserSocket(socket: WebSocket) {
    return closeBrowserSocketImpl.call(this, socket);
  }

  retireAttachedSocket(socket: WebSocket) {
    return retireAttachedSocketImpl.call(this, socket);
  }

  webSocketMessage(socket: WebSocket, _data: string | ArrayBuffer) {
    return webSocketMessageImpl.call(this, socket, _data);
  }

  webSocketClose(socket: WebSocket, code: number) {
    return webSocketCloseImpl.call(this, socket, code);
  }

  webSocketError(socket: WebSocket) {
    return webSocketErrorImpl.call(this, socket);
  }

  replayEvents(request: Request) {
    return replayEventsImpl.call(this, request);
  }

  runReplay(request: Request, id: string): Generator<{ id: number; data: unknown }> {
    return runReplayImpl.call(this, request, id);
  }

  events(request: Request): Promise<Response> {
    return eventsImpl.call(this, request);
  }

}
