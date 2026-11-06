import { defineTool, type ToolRegistration, type ToolExecutionApi } from '@earendil-works/pi-durable';
import { HttpError } from './errors.ts';
import { digest } from './api-contract.ts';
import { MULTI_AGENT_LIMITS, PARENT_KEYS, roleAndTask, delegateTool, agentsTools, agentMessage, agentUpdates, REPORT_PROGRESS, SEND_MESSAGE, type DelegateSettings } from './multi-agent-policy.ts';
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
import { followEvents } from './event-follow.ts';

type Configuration = { model?: string | object; systemPrompt?: string; delegate?: DelegateSettings; builtins?: string[]; spendLimit?: { usd: number }; [key: string]: unknown };
export type ParentRun = { id: string; piId?: string; startedAt?: number; params?: { spendLimit?: { usd: number }; bucket?: string; actor?: string }; metadata?: unknown };
export type ChildUsage = { costUsd?: number; subagentCostUsd?: number; imageCostUsd?: number; decisionCostUsd?: number; webCostUsd?: number; transcriptionCostUsd?: number };
export type ChildRun = { state: string; status?: string; error?: string; steeredInto?: string; outcome?: { result?: { reply?: string; output?: unknown; code?: string; stopped?: string; steeredInto?: string; usage?: ChildUsage }; error?: string } };
export function childUsageCost(usage?: ChildUsage) {
  return (usage?.costUsd ?? 0) + (usage?.subagentCostUsd ?? 0) + (usage?.imageCostUsd ?? 0) + (usage?.decisionCostUsd ?? 0) + (usage?.webCostUsd ?? 0) + (usage?.transcriptionCostUsd ?? 0);
}
export type ChildProgressReport = { agentId: string; requestId: string; text: string; callId: string };
export type DelegatedChild = { id: string; key: string; requestId: string; parentRequestId: string; toolCallId: string; task: string; name: string; depth: number; maxDepth?: number; chain?: string[]; root?: string; background?: boolean; folded?: boolean; createdAt: number; endedAt?: number; status: string; made: boolean; held?: number; spent?: number; charged?: boolean; outcome?: ChildRun['outcome']; error?: string; notified?: boolean; landedBy?: 'wait' | 'notice'; accepted?: boolean; cancelRequested?: boolean; progress?: { text: string; at: number; sequence: number }; progressShown?: number; progressCalls?: string[] };
export interface DelegationHost {
  storage: DurableObjectStorage;
  secret: string;
  context(api?: ToolExecutionApi): Promise<{ id: string; config: Configuration; run: ParentRun }>;
  /** Authoritative remaining spend after completed work, before active child shares. */
  remainingBudget?(background: boolean, api?: ToolExecutionApi): Promise<number | undefined>;
  create(config: Configuration, key: string, parent?: { agent: string; run: string }): Promise<{ id: string }>;
  /** Copy an eligible parent connection before a newly created child starts. */
  inheritComputer?(parent: string, child: string): Promise<void>;
  target(ref: { agent?: string; definition?: string }): Promise<{ id?: string; config: Configuration; description?: string }>;
  fetch(id: string, request: Request): Promise<Response>;
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
  reportProgress?(parentId: string, report: ChildProgressReport): Promise<unknown>;
}
type ChildRelay = { abort(): void; drained: Promise<void> };
const prefix = 'delegation:';
type ChildCharge = { requestId: string; usd: number; at: number };
const chargePrefix = 'delegation-charge:';
const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason);
  const stop = () => { clearTimeout(timer); reject(signal?.reason); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
  signal?.addEventListener('abort', stop, { once: true });
});
function finiteBudget(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}
async function signature(secret: string, agent: string, run: string, depth: string, maxDepth: string, chain: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`delegation-v1:${agent}:${run}:${depth}:${maxDepth}:${chain}`));
  return [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2, '0')).join('');
}

/** Durable child lifecycle; Pi owns invocation replay, and the child request is idempotent. */
export class Delegation {
  private readonly following = new Set<string>();
  private readonly starting = new Set<Promise<DelegatedChild>>();
  private readonly host: DelegationHost;
  constructor(host: DelegationHost) { this.host = host; }
  async children() { return [...(await this.host.storage.list<DelegatedChild>({ prefix })).values()].sort((a, b) => a.createdAt - b.createdAt || a.key.localeCompare(b.key)); }
  async cost(requestId: string) { return [...(await this.host.storage.list<ChildCharge>({ prefix: chargePrefix })).values()].filter(charge => charge.requestId === requestId).reduce((sum, charge) => sum + charge.usd, 0); }
  async costSince(startedAt: number) { return [...(await this.host.storage.list<ChildCharge>({ prefix: chargePrefix })).values()].filter(charge => charge.at >= startedAt).reduce((sum, charge) => sum + charge.usd, 0); }
  /** A child's ending is charged when a call, notification or recovery takes it. */
  async settleInTransaction(tx: DurableObjectTransaction, child: DelegatedChild, requestId: string) {
    if (child.charged || child.folded) return child;
    const sequence = (await tx.get<number>('delegation-charge-sequence') ?? 0) + 1;
    await tx.put('delegation-charge-sequence', sequence);
    await tx.put(`${chargePrefix}${sequence}`, { requestId, usd: child.spent ?? childUsageCost(child.outcome?.result?.usage), at: Date.now() } satisfies ChildCharge);
    const charged = { ...child, charged: true };
    await tx.put(prefix + child.key, charged);
    return charged;
  }
  async landNotice(requestId: string, costUsd: number) {
    return this.host.storage.transaction(async tx => {
      const child = [...(await tx.list<DelegatedChild>({ prefix })).values()].find(child => `child_${child.requestId}` === requestId);
      if (child) return this.settleInTransaction(tx, { ...child, spent: costUsd }, requestId);
    });
  }
  private async update(child: DelegatedChild, patch: Partial<DelegatedChild>) {
    return this.host.storage.transaction(async tx => {
      const current = await tx.get<DelegatedChild>(prefix + child.key) ?? child;
      const next = { ...current, ...patch, ...(current.cancelRequested ? { cancelRequested: true } : {}) };
      await tx.put(prefix + child.key, next);
      return next;
    });
  }
  private async checkCancellation(child: DelegatedChild, signal: AbortSignal) {
    signal.throwIfAborted();
    if ((await this.host.storage.get<DelegatedChild>(prefix + child.key))?.cancelRequested)
      throw new DOMException('Delegation cancelled', 'AbortError');
  }
  /** Verified ancestry only; public prompt metadata cannot mint parent identity. */
  async lineage(id: string, run: ParentRun) {
    const metadata = run.metadata && typeof run.metadata === 'object' ? run.metadata as Record<string, unknown> : {};
    const depth = metadata[PARENT_KEYS.depth], max = metadata[PARENT_KEYS.maxDepth], chain = metadata[PARENT_KEYS.chain] ?? '';
    if (typeof depth !== 'string' || typeof max !== 'string' || typeof chain !== 'string') return;
    if (depth === undefined || max === undefined || metadata[PARENT_KEYS.signature] !== await signature(this.host.secret, id, run.piId ?? run.id, depth, max, chain)) return;
    const parents = chain.split(',').filter(Boolean);
    return { depth: Number(depth), maxDepth: Number(max), chain: parents, parent: parents.at(-1)!, root: parents[0]! };
  }
  private async place(id: string, run: ParentRun, settings: DelegateSettings) {
    const lineage = await this.lineage(id, run);
    const parentDepth = lineage?.depth ?? 0;
    const maxDepth = Math.min(lineage?.maxDepth ?? MULTI_AGENT_LIMITS.depthCeiling, settings.maxDepth ?? MULTI_AGENT_LIMITS.maxDepth);
    if (parentDepth + 1 > maxDepth) throw new HttpError(400, `Delegation has reached its depth limit of ${maxDepth}: do this task yourself`, 'DELEGATION_DEPTH');
    return { depth: parentDepth + 1, maxDepth, chain: [...lineage?.chain ?? [], id] };
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
    const stored = await this.host.storage.get<DelegatedChild>(prefix + key);
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
    if (stored?.accepted || (stored && stored.status !== 'running')) { this.follow(stored); return stored; }
    // Creation and submit use deterministic keys; replay an interrupted acceptance safely.
    if (stored) await this.host.storage.delete(prefix + key);
    const place = await this.place(id, run, settings);
    const maxParallel = settings.maxParallel ?? MULTI_AGENT_LIMITS.maxParallel;
    let group: { messageIndex: number; delegates: number } | undefined;
    if (!background && !override && api?.getTask && api.commit) {
      const site = await toolCallSite(api);
      if (site.assistant !== undefined) {
        const entry = await api.commit(tx => tx.entry(site.assistant as never), BACKGROUND_CONTEXT);
        let delegates = 0;
        for (const message of entry?.model ?? []) if (message.role === 'assistant')
          for (const part of message.content) if (part.type === 'toolCall' && part.name === 'delegate') delegates++;
        group = { messageIndex: site.assistant, delegates: Math.max(1, delegates) };
      }
    }
    let held: number | undefined;
    // Slot and budget reservation are one SQLite transaction. No model call can race them.
    for (;;) {
      signal.throwIfAborted();
      const available = this.host.remainingBudget
        ? await this.host.remainingBudget(background, api)
        : finiteBudget(run.params?.spendLimit?.usd) ?? finiteBudget(config.spendLimit?.usd);
      const admitted = await this.host.storage.transaction(async tx => {
        const all = [...(await tx.list<DelegatedChild>({ prefix })).values()];
        const children = all.filter(child => child.parentRequestId === run.id);
        const scope = background ? all.filter(child => child.background) : children;
        const running = scope.filter(child => child.status === 'running');
        if (running.length >= maxParallel) {
          if (background) throw new HttpError(400, `${running.length} sub-agents are running, this agent's most at once: wait for one to finish (wait_agent) before starting another`);
          return false;
        }
        if (args.name && running.some(child => child.name === args.name)) throw new HttpError(400, 'A sub-agent with this name is already running');
        if (available !== undefined) {
          const reserved = this.host.remainingBudget
            ? all.filter(child => !child.charged && !child.folded).reduce((sum, child) => sum + (child.status === 'running' ? child.held ?? 0 : child.spent ?? 0), 0)
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
        const child: DelegatedChild = { id: '', key, requestId: `${background ? 'spawn' : 'delegate'}_${identity.slice(0, 48)}`, parentRequestId: run.id, toolCallId: callId, task: args.instructions === undefined ? args.task as string : roleAndTask(args.instructions as string, args.task as string), name: typeof args.name === 'string' ? args.name : `${target?.name ?? 'subagent'}-${children.length + 1}`, depth: place.depth, maxDepth: place.maxDepth, chain: place.chain, root: place.chain[0], background, createdAt: Date.now(), status: 'running', made: target?.agent === undefined, ...(held !== undefined ? { held } : {}) };
        await tx.put(prefix + key, child);
        return child;
      });
      if (admitted) {
        try {
          await this.checkCancellation(admitted, signal);
          const resolved = target ? await this.host.target(target) : undefined;
          if (resolved?.id && place.chain.includes(resolved.id)) throw new HttpError(400, 'This agent is already working on the delegation chain');
          const made = resolved?.id ? resolved : await this.host.create({ ...childConfig(config, resolved?.config, run.params), name: admitted.name, type: 'subagent', ttlSeconds: MULTI_AGENT_LIMITS.childTtlSeconds }, key, { agent: id, run: run.id });
          Object.assign(admitted, await this.update(admitted, { id: made.id! }));
          if (!resolved?.id) await this.host.inheritComputer?.(id, admitted.id);
          await this.checkCancellation(admitted, signal);
          const metadata = { [PARENT_KEYS.agent]: id, [PARENT_KEYS.run]: run.id, [PARENT_KEYS.toolCall]: callId, [PARENT_KEYS.depth]: String(place.depth), [PARENT_KEYS.maxDepth]: String(place.maxDepth), [PARENT_KEYS.chain]: place.chain.join(',') };
          const signed = { ...metadata, [PARENT_KEYS.signature]: await signature(this.host.secret, admitted.id, admitted.requestId, String(place.depth), String(place.maxDepth), place.chain.join(',')) };
          await this.host.emit({ type: 'event', requestId: run.id, event: { type: 'subagent_start', toolCallId: callId, agentId: admitted.id, requestId: admitted.requestId, name: admitted.name, depth: admitted.depth, ...(admitted.background ? { background: true } : {}) } });
          const relay = await this.relay(admitted);
          try { await this.checkCancellation(admitted, signal); }
          catch (error) { relay.abort(); throw error; }
          const response = await this.host.fetch(admitted.id, new Request('https://agent/requests', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: admitted.requestId, method: 'prompt', params: { text: admitted.task, metadata: signed, whileRunning: 'queue', ...(run.params?.actor ? { actor: run.params.actor } : {}), ...(held !== undefined ? { spendLimit: { usd: held } } : {}), ...(args.output !== undefined ? { output: { schema: args.output } } : {}) } }) }));
          if (!response.ok) {
            relay.abort();
            const detail = await response.json().catch(() => undefined) as { error?: unknown } | undefined;
            throw new HttpError(response.status, typeof detail?.error === 'string' ? detail.error : 'Child submission failed');
          }
          Object.assign(admitted, await this.update(admitted, { accepted: true }));
          this.follow(admitted, relay);
          if (signal.aborted || admitted.cancelRequested) {
            await this.cancelRemote(admitted);
            throw new DOMException('Delegation cancelled', 'AbortError');
          }
          return admitted;
        } catch (error) {
          const current = await this.host.storage.get<DelegatedChild>(prefix + key) ?? admitted;
          if (!current.accepted) {
            const cancelled = signal.aborted || current.cancelRequested;
            Object.assign(admitted, await this.update(current, { status: cancelled ? 'aborted' : 'failed', error: error instanceof Error ? error.message : 'Child failed', endedAt: Date.now(), held: undefined, ...(cancelled ? { cancelRequested: true } : {}) }));
            if (cancelled && admitted.id) await this.cancelRemote(admitted);
            await this.host.emit({ type: 'event', requestId: run.id, event: { type: 'subagent_end', toolCallId: callId, agentId: admitted.id, requestId: admitted.requestId, name: admitted.name, status: admitted.status, error: admitted.error, ...(admitted.background ? { background: true } : {}) } });
          }
          throw error;
        }
      }
      await sleep(25, signal);
    }
  }
  private async relay(child: DelegatedChild) {
    const abort = new AbortController();
    let drain!: () => void;
    const drained = new Promise<void>(resolve => { drain = resolve; });
    let queued = Promise.resolve();
    await followEvents({
      events: 'https://agent/events?watch=1&subagents=1',
      fetch: (input, init) => this.host.fetch(child.id, new Request(input, init)),
    }, { push: item => {
      if (item.kind === 'failed') { abort.abort(); drain(); return; }
      if (item.kind !== 'event') return;
      const event = item.data as { type: string; requestId?: string; id?: string; event?: unknown };
      queued = queued.then(async () => {
        if (event.type === 'event' && event.requestId === child.requestId) await this.host.emit({ type: 'event', requestId: child.parentRequestId, event: { type: 'subagent_event', toolCallId: child.toolCallId, agentId: child.id, requestId: child.requestId, event: event.event } });
        if (event.type === 'response' && event.id === child.requestId) drain();
      }).catch(() => { abort.abort(); drain(); });
    } }, abort.signal);
    this.host.waitUntil(drained);
    return { abort: () => { abort.abort(); void queued.finally(drain); }, drained };
  }
  private follow(child: DelegatedChild, relay?: ChildRelay) {
    if (this.following.has(child.key) || (child.status !== 'running' && (!child.background || child.notified))) return;
    this.following.add(child.key);
    this.host.waitUntil((async () => {
      if (!relay && child.status === 'running') relay = await this.relay(child);
      await this.wait(child);
      // The response is published after its final assistant event. Let the
      // already-open stream consume it before closing the child subscription.
      if (relay) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([relay.drained, new Promise<void>(resolve => { timer = setTimeout(resolve, 1000); })]);
        clearTimeout(timer);
      }
      const finished = await this.host.storage.get<DelegatedChild>(prefix + child.key);
      if (finished?.background && this.host.notify && !finished.notified && finished.landedBy !== 'wait') {
        await this.host.notify(finished);
        await this.host.storage.transaction(async tx => {
          const latest = await tx.get<DelegatedChild>(prefix + child.key);
          if (latest) await tx.put(prefix + child.key, { ...latest, notified: true });
        });
      }
      if (finished?.background && finished.status === 'input_required') await this.resumePaused(finished);
    })().catch(async () => { await this.host.retry?.(); }).finally(() => { relay?.abort(); this.following.delete(child.key); }));
  }
  async wait(child: DelegatedChild, signal?: AbortSignal): Promise<DelegatedChild> {
    for (;;) {
      signal?.throwIfAborted();
      const saved = await this.host.storage.get<DelegatedChild>(prefix + child.key);
      if (saved?.status !== 'running') return saved ?? child;
      const response = await this.host.fetch(child.id, new Request(`https://agent/requests/${child.requestId}?wait=1`, { signal }));
      if (!response.ok && response.status !== 404 && response.status !== 410) throw new HttpError(response.status, 'Child agent unavailable');
      const record: ChildRun = response.ok ? await response.json() : { state: 'completed', status: 'failed', error: 'The sub-agent was deleted before it answered' };
      if (record.state === 'completed') {
        const finished = await this.host.storage.transaction(async tx => {
          const current = await tx.get<DelegatedChild>(prefix + child.key) ?? child;
          if (current.status !== 'running') return { child: current, changed: false };
          const usage = record.outcome?.result?.usage;
          const folded = !!(record.steeredInto || record.outcome?.result?.steeredInto);
          let value: DelegatedChild = { ...current, folded, ...(folded ? { notified: true } : {}), status: record.outcome?.result?.code === 'aborted' ? 'aborted' : record.status ?? (record.outcome?.error ? 'failed' : 'completed'), endedAt: Date.now(), outcome: record.outcome, error: record.error ?? record.outcome?.error, spent: folded ? 0 : childUsageCost(usage), held: undefined };
          await tx.put(prefix + child.key, value);
          if (!value.background) value = await this.settleInTransaction(tx, value, value.parentRequestId);
          return { child: value, changed: !folded };
        });
        if (finished.changed) await this.host.emit({ type: 'event', requestId: child.parentRequestId, event: { type: 'subagent_end', toolCallId: child.toolCallId, agentId: child.id, requestId: child.requestId, name: child.name, status: finished.child.status, ...(child.background ? { background: true } : {}), ...(finished.child.error ? { error: finished.child.error } : {}) } });
        return finished.child;
      }
      await sleep(25, signal);
    }
  }
  answer(child: DelegatedChild) { return { agentId: child.id, requestId: child.requestId, name: child.name, status: child.status, ...(child.outcome?.result?.reply ? { text: child.outcome.result.reply } : {}), ...(child.outcome?.result?.output !== undefined ? { output: child.outcome.result.output } : {}), ...(child.outcome?.result?.stopped ? { stopped: child.outcome.result.stopped } : {}), ...(child.error ? { error: child.error } : {}) }; }
  async cancel(requestId?: string, callPrefix?: string) {
    const children = await this.host.storage.transaction(async tx => {
      const children = [...(await tx.list<DelegatedChild>({ prefix })).values()].filter(child => child.status === 'running' && (!requestId || child.parentRequestId === requestId) && (!callPrefix || child.toolCallId.startsWith(callPrefix)));
      for (const child of children) await tx.put(prefix + child.key, { ...child, cancelRequested: true });
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
  /** Accept only a report for the exact child run this parent started. */
  async recordProgress(report: ChildProgressReport) {
    if (typeof report.text !== 'string' || !report.text.trim() || report.text.length > MULTI_AGENT_LIMITS.progressChars) throw new HttpError(400, 'Invalid progress report');
    const recorded = await this.host.storage.transaction(async tx => {
      const child = [...(await tx.list<DelegatedChild>({ prefix })).values()].find(child => child.id === report.agentId && child.requestId === report.requestId);
      if (!child) throw new HttpError(404, 'Unknown sub-agent run');
      const calls = child.progressCalls ?? [];
      if (child.status !== 'running' || calls.includes(report.callId)) return;
      if (calls.length >= MULTI_AGENT_LIMITS.progressPerRun) throw new HttpError(400, 'Progress limit reached');
      const progress = { text: report.text.trim(), at: Date.now(), sequence: calls.length + 1 };
      await tx.put(prefix + child.key, { ...child, progress, progressCalls: [...calls, report.callId] });
      return { child, progress };
    });
    if (recorded) {
      const { child, progress } = recorded;
      await this.host.emit({ type: 'event', requestId: child.parentRequestId, event: { type: 'subagent_progress', toolCallId: child.toolCallId, agentId: child.id, requestId: child.requestId, name: child.name, text: progress.text, at: progress.at, ...(child.background ? { background: true } : {}) } });
      if (!child.background) await this.host.emit({ type: 'event', requestId: child.parentRequestId, event: { type: 'tool_execution_update', toolCallId: child.toolCallId, toolName: 'delegate', partialResult: { content: [{ type: 'text', text: progress.text }], details: { type: 'progress', tool: 'delegate', message: progress.text } } } });
    }
    return { reported: true };
  }
  private async takeProgress(api?: ToolExecutionApi) {
    const site = api ? await toolCallSite(api) : undefined;
    const entry = site?.assistant !== undefined ? await api!.commit(tx => tx.entry(site.assistant as never), BACKGROUND_CONTEXT) : undefined;
    return this.host.storage.transaction(async tx => {
      const reports = [];
      for (const child of (await tx.list<DelegatedChild>({ prefix })).values()) if (child.status === 'running' && child.progress && child.progress.sequence > (child.progressShown ?? 0) && !waitsForProgress(entry?.model ?? [], child)) {
        reports.push({ name: child.name, text: child.progress.text, at: child.progress.at });
        await tx.put(prefix + child.key, { ...child, progressShown: child.progress.sequence });
      }
      return reports;
    });
  }
  private async toolResult(value: unknown, api?: ToolExecutionApi) {
    const reports = await this.takeProgress(api);
    return { output: [{ type: 'text' as const, text: JSON.stringify(value) }, ...(reports.length ? [agentUpdates(reports)] : [])] };
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
      const response = await this.host.sendMessage(lineage.parent, { id: requestId, method: 'prompt', params: { text: args.text, allowDisconnected: true, whileRunning: 'followUp' } }, message.notice) as { steer?: string; steeredInto?: string } | undefined;
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
      await sleep(100, signal);
    }
    const key = `message-${identity.slice(0, 48)}`, existing = await this.host.storage.get<DelegatedChild>(prefix + key);
    const answer = (value: DelegatedChild) => ({ sent: true, to: child.name, agentId: child.id, into: value.folded ? 'its running turn' : 'a new turn: its answer comes as a notification' });
    if (existing?.accepted) { this.follow(existing); return answer(existing); }
    const next: DelegatedChild = existing ?? { ...child, key, requestId, parentRequestId: run.id, toolCallId: callId, task: args.text, background: true, createdAt: Date.now(), endedAt: undefined, status: 'running', held: undefined, spent: undefined, charged: undefined, outcome: undefined, error: undefined, notified: undefined, landedBy: undefined, accepted: false, cancelRequested: undefined, folded: undefined, progress: undefined, progressCalls: undefined, progressShown: undefined };
    await this.host.storage.put(prefix + key, next);
    const chain = child.chain ?? [...lineage?.chain ?? [], id], maxDepth = child.maxDepth ?? config.delegate?.maxDepth ?? MULTI_AGENT_LIMITS.maxDepth;
    const metadata = { [PARENT_KEYS.agent]: id, [PARENT_KEYS.run]: run.id, [PARENT_KEYS.toolCall]: callId, [PARENT_KEYS.depth]: String(child.depth), [PARENT_KEYS.maxDepth]: String(maxDepth), [PARENT_KEYS.chain]: chain.join(','), [PARENT_KEYS.signature]: await signature(this.host.secret, child.id, requestId, String(child.depth), String(maxDepth), chain.join(',')) };
    const message = agentMessage({ agentId: id, name: 'parent', root: child.root ?? lineage?.root ?? id }, args.text, 'child');
    await this.host.sendMessage(child.id, { id: requestId, method: 'prompt', params: { text: args.text, allowDisconnected: true, whileRunning: 'followUp', metadata } }, message.notice);
    const response = await this.host.fetch(child.id, new Request(`https://agent/requests/${requestId}`));
    const record = response.ok ? await response.json() as { steer?: string; steeredInto?: string } : undefined;
    if (record?.steer === 'accepted' || record?.steeredInto) {
      // Keep waits on the original child while Pi places the message. The final
      // receipt decides whether it joined that turn or began another one.
      next.folded = true;
    }
    next.accepted = true;
    await this.host.storage.put(prefix + key, next);
    this.follow(next);
    return answer(next);
  }
  private async progress(args: Record<string, unknown>, callId: string, api?: ToolExecutionApi) {
    if (!this.host.reportProgress) throw new HttpError(400, 'Progress reports are unavailable');
    if (typeof args.text !== 'string' || !args.text.trim() || args.text.length > MULTI_AGENT_LIMITS.progressChars) throw new HttpError(400, 'Invalid progress report');
    const { id, run } = await this.host.context(api), lineage = await this.lineage(id, run);
    if (!lineage?.parent) throw new HttpError(400, 'This run has no parent');
    await this.countCall('progress reports', run.id, callId, MULTI_AGENT_LIMITS.progressPerRun);
    await this.host.reportProgress(lineage.parent, { agentId: id, requestId: run.id, text: args.text.trim(), callId });
    return { reported: true };
  }
  async recover() {
    for (const child of await this.children()) {
      if (child.background && child.status === 'input_required') await this.resumePaused(child);
      if (child.cancelRequested && child.status === 'running') {
        await this.cancelRemote(child);
        if (!child.accepted) {
          if (child.id) this.follow(await this.update(child, { accepted: true }));
          else await this.update(child, { status: 'aborted', endedAt: Date.now(), held: undefined });
          continue;
        }
      }
      if (child.accepted) this.follow(child);
    }
  }
  private async resumePaused(child: DelegatedChild) {
    if (child.cancelRequested) return;
    const key = `${child.key}:resume`;
    if (await this.host.storage.get(prefix + key)) return;
    const requestId = `resume_${(await digest(child.requestId)).slice(0, 40)}`;
    const response = await this.host.fetch(child.id, new Request(`https://agent/requests/${requestId}`));
    if (response.status === 404) {
      if (Date.now() - child.createdAt < MULTI_AGENT_LIMITS.childTtlSeconds * 1000) await this.host.retry?.(MULTI_AGENT_LIMITS.sweepMs);
      return;
    }
    if (!response.ok) return;
    const resumed: DelegatedChild = { ...child, key, requestId, createdAt: Date.now(), status: 'running', endedAt: undefined, outcome: undefined, error: undefined, spent: undefined, held: undefined, charged: undefined, notified: undefined, landedBy: undefined, progress: undefined, progressCalls: undefined, progressShown: undefined };
    await this.host.storage.put(prefix + key, resumed);
    this.follow(resumed);
  }
  async targetDescriptions(settings: DelegateSettings) {
    const descriptions = new Map<string, string>();
    await Promise.all((settings.agents ?? []).filter(target => target.definition && !target.description).map(async target => {
      const resolved = await this.host.target(target).catch(() => undefined);
      if (resolved?.description) descriptions.set(target.definition!, resolved.description);
    }));
    return (target: NonNullable<DelegateSettings['agents']>[number]) => target.definition ? descriptions.get(target.definition) : undefined;
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
    return definitions.map(definition => defineTool({ name: definition.name, description: definition.description, parameters: definition.parameters as never, replay: 'safe', execute: async (args: Record<string, unknown>, api, context) => {
      const signal = context.abortSignal ?? new AbortController().signal;
      if (definition.name === 'delegate') {
        const child = await this.wait(await this.start(args, api.callId, signal, false, api), signal);
        return { ...await this.toolResult(this.answer(child), api), ...(child.status === 'completed' ? {} : { isError: true }) };
      }
      if (definition.name === 'spawn_agent') {
        const work = this.start(args, api.callId, signal, true, api);
        this.starting.add(work);
        try { return this.toolResult(this.answer(await work), api); }
        finally { this.starting.delete(work); }
      }
      if (['wait_agent', 'list_agents', 'send_message', 'interrupt_agent'].includes(definition.name))
        await Promise.allSettled([...this.starting]);
      if (definition.name === 'send_message') return this.toolResult(await this.send(args, api.callId, api, signal), api);
      if (definition.name === 'report_progress') return this.toolResult(await this.progress(args, api.callId, api), api);
      const children = await this.children();
      if (definition.name === 'list_agents') return this.toolResult({ agents: [...new Map(children.filter(child => child.background && !child.folded).map(child => [child.id, child])).values()].map(child => ({ agentId: child.id, name: child.name, status: child.status, startedAt: child.createdAt, ...(child.endedAt ? { endedAt: child.endedAt } : {}), ...(child.progress ? { progress: escapeMarkers(child.progress.text), progressAt: child.progress.at } : {}) })) }, api);
      if (definition.name === 'wait_agent') {
        if (args.agents !== undefined && (!Array.isArray(args.agents) || args.agents.some(name => typeof name !== 'string'))) throw new HttpError(400, 'agents is a list of names or agentIds');
        if (args.timeoutMs !== undefined && (!Number.isInteger(args.timeoutMs) || Number(args.timeoutMs) < 1000 || Number(args.timeoutMs) > MULTI_AGENT_LIMITS.maxWaitMs)) throw new HttpError(400, `timeoutMs is an integer from 1000 to ${MULTI_AGENT_LIMITS.maxWaitMs}`);
        const background = [...new Map(children.filter(child => child.background && !child.folded).map(child => [child.id, child])).values()];
        const selected = background.filter(child => Array.isArray(args.agents) ? args.agents.includes(child.id) || args.agents.includes(child.name) : !child.landedBy);
        if (Array.isArray(args.agents)) for (const name of args.agents) if (!selected.some(child => child.id === name || child.name === name)) throw new HttpError(400, `You have no sub-agent ${name}`);
        if (!selected.length) return this.toolResult({ agents: [] }, api);
        if (args.untilProgress !== undefined && typeof args.untilProgress !== 'boolean') throw new HttpError(400, 'untilProgress is true or false');
        const stop = new AbortController(), wait = AbortSignal.any([signal, stop.signal]);
        const deadline = Date.now() + Number(args.timeoutMs ?? MULTI_AGENT_LIMITS.waitMs), earliestProgress = Date.now() + MULTI_AGENT_LIMITS.progressWaitMs;
        const watches = selected.filter(child => child.status === 'running').map(child => this.wait(child, wait).catch(() => {}));
        const messaged = new Set<string>(), updated = new Set<string>();
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
            await sleep(Math.min(25, Math.max(1, deadline - Date.now())), signal);
          }
        } finally { stop.abort(); await Promise.all(watches); }
        const { run } = await this.host.context(api);
        const answers = await this.host.storage.transaction(async tx => {
          const answers: (ReturnType<Delegation['answer']> | { agentId: string; name: string; status: string; note: string })[] = [];
          for (const old of selected) {
            const child = await tx.get<DelegatedChild>(prefix + old.key) ?? old;
            if (child.status !== 'running' && child.landedBy) answers.push({ agentId: child.id, name: child.name, status: child.status, note: 'Its answer comes (or came) as a notification' });
            else {
              answers.push({ ...this.answer(child), ...(child.status === 'running' && child.progress ? { progress: child.progress.text, progressAt: child.progress.at } : {}) });
              if (child.status !== 'running') await this.settleInTransaction(tx, { ...child, notified: true, landedBy: 'wait' }, run.id);
              else if (child.progress) await tx.put(prefix + child.key, { ...child, progressShown: child.progress.sequence });
            }
          }
          return answers;
        });
        return this.toolResult({ agents: answers, ...(messaged.size ? { messaged: [...messaged], message: `${[...messaged].join(', ')} sent you a message, which follows this result: read it, then wait again if you need to` } : {}), ...(updated.size ? { updated: [...updated] } : {}), ...(!messaged.size && !updated.size && answers.every(child => child.status === 'running') ? { timedOut: true } : {}) }, api);
      }
      const child = children.find(child => child.id === args.agent || child.name === args.agent || child.id === args.to || child.name === args.to);
      if (!child) throw new HttpError(404, 'Unknown sub-agent');
      if (definition.name === 'interrupt_agent') { await this.host.fetch(child.id, new Request('https://agent/requests', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: `interrupt-${api.callId}`, method: 'abort', params: {} }) })); return this.toolResult({ agentId: child.id, interrupted: true }, api); }
      throw new HttpError(400, 'Unknown delegation tool');
    } }));
  }
}
