import { defineTool, type ToolRegistration } from '@earendil-works/pi-durable';
import { HttpError } from './errors.ts';
import { digest } from './api-contract.ts';
import { MULTI_AGENT_LIMITS, PARENT_KEYS, SUBAGENT_PROMPT, roleAndTask, delegateTool, agentsTools, agentMessage, agentUpdates, REPORT_PROGRESS, SEND_MESSAGE, type DelegateSettings } from './multi-agent-policy.ts';
import type { ToolDefinition } from './policy-host.ts';
import type { NoticeRequest, RuntimeNotice } from './delegation-notifications.ts';

type Configuration = { model?: string | object; systemPrompt?: string; delegate?: DelegateSettings; builtins?: string[]; spendLimit?: { usd: number }; [key: string]: unknown };
export type ParentRun = { id: string; params?: { spendLimit?: { usd: number } }; metadata?: Record<string, string> };
export type ChildRun = { state: string; status?: string; error?: string; outcome?: { result?: { reply?: string; output?: unknown; usage?: { costUsd?: number; subagentCostUsd?: number } }; error?: string } };
export type ChildProgressReport = { agentId: string; requestId: string; text: string; callId: string };
export type DelegatedChild = { id: string; key: string; requestId: string; parentRequestId: string; toolCallId: string; task: string; name: string; depth: number; maxDepth?: number; chain?: string[]; root?: string; background?: boolean; createdAt: number; endedAt?: number; status: string; made: boolean; held?: number; spent?: number; outcome?: ChildRun['outcome']; error?: string; notified?: boolean; landedBy?: 'wait' | 'notice'; accepted?: boolean; progress?: { text: string; at: number; sequence: number }; progressShown?: number; progressCalls?: string[] };
export interface DelegationHost {
  storage: DurableObjectStorage;
  secret: string;
  context(): Promise<{ id: string; config: Configuration; run: ParentRun }>;
  create(config: Configuration, key: string): Promise<{ id: string }>;
  target(ref: { agent?: string; definition?: string }): Promise<{ id?: string; config: Configuration }>;
  fetch(id: string, request: Request): Promise<Response>;
  emit(event: unknown): Promise<void>;
  waitUntil(promise: Promise<unknown>): void;
  /** Journal a runtime-authored child notification so recovery cannot lose it. */
  notify?(child: DelegatedChild): Promise<void>;
  retry?(): Promise<void>;
  sendMessage?(targetId: string, request: NoticeRequest, notice: RuntimeNotice): Promise<unknown>;
  reportProgress?(parentId: string, report: ChildProgressReport): Promise<unknown>;
}
type ChildRelay = { abort(): void; drained: Promise<void> };
const prefix = 'delegation:';
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
  private readonly host: DelegationHost;
  constructor(host: DelegationHost) { this.host = host; }
  async children() { return [...(await this.host.storage.list<DelegatedChild>({ prefix })).values()].sort((a, b) => a.createdAt - b.createdAt || a.key.localeCompare(b.key)); }
  async cost(requestId: string) { return (await this.children()).filter(child => child.parentRequestId === requestId).reduce((sum, child) => sum + (child.spent ?? 0), 0); }
  private async lineage(id: string, run: ParentRun) {
    const metadata = run.metadata ?? {}, depth = metadata[PARENT_KEYS.depth], max = metadata[PARENT_KEYS.maxDepth], chain = metadata[PARENT_KEYS.chain] ?? '';
    if (depth === undefined || max === undefined || metadata[PARENT_KEYS.signature] !== await signature(this.host.secret, id, run.id, depth, max, chain)) return;
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
  async start(args: Record<string, unknown>, callId: string, signal: AbortSignal, background = false): Promise<DelegatedChild> {
    const context = await this.host.context(), { id, config, run } = context;
    const settings = config.delegate;
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
    if (stored?.accepted || (stored && stored.status !== 'running')) { this.follow(stored); return stored; }
    // Creation and submit use deterministic keys; replay an interrupted acceptance safely.
    if (stored) await this.host.storage.delete(prefix + key);
    const place = await this.place(id, run, settings);
    const maxParallel = settings.maxParallel ?? MULTI_AGENT_LIMITS.maxParallel;
    let held: number | undefined;
    // Slot and budget reservation are one SQLite transaction. No model call can race them.
    for (;;) {
      signal.throwIfAborted();
      const admitted = await this.host.storage.transaction(async tx => {
        const children = [...(await tx.list<DelegatedChild>({ prefix })).values()].filter(child => child.parentRequestId === run.id);
        const running = children.filter(child => child.status === 'running');
        if (running.length >= maxParallel) {
          if (background) throw new HttpError(400, `${running.length} sub-agents are running, this agent's most at once: wait for one to finish (wait_agent) before starting another`);
          return false;
        }
        if (args.name && running.some(child => child.name === args.name)) throw new HttpError(400, 'A sub-agent with this name is already running');
        const budget = finiteBudget(run.params?.spendLimit?.usd) ?? finiteBudget(config.spendLimit?.usd);
        if (budget !== undefined) {
          const remaining = budget - children.reduce((sum, child) => sum + (child.spent ?? child.held ?? 0), 0);
          if (remaining <= 0) throw new HttpError(402, 'This run has no budget left for a sub-agent', 'SPEND_LIMIT');
          held = remaining / (maxParallel - running.length);
        }
        const child: DelegatedChild = { id: '', key, requestId: `delegate_${identity.slice(0, 48)}`, parentRequestId: run.id, toolCallId: callId, task: args.instructions === undefined ? args.task as string : roleAndTask(args.instructions as string, args.task as string), name: typeof args.name === 'string' ? args.name : `${target?.name ?? 'subagent'}-${children.length + 1}`, depth: place.depth, maxDepth: place.maxDepth, chain: place.chain, root: place.chain[0], background, createdAt: Date.now(), status: 'running', made: target?.agent === undefined, ...(held !== undefined ? { held } : {}) };
        await tx.put(prefix + key, child);
        return child;
      });
      if (admitted) {
        try {
          const resolved = target ? await this.host.target(target) : undefined;
          if (resolved?.id && place.chain.includes(resolved.id)) throw new HttpError(400, 'This agent is already working on the delegation chain');
          const made = resolved?.id ? resolved : await this.host.create({ ...(resolved?.config ?? config), ...(target ? {} : { systemPrompt: SUBAGENT_PROMPT }), name: admitted.name, type: 'subagent', ttlSeconds: MULTI_AGENT_LIMITS.childTtlSeconds }, key);
          admitted.id = made.id!;
          await this.host.storage.put(prefix + key, admitted);
          signal.throwIfAborted();
          const metadata = { [PARENT_KEYS.agent]: id, [PARENT_KEYS.run]: run.id, [PARENT_KEYS.toolCall]: callId, [PARENT_KEYS.depth]: String(place.depth), [PARENT_KEYS.maxDepth]: String(place.maxDepth), [PARENT_KEYS.chain]: place.chain.join(',') };
          const signed = { ...metadata, [PARENT_KEYS.signature]: await signature(this.host.secret, admitted.id, admitted.requestId, String(place.depth), String(place.maxDepth), place.chain.join(',')) };
          await this.host.emit({ type: 'event', requestId: run.id, event: { type: 'subagent_start', toolCallId: callId, agentId: admitted.id, requestId: admitted.requestId, name: admitted.name, depth: admitted.depth } });
          const relay = await this.relay(admitted);
          const response = await this.host.fetch(admitted.id, new Request('https://agent/requests', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: admitted.requestId, method: 'prompt', params: { text: admitted.task, metadata: signed, ...(held !== undefined ? { spendLimit: { usd: held } } : {}), ...(args.output !== undefined ? { output: args.output } : {}) } }) }));
          if (!response.ok) { relay.abort(); throw new HttpError(response.status, 'Child submission failed'); }
          admitted.accepted = true;
          await this.host.storage.put(prefix + key, admitted);
          this.follow(admitted, relay);
          return admitted;
        } catch (error) {
          admitted.status = signal.aborted ? 'aborted' : 'failed'; admitted.error = error instanceof Error ? error.message : 'Child failed'; admitted.endedAt = Date.now(); admitted.held = undefined;
          await this.host.storage.put(prefix + key, admitted);
          await this.host.emit({ type: 'event', requestId: run.id, event: { type: 'subagent_end', toolCallId: callId, agentId: admitted.id, requestId: admitted.requestId, status: admitted.status, error: admitted.error } });
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
    const response = await this.host.fetch(child.id, new Request('https://agent/events?watch=1', { signal: abort.signal }));
    const read = async () => {
      const reader = response.body?.getReader(); if (!reader) return;
      let buffer = ''; const decoder = new TextDecoder();
      try {
        while (!abort.signal.aborted) {
          const chunk = await reader.read(); if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          let end: number;
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
            const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
            if (!data) continue;
            const event = JSON.parse(data);
            if (event.type === 'event' && event.requestId === child.requestId) await this.host.emit({ type: 'event', requestId: child.parentRequestId, event: { type: 'subagent_event', toolCallId: child.toolCallId, agentId: child.id, requestId: child.requestId, event: event.event } });
            if (event.type === 'response' && event.id === child.requestId) drain();
          }
        }
      } finally { drain(); await reader.cancel().catch(() => {}); }
    };
    this.host.waitUntil(read().catch(() => {}));
    return { abort: () => abort.abort(), drained };
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
          const value = { ...current, status: record.status ?? (record.outcome?.error ? 'failed' : 'completed'), endedAt: Date.now(), outcome: record.outcome, error: record.error ?? record.outcome?.error, spent: (usage?.costUsd ?? 0) + (usage?.subagentCostUsd ?? 0), held: undefined };
          await tx.put(prefix + child.key, value);
          return { child: value, changed: true };
        });
        if (finished.changed) await this.host.emit({ type: 'event', requestId: child.parentRequestId, event: { type: 'subagent_end', toolCallId: child.toolCallId, agentId: child.id, requestId: child.requestId, status: finished.child.status, ...(finished.child.error ? { error: finished.child.error } : {}) } });
        return finished.child;
      }
      await sleep(25, signal);
    }
  }
  answer(child: DelegatedChild) { return { agentId: child.id, requestId: child.requestId, status: child.status, ...(child.outcome?.result?.reply ? { text: child.outcome.result.reply } : {}), ...(child.outcome?.result?.output !== undefined ? { output: child.outcome.result.output } : {}), ...(child.error ? { error: child.error } : {}) }; }
  async cancel(requestId?: string) {
    const children = (await this.children()).filter(child => child.id && child.status === 'running' && (!requestId || child.parentRequestId === requestId));
    await Promise.all(children.map(async child => {
      if (!child.made) {
        const response = await this.host.fetch(child.id, new Request(`https://agent/requests/${child.requestId}`));
        if (!response.ok) return;
        const record = await response.json() as ChildRun & { began?: number };
        if (record.state !== 'running' || !record.began) return;
      }
      await this.host.fetch(child.id, new Request('https://agent/requests', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: `abort-${child.requestId}`, method: 'abort', params: {} }) }));
    }));
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
  private async takeProgress() {
    return this.host.storage.transaction(async tx => {
      const reports = [];
      for (const child of (await tx.list<DelegatedChild>({ prefix })).values()) if (child.status === 'running' && child.progress && child.progress.sequence > (child.progressShown ?? 0)) {
        reports.push({ name: child.name, text: child.progress.text, at: child.progress.at });
        await tx.put(prefix + child.key, { ...child, progressShown: child.progress.sequence });
      }
      return reports;
    });
  }
  private async toolResult(value: unknown) {
    const reports = await this.takeProgress();
    return { output: [{ type: 'text' as const, text: JSON.stringify(value) }, ...(reports.length ? [agentUpdates(reports)] : [])] };
  }
  private async send(args: Record<string, unknown>, callId: string) {
    if (!this.host.sendMessage) throw new HttpError(400, 'Agent messages are unavailable');
    if (typeof args.text !== 'string' || !args.text.trim() || args.text.length > MULTI_AGENT_LIMITS.taskChars || typeof args.to !== 'string') throw new HttpError(400, 'Invalid message');
    const { id, config, run } = await this.host.context(), lineage = await this.lineage(id, run);
    await this.countCall('messages', run.id, callId, MULTI_AGENT_LIMITS.messagesPerRun);
    const identity = await digest(`${id}:${run.id}:${callId}`), requestId = `message_${identity.slice(0, 48)}`;
    if (args.to === 'parent') {
      if (!lineage?.parent) throw new HttpError(400, 'This run has no parent');
      const message = agentMessage({ agentId: id, name: typeof config.name === 'string' ? config.name : 'subagent', root: lineage.root }, args.text, 'parent');
      await this.host.sendMessage(lineage.parent, { id: requestId, method: 'prompt', params: { text: args.text, allowDisconnected: true, whileRunning: 'followUp' } }, message.notice);
      return { agentId: lineage.parent, sent: true };
    }
    const children = await this.children();
    const child = [...children].reverse().find(child => child.id === args.to || child.name === args.to);
    if (!child) throw new HttpError(404, 'Unknown sub-agent');
    const key = `message-${identity.slice(0, 48)}`, existing = await this.host.storage.get<DelegatedChild>(prefix + key);
    if (existing?.accepted) { this.follow(existing); return { agentId: child.id, sent: true }; }
    const next: DelegatedChild = existing ?? { ...child, key, requestId, parentRequestId: run.id, toolCallId: callId, task: args.text, background: true, createdAt: Date.now(), endedAt: undefined, status: 'running', held: undefined, spent: undefined, outcome: undefined, error: undefined, notified: undefined, landedBy: undefined, accepted: false, progress: undefined, progressCalls: undefined, progressShown: undefined };
    await this.host.storage.put(prefix + key, next);
    const chain = child.chain ?? [...lineage?.chain ?? [], id], maxDepth = child.maxDepth ?? config.delegate?.maxDepth ?? MULTI_AGENT_LIMITS.maxDepth;
    const metadata = { [PARENT_KEYS.agent]: id, [PARENT_KEYS.run]: run.id, [PARENT_KEYS.toolCall]: callId, [PARENT_KEYS.depth]: String(child.depth), [PARENT_KEYS.maxDepth]: String(maxDepth), [PARENT_KEYS.chain]: chain.join(','), [PARENT_KEYS.signature]: await signature(this.host.secret, child.id, requestId, String(child.depth), String(maxDepth), chain.join(',')) };
    const message = agentMessage({ agentId: id, name: typeof config.name === 'string' ? config.name : 'parent', root: child.root ?? lineage?.root ?? id }, args.text, 'child');
    await this.host.sendMessage(child.id, { id: requestId, method: 'prompt', params: { text: args.text, allowDisconnected: true, whileRunning: 'followUp', metadata } }, message.notice);
    next.accepted = true;
    await this.host.storage.put(prefix + key, next);
    this.follow(next);
    return { agentId: child.id, sent: true };
  }
  private async progress(args: Record<string, unknown>, callId: string) {
    if (!this.host.reportProgress) throw new HttpError(400, 'Progress reports are unavailable');
    if (typeof args.text !== 'string' || !args.text.trim() || args.text.length > MULTI_AGENT_LIMITS.progressChars) throw new HttpError(400, 'Invalid progress report');
    const { id, run } = await this.host.context(), lineage = await this.lineage(id, run);
    if (!lineage?.parent) throw new HttpError(400, 'This run has no parent');
    await this.countCall('progress reports', run.id, callId, MULTI_AGENT_LIMITS.progressPerRun);
    await this.host.reportProgress(lineage.parent, { agentId: id, requestId: run.id, text: args.text.trim(), callId });
    return { reported: true };
  }
  recover() { return this.children().then(children => { for (const child of children) if (child.accepted) this.follow(child); }); }
  tools(settings: DelegateSettings, builtins: readonly string[], subagent = false): ToolRegistration[] {
    const definitions: ToolDefinition[] = [...(builtins.includes('delegate') ? [delegateTool(settings, () => undefined)] : []), ...(builtins.includes('agents') ? agentsTools(settings, () => undefined) : [])];
    if (subagent) definitions.push(REPORT_PROGRESS, ...(!definitions.some(tool => tool.name === 'send_message') ? [SEND_MESSAGE] : []));
    return definitions.map(definition => defineTool({ name: definition.name, description: definition.description, parameters: definition.parameters as never, replay: 'safe', execute: async (args: Record<string, unknown>, api, context) => {
      const signal = context.abortSignal ?? new AbortController().signal;
      if (definition.name === 'delegate') return this.toolResult(this.answer(await this.wait(await this.start(args, api.callId, signal), signal)));
      if (definition.name === 'spawn_agent') return this.toolResult(this.answer(await this.start(args, api.callId, signal, true)));
      if (definition.name === 'send_message') return this.toolResult(await this.send(args, api.callId));
      if (definition.name === 'report_progress') return this.toolResult(await this.progress(args, api.callId));
      const children = await this.children();
      if (definition.name === 'list_agents') return this.toolResult([...new Map(children.filter(child => child.background).map(child => [child.id, child])).values()].map(child => ({ agentId: child.id, name: child.name, status: child.status, startedAt: child.createdAt, ...(child.endedAt ? { endedAt: child.endedAt } : {}), ...(child.progress ? { progress: child.progress.text, progressAt: child.progress.at } : {}) })));
      if (definition.name === 'wait_agent') {
        if (args.agents !== undefined && (!Array.isArray(args.agents) || args.agents.some(name => typeof name !== 'string'))) throw new HttpError(400, 'agents is a list of names or agentIds');
        if (args.timeoutMs !== undefined && (!Number.isInteger(args.timeoutMs) || Number(args.timeoutMs) < 1000 || Number(args.timeoutMs) > MULTI_AGENT_LIMITS.maxWaitMs)) throw new HttpError(400, `timeoutMs is an integer from 1000 to ${MULTI_AGENT_LIMITS.maxWaitMs}`);
        const background = [...new Map(children.filter(child => child.background).map(child => [child.id, child])).values()];
        const selected = background.filter(child => Array.isArray(args.agents) ? args.agents.includes(child.id) || args.agents.includes(child.name) : !child.landedBy);
        if (Array.isArray(args.agents)) for (const name of args.agents) if (!selected.some(child => child.id === name || child.name === name)) throw new HttpError(400, `You have no sub-agent ${name}`);
        if (!selected.length) return this.toolResult({ agents: [] });
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
            for (const notice of (await this.host.storage.list<{ request: { id: string }; notice: RuntimeNotice }>({ prefix: 'delegation-notice:message_' })).values()) {
              const record = await this.host.storage.get<{ state: string }>(`request:${notice.request.id}`);
              if (record && record.state !== 'completed') messaged.add(notice.notice.source.name);
            }
            if (messaged.size) break;
            if (args.untilProgress && Date.now() >= earliestProgress) for (const child of latest) if (child.progress && child.progress.sequence > (child.progressShown ?? 0)) updated.add(child.name);
            if (updated.size) break;
            await sleep(Math.min(25, Math.max(1, deadline - Date.now())), signal);
          }
        } finally { stop.abort(); await Promise.all(watches); }
        const answers = await this.host.storage.transaction(async tx => {
          const answers: (ReturnType<Delegation['answer']> | { agentId: string; name: string; status: string; note: string })[] = [];
          for (const old of selected) {
            const child = await tx.get<DelegatedChild>(prefix + old.key) ?? old;
            if (child.status !== 'running' && child.landedBy) answers.push({ agentId: child.id, name: child.name, status: child.status, note: 'Its answer comes (or came) as a notification' });
            else {
              answers.push({ ...this.answer(child), ...(child.status === 'running' && child.progress ? { progress: child.progress.text, progressAt: child.progress.at } : {}) });
              if (child.status !== 'running') await tx.put(prefix + child.key, { ...child, notified: true, landedBy: 'wait' });
            }
          }
          return answers;
        });
        return this.toolResult({ agents: answers, ...(messaged.size ? { messaged: [...messaged] } : {}), ...(updated.size ? { updated: [...updated] } : {}), ...(!messaged.size && !updated.size && answers.every(child => child.status === 'running') ? { timedOut: true } : {}) });
      }
      const child = children.find(child => child.id === args.agent || child.name === args.agent || child.id === args.to || child.name === args.to);
      if (!child) throw new HttpError(404, 'Unknown sub-agent');
      if (definition.name === 'interrupt_agent') { await this.host.fetch(child.id, new Request('https://agent/requests', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: `interrupt-${api.callId}`, method: 'abort', params: {} }) })); return this.toolResult({ agentId: child.id, interrupted: true }); }
      throw new HttpError(400, 'Unknown delegation tool');
    } }));
  }
}
