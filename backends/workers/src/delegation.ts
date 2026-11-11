import { defineTool, type ToolRegistration, type ToolExecutionApi } from '@earendil-works/pi-durable';
import { HttpError } from './errors.ts';
import { digest } from './api-contract.ts';
import { childStatus, modelOutputSchema, MULTI_AGENT_LIMITS, PARENT_KEYS, roleAndTask, delegateTool, agentsTools, agentMessage, agentUpdates, REPORT_PROGRESS, SEND_MESSAGE, type DelegateSettings } from './multi-agent-policy.ts';
import type { ToolDefinition } from './policy-host.ts';
import type { NoticeRequest, RuntimeNotice } from './delegation-notifications.ts';
import { childConfig } from './child-config.ts';
import { holdBudget, type DelegateResponse, type Session as BudgetSession } from './delegation-policy.ts';
import { toolCallSite } from './tool-call-context.ts';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { escapeMarkers } from './sender.ts';
import { outputInput } from './output-validation.ts';
import type { Context } from '@earendil-works/chord';
import type { McpResult } from './attached-tools.ts';
import { waitsForProgress } from './delegation-progress.ts';
import { scriptOf } from './codemode-run.ts';
import { computerChoice, forkBatch } from '../../../src/core/computer-fork.ts';
import type { ComputerSnapshot } from './computers/provider.ts';
import type { NativeForkOrigin } from './computers/native-fork.ts';
import type { ChildPlace } from './child-parent.ts';
import { ChildRows, CHILDREN_KV_PREFIX } from './children-table.ts';
import type { ChildEnding, Receipt } from './ending-outbox.ts';
import { agentOwner, ownerOf, placementOf, type Owner, type Placement } from '../../../shared/owner.ts';

type Configuration = { bucket?: string; model?: string | object; systemPrompt?: string; delegate?: DelegateSettings; builtins?: string[]; spendLimit?: { usd: number }; [key: string]: unknown };
export type ParentRun = { id: string; piId?: string; startedAt?: number; params?: { endUser?: string; spendLimit?: { usd: number }; bucket?: string; actor?: string }; metadata?: unknown; delegation?: unknown };
export type ChildUsage = { costUsd?: number; subagentCostUsd?: number; imageCostUsd?: number; decisionCostUsd?: number; webCostUsd?: number; transcriptionCostUsd?: number };
export type ChildRun = { state: string; status?: string; error?: string; steeredInto?: string; outcome?: { result?: { reply?: string; output?: unknown; code?: string; stopped?: string; steeredInto?: string; usage?: ChildUsage }; error?: string } };
export function childUsageCost(usage?: ChildUsage) {
  return (usage?.costUsd ?? 0) + (usage?.subagentCostUsd ?? 0) + (usage?.imageCostUsd ?? 0) + (usage?.decisionCostUsd ?? 0) + (usage?.webCostUsd ?? 0) + (usage?.transcriptionCostUsd ?? 0);
}
/** A child's progress report as a parent's tool result shows it (`agentUpdates`), with what marks it shown. */
export type ShownProgress = { key: string; name: string; text: string; at: number; sequence: number };
export type ChildProgressReport = { agentId: string; requestId: string; text: string; callId: string };
export type DelegatedChild = { outbox?: boolean; owner?: Owner; rootOwner?: Owner; payer?: string; bucket?: string; id: string; key: string; requestId: string; parentRequestId: string; toolCallId: string; callId?: string; task?: string; payloadBytes?: number; name: string; depth: number; maxDepth?: number; chain?: string[]; root?: string; background?: boolean; folded?: boolean; createdAt: number; endedAt?: number; status: string; made: boolean; held?: number; spent?: number; charged?: boolean; outcome?: ChildRun['outcome']; error?: string; notified?: boolean; landedBy?: 'wait' | 'notice'; accepted?: boolean; cancelRequested?: boolean; progress?: { text: string; at: number; sequence: number }; progressShown?: number; progressCalls?: string[] };
/** How many children `GET /v1/agents/{id}/children` lists, newest first (as Node's CHILDREN_LISTED). */
export const CHILDREN_LISTED = 200;
/**
 * `GET /v1/agents/{id}/children`: every child the agent's delegate and spawn_agent calls (and tools' spawn directives)
 * started, newest first, each as its latest record says (a message that started a turn, or a resume, is a record of its
 * own; one its running turn took, folded, is not). `delivered`: an ended child's answer reached the parent (its
 * notification landed, or a wait_agent took it; a delegate call's answer is its result).
 */
export function childrenView(children: DelegatedChild[]) {
  const started = new Map<string, number>(), latest = new Map<string, DelegatedChild>();
  for (const child of children) {
    if (!child.id || child.folded) continue;
    started.set(child.id, Math.min(started.get(child.id) ?? child.createdAt, child.createdAt));
    latest.delete(child.id);
    latest.set(child.id, child);
  }
  return [...latest.values()].reverse().slice(0, CHILDREN_LISTED).map(child => {
    const running = child.status === 'running', background = !!child.background;
    return {
      agentId: child.id, name: child.name, background, status: child.status, requestId: child.requestId, toolCallId: child.toolCallId,
      startedAt: started.get(child.id)!, ...(!running && child.endedAt !== undefined ? { endedAt: child.endedAt } : {}),
      ...(!running ? { delivered: background ? !!child.landedBy : true } : {}),
      ...(running && child.progress ? { progress: child.progress.text, progressAt: child.progress.at } : {}),
      ...(!running && background && child.error ? { error: child.error } : {}),
    };
  });
}
export interface DelegationHost {
  storage: DurableObjectStorage;
  /** The owner's children table; one is made over `storage` when left out. */
  children?: ChildRows;
  /**
   * Verifies the HMAC lineage older code signed into a child's prompt metadata, for a run it started before this
   * deploy. Nothing is signed any more; this goes with the contract deploy (docs/design/swarm-workflows.md, PR 6).
   */
  secret?: string;
  context(api?: ToolExecutionApi): Promise<{ id: string; config: Configuration; run: ParentRun }>;
  /** Authoritative remaining spend after completed work, before active child shares. */
  remainingBudget?(background: boolean, api?: ToolExecutionApi): Promise<number | undefined>;
  create(config: Configuration, key: string, parent?: { agent: string; run: string; place: ChildPlace }): Promise<{ id: string }>;
  /** This agent's place as its parent made it, when the runtime made it (`madePlace`). */
  made?(): Promise<ChildPlace | undefined>;
  /**
   * Copy an eligible parent connection before a newly created child starts. `computer` is the call's choice: "none"
   * attaches nothing, a fork (forkComputer's) starts the child's computers from the parent's snapshots.
   */
  inheritComputer?(parent: string, child: string, computer?: 'none' | 'share' | ChildComputerFork): Promise<void>;
  /** This agent has a native computer (it declares one, or shares its parent's): what a child's own machine needs. */
  hasComputer?(): Promise<boolean>;
  /** Snapshot the parent's computers for a fork: once per batch (one call's children share it). Throws FORK_UNSUPPORTED or NO_SESSION. */
  forkComputer?(batch: string): Promise<ChildComputerFork>;
  /** A made child's work ended (its delegate call answered): its computers stop billing. */
  releaseComputer?(child: string): Promise<void>;
  target(ref: { agent?: string; definition?: string; revision?: number }): Promise<{ id?: string; config: Configuration; description?: string }>;
  fetch(id: string, request: Request): Promise<Response>;
  /**
   * Start a child's run through the binding, never through public request metadata: its placement (owner, root, chain,
   * depth) is stored with the run by the child as given, which only the runtime can do.
   */
  submitChild(id: string, request: { id: string; method: 'prompt'; params: Record<string, unknown> }, placement: Placement): Promise<{ ok: true } | { ok: false; status: number; error: string }>;
  /** Cancel exactly this child request, including a queued request of an existing agent. */
  cancelRequest?(agentId: string, requestId: string): Promise<unknown>;
  /** Remove only agents created for this parent's delegation calls. */
  remove?(agentId: string): Promise<void>;
  emit(event: unknown): Promise<void>;
  waitUntil(promise: Promise<unknown>): void;
  /** Journal a runtime-authored child notification so recovery cannot lose it. */
  notify?(child: DelegatedChild): Promise<void>;
  retry?(afterMs?: number): Promise<void>;
  sendMessage?(targetId: string, request: NoticeRequest, notice: RuntimeNotice): Promise<unknown>;
  /** Send a progress report to this run's owner through this agent's outbox (ending-outbox.ts). */
  reportProgress?(owner: Owner, report: ChildProgressReport): Promise<Receipt>;
}
/** What a fork gives a child: a seed for its computer connection, and the native computer's snapshot. */
export type ChildComputerFork = { connection?: { seed: string; connection?: string; provider?: string; at?: number }; native?: { snapshot: ComputerSnapshot; origin: NativeForkOrigin } };
/** How often a wait_agent looks again for messages and progress while it waits (endings wake it at once). */
export const WAIT_RECHECK_MS = 5000;
const prefix = CHILDREN_KV_PREFIX;
const payloadPrefix = 'delegation-payload:';
type ChildStorage = Pick<DurableObjectStorage, 'get' | 'put'>;
function childState({ task: _task, outcome: _outcome, ...state }: DelegatedChild): DelegatedChild { return state; }
/** Hydrate only where a submission, model result or notification needs the payload. */
export async function readChildPayload(storage: ChildStorage, child: DelegatedChild): Promise<DelegatedChild> {
  const payload = await storage.get<Pick<DelegatedChild, 'task' | 'outcome'>>(payloadPrefix + child.key, { noCache: true });
  return payload ? { ...child, ...payload } : { ...await storage.get<DelegatedChild>(prefix + child.key, { noCache: true }), ...child };
}
type ChildCharge = { requestId: string; usd: number; at: number };
const chargePrefix = 'delegation-charge:';
function finiteBudget(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}
/** Older code's lineage MAC, checked (never made) for runs it started before this deploy. */
async function legacySignature(secret: string, agent: string, run: string, depth: string, maxDepth: string, chain: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`delegation-v1:${agent}:${run}:${depth}:${maxDepth}:${chain}`));
  return [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2, '0')).join('');
}

/** A run's place in its chain: its parent (the chain's last) and root (its first) agent ids, with their owners. */
export type Lineage = { depth: number; maxDepth: number; chain: string[]; parent: string; root: string; owner: Owner; rootOwner: Owner };

/** Durable child lifecycle; Pi owns invocation replay, and the child request is idempotent. */
export class Delegation {
  private readonly changed = new Map<string, Set<() => void>>();
  private readonly completions = new Map<string, Promise<void>>();
  /** Endings taken (`endings`), delivered again after one was (`repeatedEndings`), and legacy runs reconciled at start. */
  readonly measurements = { endings: 0, repeatedEndings: 0, legacyRecovered: 0 };
  private signalChange(key: string) {
    for (const name of [key, '*']) {
      for (const wake of this.changed.get(name) ?? []) wake();
      this.changed.delete(name);
    }
  }
  private waitChange(key: string, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const remove = () => { const entries = this.changed.get(key); entries?.delete(done); if (!entries?.size) this.changed.delete(key); };
      const done = () => { signal?.removeEventListener('abort', aborted); remove(); resolve(); };
      const aborted = () => { remove(); reject(signal?.reason); };
      const entries = this.changed.get(key) ?? new Set(); entries.add(done); this.changed.set(key, entries);
      signal?.addEventListener('abort', aborted, { once: true });
    });
  }
  /**
   * A child's ending, delivered by the child's outbox (ending-outbox.ts) until this answers. Idempotent on the child's
   * run: the row's status decides, in one transaction, whether this delivery or an earlier one took the ending, so a
   * delivery made again charges, notifies and releases nothing twice. An unknown run is answered `accepted: false`.
   */
  async receiveEnding(ending: ChildEnding): Promise<Receipt> {
    const child = await this.rows.byRun(ending.agentId, ending.requestId);
    if (!child || child.id !== ending.agentId) return { accepted: false };
    if (ending.record?.state !== 'completed') return { accepted: true };
    await this.complete(child, ending.record);
    return { accepted: true };
  }
  /** wait_agent calls in flight: while one is, a child's ending is left for it, not sent to the running turn (notify "asap"). */
  waiting = 0;
  private readonly starting = new Set<Promise<DelegatedChild>>();
  private readonly host: DelegationHost;
  /** The owner's children (children-table.ts): read by index, never listed whole on a hot path. */
  readonly rows: ChildRows;
  private reportedChildren = 32;
  constructor(host: DelegationHost) { this.host = host; this.rows = host.children ?? new ChildRows(host.storage); }
  async children() { return (await this.rows.all()).map(childState); }
  /** Payloads are read only for submission, results or notifications, never by status scans. */
  private async details(child: DelegatedChild, storage: ChildStorage = this.host.storage): Promise<DelegatedChild> {
    return readChildPayload(storage, child);
  }
  private async putChild(storage: ChildStorage, child: DelegatedChild): Promise<DelegatedChild> {
    let payloadBytes = child.payloadBytes;
    if (child.task !== undefined || child.outcome !== undefined) {
      const previous = await storage.get<Pick<DelegatedChild, 'task' | 'outcome'>>(payloadPrefix + child.key, { noCache: true });
      const payload = { ...previous, ...(child.task !== undefined ? { task: child.task } : {}), ...(child.outcome !== undefined ? { outcome: child.outcome } : {}) };
      payloadBytes = new TextEncoder().encode(JSON.stringify(payload)).byteLength;
      await storage.put(payloadPrefix + child.key, payload, { noCache: true });
    }
    const state = { ...childState(child), ...(payloadBytes === undefined ? {} : { payloadBytes }) };
    await this.rows.put(state, storage);
    return state;
  }
  private reportMemory(children: DelegatedChild[], parent: string, requestId: string) {
    const running = children.filter(child => child.status === 'running');
    if (running.length <= 32) { this.reportedChildren = 32; return; }
    if (running.length <= this.reportedChildren) return;
    this.reportedChildren = running.length;
    // Conservative owned-state estimate, not a process/isolate heap measurement.
    const heapEstimateBytes = running.reduce((bytes, child) => bytes + 1024 + JSON.stringify(childState(child)).length * 2, 0);
    console.log(JSON.stringify({ type: 'delegation_memory', agentId: parent, requestId, childCount: running.length, heapEstimateBytes, estimateScope: 'parent_delegation_bookkeeping', payloadStorageBytes: running.reduce((bytes, child) => bytes + (child.payloadBytes ?? 0), 0) }));
  }
  async cost(requestId: string) { return [...(await this.host.storage.list<ChildCharge>({ prefix: chargePrefix })).values()].filter(charge => charge.requestId === requestId).reduce((sum, charge) => sum + charge.usd, 0); }
  async costSince(startedAt: number) { return [...(await this.host.storage.list<ChildCharge>({ prefix: chargePrefix })).values()].filter(charge => charge.at >= startedAt).reduce((sum, charge) => sum + charge.usd, 0); }
  /** A child's ending is charged when a call, notification or recovery takes it. */
  async settleInTransaction(tx: DurableObjectTransaction, child: DelegatedChild, requestId: string) {
    if (child.charged || child.folded) return child;
    const sequence = (await tx.get<number>('delegation-charge-sequence') ?? 0) + 1;
    await tx.put('delegation-charge-sequence', sequence);
    await tx.put(`${chargePrefix}${sequence}`, { requestId, usd: child.spent ?? childUsageCost(child.outcome?.result?.usage), at: Date.now() } satisfies ChildCharge);
    const charged = { ...child, charged: true };
    return this.putChild(tx, charged);
  }
  /**
   * A notice lands (its request is admitted): its child's ending is charged to the run it starts, and so is each ending
   * it carries (`batch`, multi-agent.ts BatchedEnding), at what each spent. Settling is once per child (`charged`).
   */
  async landNotice(requestId: string, costUsd: number, batch: readonly { requestId: string; costUsd: number }[] = []) {
    const named = async (notice: string) => notice.startsWith('child_') ? (await this.rows.byRequest(notice.slice('child_'.length)))[0] : undefined;
    return this.host.storage.transaction(async tx => {
      for (const carried of batch) {
        const child = await named(carried.requestId);
        if (child) await this.settleInTransaction(tx, { ...child, spent: carried.costUsd }, requestId);
      }
      const child = await named(requestId);
      if (child) return this.settleInTransaction(tx, { ...child, spent: costUsd }, requestId);
    });
  }
  private async update(child: DelegatedChild, patch: Partial<DelegatedChild>) {
    return this.host.storage.transaction(async tx => {
      const current = await this.rows.get(child.key) ?? child;
      const next = { ...current, ...patch, ...(current.cancelRequested ? { cancelRequested: true } : {}) };
      return this.putChild(tx, next);
    });
  }
  private async checkCancellation(child: DelegatedChild, signal: AbortSignal) {
    signal.throwIfAborted();
    if ((await this.rows.get(child.key))?.cancelRequested)
      throw new DOMException('Delegation cancelled', 'AbortError');
  }
  /**
   * Where this run stands in a delegation chain: the placement its owner stored with it through the binding
   * (`submitChild`, a message's notice). Public prompt metadata cannot place a run.
   */
  async lineage(id: string, run: ParentRun): Promise<Lineage | undefined> {
    const placed = placementOf(run.delegation);
    if (placed?.chain.length) return { depth: placed.depth, maxDepth: placed.maxDepth, chain: placed.chain, parent: placed.chain.at(-1)!, root: placed.chain[0]!, owner: placed.owner, rootOwner: placed.rootOwner };
    return this.legacyLineage(id, run);
  }
  /** A run older code started, its place signed into its metadata: checked, never made (removed in the contract deploy). */
  private async legacyLineage(id: string, run: ParentRun): Promise<Lineage | undefined> {
    if (!this.host.secret) return;
    const metadata = run.metadata && typeof run.metadata === 'object' ? run.metadata as Record<string, unknown> : {};
    const depth = metadata[PARENT_KEYS.depth], max = metadata[PARENT_KEYS.maxDepth], chain = metadata[PARENT_KEYS.chain] ?? '';
    if (typeof depth !== 'string' || typeof max !== 'string' || typeof chain !== 'string') return;
    if (metadata[PARENT_KEYS.signature] !== await legacySignature(this.host.secret, id, run.piId ?? run.id, depth, max, chain)) return;
    const parents = chain.split(',').filter(Boolean);
    if (!parents.length) return;
    return { depth: Number(depth), maxDepth: Number(max), chain: parents, parent: parents.at(-1)!, root: parents[0]!, owner: agentOwner(parents.at(-1)!), rootOwner: agentOwner(parents[0]!) };
  }
  private async place(id: string, run: ParentRun, settings: DelegateSettings) {
    // A turn signed into no chain (a notification's or message's) of a sub-agent the runtime made is where it was made:
    // its depth, limit and root hold in every turn it runs.
    const lineage = await this.lineage(id, run) ?? await this.host.made?.();
    const parentDepth = lineage?.depth ?? 0;
    const maxDepth = Math.min(lineage?.maxDepth ?? MULTI_AGENT_LIMITS.depthCeiling, settings.maxDepth ?? MULTI_AGENT_LIMITS.maxDepth);
    if (parentDepth + 1 > maxDepth) throw new HttpError(400, `Delegation has reached its depth limit of ${maxDepth}: do this task yourself`, 'DELEGATION_DEPTH');
    const chain = [...lineage?.chain ?? [], id];
    const rootOwner = (lineage && 'rootOwner' in lineage ? ownerOf(lineage.rootOwner) : undefined) ?? agentOwner(chain[0]!);
    return { depth: parentDepth + 1, maxDepth, chain, owner: agentOwner(id), rootOwner };
  }
  async start(args: Record<string, unknown>, callId: string, signal: AbortSignal, background = false, api?: ToolExecutionApi, override?: DelegateSettings): Promise<DelegatedChild> {
    const context = await this.host.context(api), { id, config, run } = context;
    const settings = override ?? config.delegate;
    if (!settings) throw new HttpError(400, 'This agent has no delegation settings');
    const target = args.agent === undefined ? undefined : settings.agents?.find(target => target.name === args.agent);
    if (args.agent !== undefined && !target) throw new HttpError(400, `There is no agent ${String(args.agent)} to delegate to`);
    if (args.instructions !== undefined && !settings.instructions) throw new HttpError(400, 'Instructions of your own are not allowed here');
    if ((target === undefined) === (args.instructions === undefined)) throw new HttpError(400, 'Name an agent or give instructions, one of them');
    if (typeof args.task !== 'string' || !args.task.trim() || args.task.length > MULTI_AGENT_LIMITS.taskChars) throw new HttpError(400, 'Give the sub-agent its task');
    if (args.instructions !== undefined && (typeof args.instructions !== 'string' || !args.instructions.trim() || args.instructions.length > MULTI_AGENT_LIMITS.instructionsChars)) throw new HttpError(400, 'Invalid sub-agent instructions');
    if (args.name !== undefined && (typeof args.name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(args.name))) throw new HttpError(400, 'Invalid sub-agent name');
    const identity = await digest(`${run.id}:${callId}`), key = `delegate-${identity.slice(0, 48)}`;
    // A call from code (`<codemode call>/c<n>`) is the code mode call's, as the model made it: its child names that call.
    const site = api?.getTask ? await toolCallSite(api) : undefined;
    const toolCallId = site?.innerCallId ? site.toolCallId : callId;
    const stored = await this.rows.get(key);
    if (stored?.cancelRequested && !stored.accepted && stored.status === 'running') {
      await this.cancelRemote(stored);
      if (stored.id) {
        const cancelled = await this.update(stored, { accepted: true });
        this.follow(cancelled);
        return cancelled;
      }
      const cancelled = await this.update(stored, { status: 'aborted', endedAt: Date.now(), held: undefined });
      return cancelled;
    }
    if (stored?.accepted || (stored && stored.status !== 'running')) { this.follow(stored); return childState(stored); }
    // An interrupted start (the parent evicted or redeployed after admitting the child, its call replayed) goes on with
    // the admission it made: creation and submit use deterministic keys, and the child dedupes only the very same request,
    // so the replay sends what the first try may have sent already, its spend limit included, never a recomputed one.
    const resumed = stored;
    const place = await this.place(id, run, settings);
    // The child's computer: a fork's snapshot (once per call: its siblings share it) is taken while the child is admitted
    // and made, and awaited before the child is recorded: a fork that cannot be taken fails the call with nothing kept
    // (a child made meanwhile is deleted).
    let choice = computerChoice(args.computer);
    if (choice === 'fork' && target?.agent !== undefined) throw new HttpError(400, 'computer: "fork" makes a new sub-agent with a copy of your computer: give instructions or a definition target, not an existing agent');
    if (choice === 'fork' && !this.host.forkComputer) throw new HttpError(409, 'Computers cannot be forked on this runtime. Use computer: "fresh" or "none".', 'FORK_UNSUPPORTED');
    // A replay finds the batch's snapshot again (its row or registry entry). If the parent's computer is gone by then, the
    // replayed child keeps whatever it was already given (attaching never replaces a child's computers).
    const forking = choice === 'fork'
      ? this.host.forkComputer!(forkBatch(run.id, site?.assistant, toolCallId)).catch(error => { if (resumed?.id) return undefined; throw error; })
      : undefined;
    // Awaited below; a call refused before then leaves it unawaited, which must not be an unhandled rejection.
    forking?.catch(() => {});
    const maxParallel = settings.maxParallel ?? MULTI_AGENT_LIMITS.maxParallel;
    let group: { messageIndex: number; delegates: number } | undefined;
    if (!resumed && !background && !override && site && !site.innerCallId && api?.commit) {
      if (site.assistant !== undefined) {
        const entry = await api.commit(tx => tx.entry(site.assistant as never), BACKGROUND_CONTEXT);
        let delegates = 0;
        for (const message of entry?.model ?? []) if (message.role === 'assistant')
          for (const part of message.content) if (part.type === 'toolCall' && part.name === 'delegate') delegates++;
        group = { messageIndex: site.assistant, delegates: Math.max(1, delegates) };
      }
    }
    let held = resumed?.held;
    // Slot and budget reservation are one SQLite transaction. No model call can race them.
    for (;;) {
      signal.throwIfAborted();
      const available = resumed ? undefined : this.host.remainingBudget
        ? await this.host.remainingBudget(background, api)
        : finiteBudget(run.params?.spendLimit?.usd) ?? finiteBudget(config.spendLimit?.usd);
      const admitted = resumed ?? await this.host.storage.transaction(async tx => {
        // Indexed reads: this run's children, the running ones, and (for a budget) those not yet charged.
        const children = await this.rows.ofRun(run.id);
        const scope = background ? (await this.rows.running()).filter(child => child.background) : children;
        const running = scope.filter(child => child.status === 'running');
        if (running.length >= maxParallel) {
          if (background) throw new HttpError(400, `${running.length} sub-agents are running, this agent's most at once: wait for one to finish (wait_agent) before starting another`);
          return false;
        }
        if (args.name && running.some(child => child.name === args.name)) throw new HttpError(400, 'A sub-agent with this name is already running');
        if (available !== undefined) {
          const reserved = this.host.remainingBudget
            ? (await this.rows.unsettled()).filter(child => !child.charged && !child.folded).reduce((sum, child) => sum + (child.status === 'running' ? child.held ?? 0 : child.spent ?? 0), 0)
            : children.reduce((sum, child) => sum + (child.spent ?? child.held ?? 0), 0);
          const remaining = available - reserved;
          if (remaining <= 0) throw new HttpError(402, 'This run has no budget left for a sub-agent', 'SPEND_LIMIT');
          if (group) {
            const responseKey = `delegate-response:${run.id}:${group.messageIndex}`;
            const prior = await tx.get<DelegateResponse & { keys?: string[] }>(responseKey);
            const state: BudgetSession = {
              childHeld: new Map([[run.id, { usd: reserved, holders: running.length }]]),
              delegating: { active: running.length + 1 },
              ...(prior ? { delegateResponse: { ...prior, taken: prior.taken - (prior.keys?.includes(key) ? 1 : 0) } } : {}),
            };
            held = await holdBudget({ left: available }, state, run.id, group);
            await tx.put(responseKey, { ...state.delegateResponse!, keys: [...new Set([...(prior?.keys ?? []), key])] });
          } else held = remaining / (maxParallel - running.length);
        }
        const child: DelegatedChild = { id: '', outbox: true, owner: place.owner, rootOwner: place.rootOwner, payer: run.params?.endUser, bucket: run.params?.bucket ?? config.bucket, key, requestId: `${background ? 'spawn' : 'delegate'}_${identity.slice(0, 48)}`, parentRequestId: run.id, toolCallId, ...(toolCallId !== callId ? { callId } : {}), task: args.instructions === undefined ? args.task as string : roleAndTask(args.instructions as string, args.task as string), name: typeof args.name === 'string' ? args.name : `${target?.name ?? 'subagent'}-${children.length + 1}`, depth: place.depth, maxDepth: place.maxDepth, chain: place.chain, root: place.chain[0], background, createdAt: Date.now(), status: 'running', made: target?.agent === undefined, ...(held !== undefined ? { held } : {}) };
        return this.putChild(tx, child);
      });
      if (admitted) {
        try {
          await this.checkCancellation(admitted, signal);
          const resolved = target ? await this.host.target(target) : undefined;
          if (resolved?.id && place.chain.includes(resolved.id)) throw new HttpError(400, 'This agent is already working on the delegation chain');
          // Left out, a definition that declares its own computer keeps it; other children share their parent computer.
          choice = computerChoice(args.computer, !resolved?.id && !!resolved?.config?.computer);
          const childConf: Configuration = childConfig(config, resolved?.config, run.params);
          // No computer: no native computer settings either (egress grants and their credentials stay the parent's).
          if (choice === 'none') delete childConf.computer;
          // Its own machine (fresh, fork) from a parent that has one: a child whose configuration declares none gets the
          // default computer. A parent without a computer gives none.
          else if (choice !== 'share' && !resolved?.id && childConf.computer === undefined && await this.host.hasComputer?.()) childConf.computer = {};
          const made = resolved?.id ? resolved : await this.host.create({ ...childConf, name: admitted.name, type: 'subagent', ttlSeconds: MULTI_AGENT_LIMITS.childTtlSeconds }, key, { agent: id, run: run.id, place: { ...place, ...(admitted.payer !== undefined ? { payer: admitted.payer } : {}) } });
          let fork: ChildComputerFork | undefined;
          try { fork = await forking; }
          catch (error) {
            // Nothing is kept for a fork that could not be taken (a replay's child, made earlier, stays).
            if (!resumed?.id && !resolved?.id && made.id) await this.host.remove?.(made.id).catch(() => {});
            throw error;
          }
          if (!resolved?.id) await this.host.inheritComputer?.(id, made.id!, choice === 'none' || choice === 'share' ? choice : fork);
          Object.assign(admitted, await this.update(admitted, { id: made.id! }));
          await this.checkCancellation(admitted, signal);
          // Who started the run, for readers of its metadata; its place in the chain goes with it through the binding.
          const metadata = { [PARENT_KEYS.agent]: id, [PARENT_KEYS.run]: run.id, [PARENT_KEYS.toolCall]: toolCallId };
          const placement: Placement = { owner: place.owner, rootOwner: place.rootOwner, chain: place.chain, depth: place.depth, maxDepth: place.maxDepth, toolCallId, ownerRun: run.id };
          await this.host.emit({ type: 'event', requestId: run.id, event: { type: 'subagent_start', toolCallId, agentId: admitted.id, requestId: admitted.requestId, name: admitted.name, depth: admitted.depth, ...(admitted.background ? { background: true } : {}) } });
          await this.host.storage.put(`delegation-run:${admitted.id}:${admitted.requestId}`, admitted.key);
          await this.checkCancellation(admitted, signal);
          const submitted = await this.host.submitChild(admitted.id, { id: admitted.requestId, method: 'prompt', params: { text: (await this.details(admitted)).task, endUser: admitted.payer, bucket: admitted.bucket, metadata, whileRunning: 'queue', ...(run.params?.actor ? { actor: run.params.actor } : {}), ...(held !== undefined ? { spendLimit: { usd: held } } : {}), ...(args.output !== undefined ? { output: { schema: modelOutputSchema(args.output) } } : {}) } }, placement);
          if (!submitted.ok) throw new HttpError(submitted.status, submitted.error || 'Child submission failed');
          Object.assign(admitted, await this.update(admitted, { accepted: true }));
          this.follow(admitted);
          this.reportMemory(await this.children(), id, run.id);
          if (signal.aborted || admitted.cancelRequested) {
            await this.cancelRemote(admitted);
            await this.wait(admitted, AbortSignal.timeout(10_000)).catch(() => {});
            throw new DOMException('Delegation cancelled', 'AbortError');
          }
          return childState(admitted);
        } catch (error) {
          const current = await this.rows.get(key) ?? admitted;
          if (!current.accepted) {
            const cancelled = signal.aborted || current.cancelRequested;
            Object.assign(admitted, await this.update(current, { status: cancelled ? 'aborted' : 'failed', error: error instanceof Error ? error.message : 'Child failed', endedAt: Date.now(), held: undefined, ...(cancelled ? { cancelRequested: true } : {}) }));
            if (cancelled && admitted.id) await this.cancelRemote(admitted);
            await this.host.emit({ type: 'event', requestId: run.id, event: { type: 'subagent_end', toolCallId, agentId: admitted.id, requestId: admitted.requestId, name: admitted.name, status: admitted.status, error: admitted.error, ...(admitted.background ? { background: true } : {}) } });
          }
          this.signalChange('*');
          throw error;
        }
      }
      await this.waitChange('*', signal);
    }
  }
  /** An ended child's notification, if it still owes one. A running child's ending comes to `receiveEnding` by itself. */
  private follow(child: DelegatedChild) {
    if (child.status === 'running' || !child.background || child.notified) return;
    this.host.waitUntil(this.afterCompletion(child));
  }
  private afterCompletion(child: DelegatedChild): Promise<void> {
    const pending = this.completions.get(child.key);
    if (pending) return pending;
    const work = this.finishChild(child).finally(() => this.completions.delete(child.key));
    this.completions.set(child.key, work);
    return work;
  }
  private async finishChild(child: DelegatedChild) {
    try {
      child = await this.rows.get(child.key) ?? child;
      if (child.background && this.host.notify && !child.notified && child.landedBy !== 'wait') {
        await this.host.notify(await this.details(child));
        await this.host.storage.transaction(async tx => {
          const latest = await this.rows.get(child.key);
          if (latest) await this.putChild(tx, { ...latest, notified: true });
        });
      }
      if (child.background && child.status === 'input_required') await this.resumePaused(child);
    } catch {
      // The next wake (recover) tries again: the row still owes its notification.
      await this.host.retry?.(MULTI_AGENT_LIMITS.sweepMs).catch(() => {});
    }
  }
  private async complete(child: DelegatedChild, record: ChildRun) {
    const finished = await this.host.storage.transaction(async tx => {
      const current = await this.rows.get(child.key) ?? child;
      if (current.status !== 'running') return { child: current, changed: false };
      const usage = record.outcome?.result?.usage;
      const folded = !!(record.steeredInto || record.outcome?.result?.steeredInto);
      let value: DelegatedChild = { ...current, folded, ...(folded ? { notified: true } : {}), status: childStatus(record), endedAt: Date.now(), outcome: record.outcome, error: record.error ?? record.outcome?.error, spent: folded ? 0 : childUsageCost(usage), held: undefined };
      value = await this.putChild(tx, value);
      if (!value.background) value = await this.settleInTransaction(tx, value, value.parentRequestId);
      return { child: value, changed: !folded };
    });
    // The transaction's winner counts: a delivery made again finds the row ended.
    this.measurements[finished.changed ? 'endings' : 'repeatedEndings']++;
    if (finished.changed && !child.background && child.made && child.id && finished.child.status !== 'input_required') this.host.waitUntil(this.host.releaseComputer?.(child.id).catch(() => {}) ?? Promise.resolve());
    if (finished.changed) await this.host.emit({ type: 'event', requestId: child.parentRequestId, event: { type: 'subagent_end', toolCallId: child.toolCallId, agentId: child.id, requestId: child.requestId, name: child.name, status: finished.child.status, ...(child.background ? { background: true } : {}), ...(finished.child.error ? { error: finished.child.error } : {}) } });
    this.signalChange(child.key);
    await this.afterCompletion(finished.child);
    return finished.child;
  }
  async wait(child: DelegatedChild, signal?: AbortSignal): Promise<DelegatedChild> {
    this.follow(child);
    return this.waitKey(child.key, signal);
  }
  private async waitKey(key: string, signal?: AbortSignal): Promise<DelegatedChild> {
    for (;;) {
      signal?.throwIfAborted();
      // Subscribe before reading, so a completion cannot fall between the read and wait.
      const controller = new AbortController();
      const change = this.waitChange(key, signal ? AbortSignal.any([signal, controller.signal]) : controller.signal);
      const saved = await this.rows.get(key);
      if (saved?.status !== 'running') { controller.abort(); await change.catch(() => {}); if (!saved) throw new Error('Unknown sub-agent'); return this.details(saved); }
      await change;
    }
  }
  answer(child: DelegatedChild) { return { agentId: child.id, requestId: child.requestId, name: child.name, status: child.status, ...(child.outcome?.result?.reply ? { text: child.outcome.result.reply } : {}), ...(child.outcome?.result?.output !== undefined ? { output: child.outcome.result.output } : {}), ...(child.outcome?.result?.stopped ? { stopped: child.outcome.result.stopped } : {}), ...(child.error ? { error: child.error } : {}) }; }
  async cancel(requestId?: string, callPrefix?: string, key?: string) {
    const children = await this.host.storage.transaction(async tx => {
      const children = (await this.rows.running()).filter(child => (!requestId || child.parentRequestId === requestId) && (!callPrefix || child.toolCallId.startsWith(callPrefix)) && (!key || child.key === key));
      for (const child of children) await this.putChild(tx, { ...child, cancelRequested: true });
      return children;
    });
    await Promise.all(children.map(child => this.cancelRemote(child)));
    // A stop answers once its delegate children have ended and their usage is
    // available to the parent's terminal outcome. Background children notify.
    const stop = AbortSignal.timeout(10_000);
    await Promise.all(children.filter(child => !child.background && child.id && child.accepted).map(child => this.wait(child, stop).catch(() => {})));
  }
  async settleStopped(requestId: string) {
    const stop = AbortSignal.timeout(10_000);
    const children = (await this.children()).filter(child => child.parentRequestId === requestId && child.cancelRequested && !child.background && child.id && child.accepted);
    await Promise.all(children.map(child => this.wait(child, stop).catch(() => {})));
  }
  async destroy() {
    await this.cancel();
    const made = new Set((await this.children()).filter(child => child.made).map(child => child.id));
    for (const id of made) if (id) await this.host.remove?.(id);
  }
  private async cancelRemote(child: DelegatedChild) {
      if (!child.id) return;
      if (this.host.cancelRequest) { await this.host.cancelRequest(child.id, child.requestId); return; }
      if (!child.made) {
        const response = await this.host.fetch(child.id, new Request(`https://agent/requests/${child.requestId}`));
        if (!response.ok) return;
        const record = await response.json() as ChildRun & { began?: number };
        if (record.state !== 'running' || !record.began) return;
      }
      await this.host.fetch(child.id, new Request('https://agent/requests', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: `abort-${child.accepted ? 'accepted-' : ''}${child.requestId}`, method: 'abort', params: {} }) }));
  }
  private async countCall(kind: string, runId: string, callId: string, limit: number) {
    await this.host.storage.transaction(async tx => {
      const key = `delegation-${kind}:${runId}`, calls = await tx.get<string[]>(key) ?? [];
      if (calls.includes(callId)) return;
      if (calls.length >= limit) throw new HttpError(400, `This turn has sent ${limit} ${kind}, the most one turn may send`);
      await tx.put(key, [...calls, callId]);
    });
  }
  /**
   * A child's progress report, delivered by its outbox: taken only for the exact child run this owner started, once per
   * call. A refusal is answered (`accepted: false`), not thrown, so the child's outbox drops it instead of retrying.
   */
  async recordProgress(report: ChildProgressReport): Promise<Receipt> {
    if (typeof report.text !== 'string' || !report.text.trim() || report.text.length > MULTI_AGENT_LIMITS.progressChars) return { accepted: false, error: 'Invalid progress report' };
    const recorded = await this.host.storage.transaction(async tx => {
      const child = await this.rows.byRun(report.agentId, report.requestId);
      if (!child) return { refused: 'Unknown sub-agent run' };
      const calls = child.progressCalls ?? [];
      if (child.status !== 'running' || calls.includes(report.callId)) return;
      if (calls.length >= MULTI_AGENT_LIMITS.progressPerRun) return { refused: 'Progress limit reached' };
      const progress = { text: report.text.trim(), at: Date.now(), sequence: calls.length + 1 };
      await this.putChild(tx, { ...child, progress, progressCalls: [...calls, report.callId] });
      return { child, progress };
    });
    if (recorded && 'refused' in recorded) return { accepted: false, error: recorded.refused };
    if (recorded) {
      const { child, progress } = recorded;
      await this.host.emit({ type: 'event', requestId: child.parentRequestId, event: { type: 'subagent_progress', toolCallId: child.toolCallId, agentId: child.id, requestId: child.requestId, name: child.name, text: progress.text, at: progress.at, ...(child.background ? { background: true } : {}) } });
      if (!child.background) await this.host.emit({ type: 'event', requestId: child.parentRequestId, event: { type: 'tool_execution_update', toolCallId: child.toolCallId, toolName: 'delegate', partialResult: { content: [{ type: 'text', text: progress.text }], details: { type: 'progress', tool: 'delegate', message: progress.text } } } });
    }
    this.signalChange("*");
    return { accepted: true };
  }
  private async takeProgress(api?: ToolExecutionApi) {
    const site = api ? await toolCallSite(api) : undefined;
    const entry = site?.assistant !== undefined ? await api!.commit(tx => tx.entry(site.assistant as never), BACKGROUND_CONTEXT) : undefined;
    const reports = await this.unshownProgress(entry?.model ?? []);
    await this.markShown(reports);
    return reports.map(({ name, text, at }) => ({ name, text, at }));
  }
  /**
   * The latest progress reports of the running children the model was not shown yet, leaving out those a wait_agent of
   * the same response (`assistant`, its model messages) shows itself. Nothing is marked shown: `markShown` does, once
   * the reports are in a result.
   */
  async unshownProgress(assistant: readonly { role: string; content: unknown }[]): Promise<ShownProgress[]> {
    const reports: ShownProgress[] = [];
    for (const child of await this.rows.running())
      if (child.progress && child.progress.sequence > (child.progressShown ?? 0) && !waitsForProgress(assistant, child))
        reports.push({ key: child.key, name: child.name, text: child.progress.text, at: child.progress.at, sequence: child.progress.sequence });
    return reports;
  }
  /** Mark these reports shown to the model, so no later result repeats them (a later report is still shown). */
  async markShown(reports: readonly ShownProgress[]) {
    if (!reports.length) return;
    await this.host.storage.transaction(async tx => {
      for (const report of reports) {
        const child = await this.rows.get(report.key);
        if (child && report.sequence > (child.progressShown ?? 0)) await this.putChild(tx, { ...child, progressShown: report.sequence });
      }
    });
  }
  private async toolResult(value: unknown, api?: ToolExecutionApi) {
    const reports = await this.takeProgress(api);
    // Code gets the value itself (structuredOutput); the model, its text.
    return { output: [{ type: 'text' as const, text: JSON.stringify(value) }, ...(reports.length ? [agentUpdates(reports)] : [])], structuredOutput: value as never };
  }
  private async send(args: Record<string, unknown>, callId: string, api?: ToolExecutionApi, signal?: AbortSignal) {
    if (!this.host.sendMessage) throw new HttpError(400, 'Agent messages are unavailable');
    if (typeof args.text !== 'string' || !args.text.trim() || args.text.length > MULTI_AGENT_LIMITS.taskChars || typeof args.to !== 'string') throw new HttpError(400, 'Invalid message');
    const { id, config, run } = await this.host.context(api), lineage = await this.lineage(id, run);
    await this.countCall('messages', run.id, callId, MULTI_AGENT_LIMITS.messagesPerRun);
    const identity = await digest(`${id}:${run.id}:${callId}`), requestId = `msg_${identity.slice(0, 48)}`;
    if (args.to === 'parent') {
      if (!lineage?.parent) throw new HttpError(400, 'This run has no parent');
      const message = agentMessage({ agentId: id, name: typeof config.name === 'string' ? config.name : 'subagent', root: lineage.root }, args.text, 'parent');
      const response = await this.host.sendMessage(lineage.parent, { id: requestId, method: 'prompt', params: { text: args.text, endUser: run.params?.endUser, bucket: run.params?.bucket ?? config.bucket, allowDisconnected: true, whileRunning: 'followUp' } }, message.notice) as { steer?: string; steeredInto?: string } | undefined;
      return { sent: true, to: 'parent', into: response?.steer === 'accepted' || response?.steeredInto ? 'its running turn' : 'a new turn of its own' };
    }
    const children = await this.children();
    const child = [...children].reverse().find(child => child.id === args.to || child.name === args.to);
    if (!child) throw new HttpError(404, 'Unknown sub-agent');
    // A spawn accepted beside this call may not have started its model turn yet.
    // Let it begin so the message joins that turn instead of waiting behind it.
    if (child.status === 'running') for (const deadline = Date.now() + 10_000; Date.now() < deadline;) {
      signal?.throwIfAborted();
      const response = await this.host.fetch(child.id, new Request(`https://agent/requests/${child.requestId}`));
      const record = response.ok ? await response.json() as { began?: number; state?: string } : undefined;
      if (!record || record.began || record.state === 'completed') break;
      await this.waitChange('*', AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(Math.max(1, deadline - Date.now()))])).catch(error => { if (signal?.aborted) throw error; });
    }
    const key = `message-${identity.slice(0, 48)}`, existing = await this.rows.get(key);
    const answer = (value: DelegatedChild) => ({ sent: true, to: child.name, agentId: child.id, into: value.folded ? 'its running turn' : 'a new turn: its answer comes as a notification' });
    if (existing?.accepted) { this.follow(existing); return answer(existing); }
    const next: DelegatedChild = existing ?? { ...child, outbox: true, payer: run.params?.endUser, bucket: run.params?.bucket ?? config.bucket, key, requestId, parentRequestId: run.id, toolCallId: callId, task: args.text, background: true, createdAt: Date.now(), endedAt: undefined, status: 'running', held: undefined, spent: undefined, charged: undefined, outcome: undefined, error: undefined, notified: undefined, landedBy: undefined, accepted: false, cancelRequested: undefined, folded: undefined, progress: undefined, progressCalls: undefined, progressShown: undefined };
    await this.putChild(this.host.storage, next);
    const chain = child.chain ?? [...lineage?.chain ?? [], id], maxDepth = child.maxDepth ?? config.delegate?.maxDepth ?? MULTI_AGENT_LIMITS.maxDepth;
    const metadata = { [PARENT_KEYS.agent]: id, [PARENT_KEYS.run]: run.id, [PARENT_KEYS.toolCall]: callId };
    // The child's turn this message starts runs where the child was placed: the placement goes with the notice.
    const rootOwner = ownerOf(child.rootOwner) ?? agentOwner(chain[0] ?? id);
    const delegation: Placement = { owner: agentOwner(id), rootOwner, chain, depth: child.depth, maxDepth, toolCallId: callId, ownerRun: run.id };
    const message = agentMessage({ agentId: id, name: 'parent', root: child.root ?? lineage?.root ?? id }, args.text, 'child');
    try {
      await this.host.sendMessage(child.id, { id: requestId, method: 'prompt', params: { text: args.text, endUser: run.params?.endUser, bucket: run.params?.bucket ?? config.bucket, allowDisconnected: true, whileRunning: 'followUp', metadata } }, { ...message.notice, delegation });
    } catch (error) {
      // As Node marks the message's row: it ends failed, with no notification to come. Left running, a later wait polled
      // a request the child never had and called the child deleted (a child DO reset while starting, on the pilot).
      await this.putChild(this.host.storage, { ...next, status: 'failed', endedAt: Date.now(), notified: true, error: `The message did not reach ${child.name}: ${error instanceof Error ? error.message : String(error)}` });
      throw error;
    }
    const response = await this.host.fetch(child.id, new Request(`https://agent/requests/${requestId}`));
    const record = response.ok ? await response.json() as { steer?: string; steeredInto?: string } : undefined;
    if (record?.steer === 'accepted' || record?.steeredInto) {
      // Keep waits on the original child while Pi places the message. The final
      // receipt decides whether it joined that turn or began another one.
      next.folded = true;
    }
    next.accepted = true;
    await this.putChild(this.host.storage, next);
    this.follow(next);
    return answer(next);
  }
  private async progress(args: Record<string, unknown>, callId: string, api?: ToolExecutionApi) {
    if (!this.host.reportProgress) throw new HttpError(400, 'Progress reports are unavailable');
    if (typeof args.text !== 'string' || !args.text.trim() || args.text.length > MULTI_AGENT_LIMITS.progressChars) throw new HttpError(400, 'Invalid progress report');
    const { id, run } = await this.host.context(api), lineage = await this.lineage(id, run);
    if (!lineage?.parent) throw new HttpError(400, 'This run has no parent');
    await this.countCall('progress reports', run.id, callId, MULTI_AGENT_LIMITS.progressPerRun);
    // Through this agent's outbox: delivered now if the owner answers, else by the alarm, in order.
    const receipt = await this.host.reportProgress(lineage.owner, { agentId: id, requestId: run.id, text: args.text.trim(), callId });
    if (!receipt.accepted) throw new HttpError(400, receipt.error ?? 'Your parent did not take the report');
    return { reported: true };
  }
  async recover() {
    // Evicted objects can still have the old inline representation. Move it out
    // once before status scans; large payloads must not populate the KV cache.
    for (const child of await this.rows.all()) {
      if (child.task !== undefined || child.outcome !== undefined) await this.putChild(this.host.storage, child);
    }
    for (const child of await this.children()) {
      if (child.background && child.status === 'input_required') await this.resumePaused(child);
      if (child.cancelRequested && child.status === 'running') {
        await this.cancelRemote(child);
        if (!child.accepted) {
          if (!child.id) { await this.update(child, { status: 'aborted', endedAt: Date.now(), held: undefined }); continue; }
          const accepted = await this.update(child, { accepted: true });
          this.follow(accepted);
          if (!accepted.outbox) await this.reconcileLegacy(accepted);
          continue;
        }
      }
      if (child.accepted) this.follow(child);
      if (child.accepted && child.status === 'running' && !child.outbox) await this.reconcileLegacy(child);
    }
  }
  /**
   * A child started before durable endings (its row has no `outbox`): its ending was pushed once, fire and forget, and
   * may have been lost. Asked once at start, never polled. Goes with the contract deploy (PR 6), when no such row is left
   * running (a made child lives a day).
   */
  private async reconcileLegacy(child: DelegatedChild) {
    try {
      const response = await this.host.fetch(child.id, new Request(`https://agent/requests/${child.requestId}`));
      if (!response.ok && ![404, 410].includes(response.status)) return;
      const record: ChildRun = response.ok ? await response.json() : { state: 'completed', status: 'failed', error: 'The sub-agent was deleted before it answered' };
      if (record.state !== 'completed') return;
      this.measurements.legacyRecovered++;
      await this.complete(child, record);
    } catch { /* The next start asks again. */ }
  }
  private async resumePaused(child: DelegatedChild) {
    if (child.cancelRequested) return;
    const key = `${child.key}:resume`;
    if (await this.rows.get(key)) return;
    const requestId = `resume_${(await digest(child.requestId)).slice(0, 40)}`;
    const response = await this.host.fetch(child.id, new Request(`https://agent/requests/${requestId}`));
    if (response.status === 404) {
      if (Date.now() - child.createdAt < MULTI_AGENT_LIMITS.childTtlSeconds * 1000) await this.host.retry?.(MULTI_AGENT_LIMITS.sweepMs);
      return;
    }
    if (!response.ok) return;
    const resumed: DelegatedChild = { ...child, outbox: true, key, requestId, payloadBytes: undefined, createdAt: Date.now(), status: 'running', endedAt: undefined, outcome: undefined, error: undefined, spent: undefined, held: undefined, charged: undefined, notified: undefined, landedBy: undefined, progress: undefined, progressCalls: undefined, progressShown: undefined };
    await this.putChild(this.host.storage, resumed);
    this.follow(resumed);
  }
  async targetDescriptions(settings: DelegateSettings) {
    const descriptions = new Map<string, string>();
    const key = (target: NonNullable<DelegateSettings['agents']>[number]) => `${target.definition}:${target.revision ?? "latest"}`;
    await Promise.all((settings.agents ?? []).filter(target => target.definition && !target.description).map(async target => {
      const resolved = await this.host.target(target).catch(() => undefined);
      if (resolved?.description) descriptions.set(key(target), resolved.description);
    }));
    return (target: NonNullable<DelegateSettings['agents']>[number]) => target.definition ? descriptions.get(key(target)) : undefined;
  }
  /** Only the trusted runtime-auth source registration exposes this callback. */
  async toolSpawn(tool: string, directive: unknown, api: ToolExecutionApi, context: Context): Promise<McpResult> {
    if ((await toolCallSite(api, context)).innerCallId) throw new Error(`${tool} starts a sub-agent: call it directly, not from code`);
    const invalid = () => new Error(`${tool} answered with an invalid camelrun/spawn: { agent: "<agent id>", task, name?, output? }`);
    if (!directive || typeof directive !== 'object' || Array.isArray(directive)) throw invalid();
    const { agent, task, name, output, ...rest } = directive as Record<string, unknown>;
    if (Object.keys(rest).length || typeof agent !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(agent) || typeof task !== 'string' || !task.trim() || task.length > MULTI_AGENT_LIMITS.taskChars || (name !== undefined && (typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(name)))) throw invalid();
    if (output !== undefined) outputInput({ schema: output });
    const { config } = await this.host.context(api);
    const target = await this.host.target({ agent }).catch(() => undefined);
    if (!target?.id) throw new Error(`${tool} asked to start an agent this account does not have`);
    const base = typeof name === 'string' ? name : String(target.config.name ?? '').replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 56) || 'worker';
    const running = (await this.children()).filter(child => child.status === 'running');
    let chosen = base, n = 1;
    while (running.some(child => child.name === chosen)) chosen = `${base.slice(0, 56)}-${n++}`;
    const child = await this.start({ agent, task, name: chosen, ...(output !== undefined ? { output } : {}) }, api.callId, context.abortSignal ?? new AbortController().signal, true, api, { ...config.delegate, agents: [{ name: agent, agent }] });
    const result = { agentId: child.id, name: child.name };
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
  }
  async toolsFor(settings: DelegateSettings, builtins: readonly string[], subagent = false): Promise<ToolRegistration[]> {
    return this.tools(settings, builtins, subagent, await this.targetDescriptions(settings));
  }
  tools(settings: DelegateSettings, builtins: readonly string[], subagent = false, describe: Parameters<typeof delegateTool>[1] = () => undefined): ToolRegistration[] {
    const definitions: ToolDefinition[] = [...(builtins.includes('delegate') ? [delegateTool(settings, describe)] : []), ...(builtins.includes('agents') ? agentsTools(settings, describe) : [])];
    if (subagent) definitions.push(REPORT_PROGRESS, ...(!definitions.some(tool => tool.name === 'send_message') ? [SEND_MESSAGE] : []));
    return definitions.map(definition => defineTool({ name: definition.name, description: definition.description, parameters: definition.parameters as never, ...(definition.callers ? { callers: definition.callers as ('model' | 'tools')[] } : {}), structuredOutputSchema: {}, replay: 'safe', execute: async (args: Record<string, unknown>, api, context) => {
      const signal = context.abortSignal ?? new AbortController().signal;
      if (definition.name === 'delegate') {
        try {
          const admitted = await this.start(args, api.callId, signal, false, api);
          args = {};
          const child = await this.wait(admitted, signal);
          return { ...await this.toolResult(this.answer(child), api), ...(child.status === 'completed' ? {} : { isError: true }) };
        } catch (error) {
          // A call from code whose script ended without awaiting it (Pi aborts the calls a script leaves out): its child
          // stops, as no one will read its answer. A call cut off otherwise (the agent restarting) keeps its child for
          // the script's replay.
          if (signal.aborted && api.callId.includes('/') && (await scriptOf(api).catch(() => undefined))?.ended)
            await this.cancel(undefined, undefined, `delegate-${(await digest(`${(await this.host.context(api)).run.id}:${api.callId}`)).slice(0, 48)}`).catch(() => {});
          throw error;
        }
      }
      if (definition.name === 'spawn_agent') {
        const work = this.start(args, api.callId, signal, true, api);
        this.starting.add(work);
        try { const child = await work; return this.toolResult(this.answer(child.status === 'running' ? child : await this.details(child)), api); }
        finally { this.starting.delete(work); }
      }
      if (['wait_agent', 'list_agents', 'send_message', 'interrupt_agent'].includes(definition.name))
        await Promise.allSettled([...this.starting]);
      if (definition.name === 'send_message') return this.toolResult(await this.send(args, api.callId, api, signal), api);
      if (definition.name === 'report_progress') return this.toolResult(await this.progress(args, api.callId, api), api);
      const children = await this.children();
      // The 200 most recently started, oldest first, as on Node: a long-lived lead's list goes on showing its new children.
      if (definition.name === 'list_agents') return this.toolResult({ agents: [...new Map(children.filter(child => child.background && !child.folded).map(child => [child.id, child])).values()].slice(-200).map(child => ({ agentId: child.id, name: child.name, status: child.status, startedAt: child.createdAt, ...(child.endedAt ? { endedAt: child.endedAt } : {}), ...(child.progress ? { progress: escapeMarkers(child.progress.text), progressAt: child.progress.at } : {}) })) }, api);
      if (definition.name === 'wait_agent') {
        if (args.agents !== undefined && (!Array.isArray(args.agents) || args.agents.some(name => typeof name !== 'string'))) throw new HttpError(400, 'agents is a list of names or agentIds');
        if (args.timeoutMs !== undefined && (!Number.isInteger(args.timeoutMs) || Number(args.timeoutMs) < 1000 || Number(args.timeoutMs) > MULTI_AGENT_LIMITS.maxWaitMs)) throw new HttpError(400, `timeoutMs is an integer from 1000 to ${MULTI_AGENT_LIMITS.maxWaitMs}`);
        const background = [...new Map(children.filter(child => child.background && !child.folded).map(child => [child.id, child])).values()];
        const selected = background.filter(child => Array.isArray(args.agents) ? args.agents.includes(child.id) || args.agents.includes(child.name) : !child.landedBy);
        if (Array.isArray(args.agents)) for (const name of args.agents) if (!selected.some(child => child.id === name || child.name === name)) throw new HttpError(400, `You have no sub-agent ${name}`);
        if (!selected.length) return this.toolResult({ agents: [] }, api);
        if (args.untilProgress !== undefined && typeof args.untilProgress !== 'boolean') throw new HttpError(400, 'untilProgress is true or false');
        const deadline = Date.now() + Number(args.timeoutMs ?? MULTI_AGENT_LIMITS.waitMs), earliestProgress = Date.now() + MULTI_AGENT_LIMITS.progressWaitMs;
        for (const child of selected) if (child.status === 'running') this.follow(child);
        const messaged = new Set<string>(), updated = new Set<string>();
        // In flight (`waiting`, the asap check) until the endings it answers are taken: a notification arriving meanwhile
        // is not steered into the turn, so this wait, not a steer, takes its ending.
        this.waiting++;
        try {
          while (Date.now() < deadline) {
            signal.throwIfAborted();
            const latest = (await this.children()).filter(child => selected.some(old => old.key === child.key));
            if (latest.some(child => child.status !== 'running' && !child.landedBy) || latest.every(child => child.status !== 'running')) break;
            for (const notice of (await this.host.storage.list<{ request: { id: string }; notice: RuntimeNotice }>({ prefix: 'delegation-notice:' })).values()) {
              if (notice.notice.metadata.kind !== 'message') continue;
              const record = await this.host.storage.get<{ state: string; accepted?: boolean }>(`request:${notice.request.id}`);
              // Admission writes the request before Pi queues its steering input. A wait may
              // return only after that input is durable, so the next step sees the message.
              if (record?.accepted && record.state !== 'completed') messaged.add(notice.notice.source.name);
            }
            if (messaged.size) break;
            if (args.untilProgress && Date.now() >= earliestProgress) for (const child of latest) if (child.progress && child.progress.sequence > (child.progressShown ?? 0)) updated.add(child.name);
            if (updated.size) break;
            await this.waitChange('*', AbortSignal.any([signal, AbortSignal.timeout(Math.min(WAIT_RECHECK_MS, Math.max(1, deadline - Date.now())))] )).catch(error => { if (signal.aborted) throw error; });
          }
          const { run } = await this.host.context(api);
          const answers = await this.host.storage.transaction(async tx => {
            const answers: (ReturnType<Delegation['answer']> | { agentId: string; name: string; status: string; note: string })[] = [];
            for (const old of selected) {
              const child = await this.rows.get(old.key) ?? old;
              if (child.status !== 'running' && child.landedBy) answers.push({ agentId: child.id, name: child.name, status: child.status, note: 'Its answer comes (or came) as a notification' });
              else {
                answers.push({ ...this.answer(await this.details(child, tx)), ...(child.status === 'running' && child.progress ? { progress: child.progress.text, progressAt: child.progress.at } : {}) });
                if (child.status !== 'running') await this.settleInTransaction(tx, { ...child, notified: true, landedBy: 'wait' }, run.id);
                else if (child.progress) await this.putChild(tx, { ...child, progressShown: child.progress.sequence });
              }
            }
            return answers;
          });
          return this.toolResult({ agents: answers, ...(messaged.size ? { messaged: [...messaged], message: `${[...messaged].join(', ')} sent you a message, which follows this result: read it, then wait again if you need to` } : {}), ...(updated.size ? { updated: [...updated] } : {}), ...(!messaged.size && !updated.size && answers.every(child => child.status === 'running') ? { timedOut: true } : {}) }, api);
        } finally { this.waiting--; }
      }
      const child = children.find(child => child.id === args.agent || child.name === args.agent || child.id === args.to || child.name === args.to);
      if (!child) throw new HttpError(404, 'Unknown sub-agent');
      if (definition.name === 'interrupt_agent') { await this.host.fetch(child.id, new Request('https://agent/requests', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: `interrupt-${api.callId}`, method: 'abort', params: {} }) })); return this.toolResult({ agentId: child.id, interrupted: true }, api); }
      throw new HttpError(400, 'Unknown delegation tool');
    } }));
  }
}
