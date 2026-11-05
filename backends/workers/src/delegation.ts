import { defineTool, type ToolRegistration } from '@earendil-works/pi-durable';
import { HttpError } from './errors.ts';
import { digest } from './api-contract.ts';
import { MULTI_AGENT_LIMITS, PARENT_KEYS, SUBAGENT_PROMPT, roleAndTask, delegateTool, agentsTools, type DelegateSettings } from './multi-agent-policy.ts';
import type { ToolDefinition } from './policy-host.ts';

type Configuration = { model?: string | object; systemPrompt?: string; delegate?: DelegateSettings; builtins?: string[]; spendLimit?: { usd: number }; [key: string]: unknown };
export type ParentRun = { id: string; params?: { spendLimit?: { usd: number } }; metadata?: Record<string, string> };
export type ChildRun = { state: string; status?: string; error?: string; outcome?: { result?: { reply?: string; output?: unknown; usage?: { costUsd?: number; subagentCostUsd?: number } }; error?: string } };
export type DelegatedChild = { id: string; key: string; requestId: string; parentRequestId: string; toolCallId: string; task: string; name: string; depth: number; createdAt: number; endedAt?: number; status: string; made: boolean; held?: number; spent?: number; outcome?: ChildRun['outcome']; error?: string; notified?: boolean; accepted?: boolean };
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
}
const prefix = 'delegation:';
const result = (value: unknown) => ({ output: [{ type: 'text' as const, text: JSON.stringify(value) }] });
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
  async children() { return [...(await this.host.storage.list<DelegatedChild>({ prefix })).values()]; }
  async cost(requestId: string) { return (await this.children()).filter(child => child.parentRequestId === requestId).reduce((sum, child) => sum + (child.spent ?? 0), 0); }
  private async place(id: string, run: ParentRun, settings: DelegateSettings) {
    const metadata = run.metadata ?? {}, depth = metadata[PARENT_KEYS.depth], max = metadata[PARENT_KEYS.maxDepth], chain = metadata[PARENT_KEYS.chain] ?? '';
    const valid = depth !== undefined && max !== undefined && metadata[PARENT_KEYS.signature] === await signature(this.host.secret, id, run.id, depth, max, chain);
    const parentDepth = valid ? Number(depth) : 0;
    const maxDepth = Math.min(valid ? Number(max) : MULTI_AGENT_LIMITS.depthCeiling, settings.maxDepth ?? MULTI_AGENT_LIMITS.maxDepth);
    if (parentDepth + 1 > maxDepth) throw new HttpError(400, `Delegation has reached its depth limit of ${maxDepth}: do this task yourself`, 'DELEGATION_DEPTH');
    return { depth: parentDepth + 1, maxDepth, chain: [...(valid ? chain.split(',').filter(Boolean) : []), id] };
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
    const identity = await digest(`${run.id}:${callId}`), key = `delegate-${identity.slice(0, 48)}`;
    const stored = await this.host.storage.get<DelegatedChild>(prefix + key);
    if (stored?.accepted || (stored && stored.status !== 'running')) { this.follow(stored, background); return stored; }
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
        if (running.length >= maxParallel) return false;
        const budget = finiteBudget(run.params?.spendLimit?.usd) ?? finiteBudget(config.spendLimit?.usd);
        if (budget !== undefined) {
          const remaining = budget - children.reduce((sum, child) => sum + (child.spent ?? child.held ?? 0), 0);
          if (remaining <= 0) throw new HttpError(402, 'This run has no budget left for a sub-agent', 'SPEND_LIMIT');
          held = remaining / (maxParallel - running.length);
        }
        const child: DelegatedChild = { id: '', key, requestId: `delegate_${identity.slice(0, 48)}`, parentRequestId: run.id, toolCallId: callId, task: args.instructions === undefined ? args.task as string : roleAndTask(args.instructions as string, args.task as string), name: typeof args.name === 'string' ? args.name : target?.name ?? 'subagent', depth: place.depth, createdAt: Date.now(), status: 'running', made: target?.agent === undefined, ...(held !== undefined ? { held } : {}) };
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
          this.follow(admitted, background, relay);
          return admitted;
        } catch (error) {
          admitted.status = signal.aborted ? 'aborted' : 'failed'; admitted.error = error instanceof Error ? error.message : 'Child failed'; admitted.endedAt = Date.now(); admitted.held = undefined;
          await this.host.storage.put(prefix + key, admitted);
          throw error;
        }
      }
      await sleep(25, signal);
    }
  }
  private async relay(child: DelegatedChild) {
    const abort = new AbortController();
    const response = await this.host.fetch(child.id, new Request('https://agent/events', { signal: abort.signal }));
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
          }
        }
      } finally { await reader.cancel().catch(() => {}); }
    };
    this.host.waitUntil(read().catch(() => {}));
    return abort;
  }
  private follow(child: DelegatedChild, background: boolean, relay?: AbortController) {
    if (this.following.has(child.key) || child.status !== 'running') return;
    this.following.add(child.key);
    this.host.waitUntil(this.wait(child).then(async finished => { if (background && this.host.notify && !finished.notified) { await this.host.notify(finished); finished.notified = true; await this.host.storage.put(prefix + child.key, finished); } }).finally(() => { relay?.abort(); this.following.delete(child.key); }));
  }
  async wait(child: DelegatedChild, signal?: AbortSignal): Promise<DelegatedChild> {
    for (;;) {
      signal?.throwIfAborted();
      const saved = await this.host.storage.get<DelegatedChild>(prefix + child.key);
      if (saved?.status !== 'running') return saved ?? child;
      const response = await this.host.fetch(child.id, new Request(`https://agent/requests/${child.requestId}?wait=1`, { signal }));
      if (!response.ok) throw new HttpError(response.status, 'Child agent unavailable');
      const record = await response.json() as ChildRun;
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
  recover() { return this.children().then(children => { for (const child of children) if (child.accepted) this.follow(child, true); }); }
  tools(settings: DelegateSettings, builtins: readonly string[]): ToolRegistration[] {
    const definitions: ToolDefinition[] = [...(builtins.includes('delegate') ? [delegateTool(settings, () => undefined)] : []), ...(builtins.includes('agents') ? agentsTools(settings, () => undefined) : [])];
    return definitions.map(definition => defineTool({ name: definition.name, description: definition.description, parameters: definition.parameters as never, replay: 'safe', execute: async (args: Record<string, unknown>, api, context) => {
      const signal = context.abortSignal ?? new AbortController().signal;
      if (definition.name === 'delegate') return result(this.answer(await this.wait(await this.start(args, api.callId, signal), signal)));
      if (definition.name === 'spawn_agent') return result(this.answer(await this.start(args, api.callId, signal, true)));
      const children = await this.children();
      if (definition.name === 'list_agents') return result(children.map(child => this.answer(child)));
      if (definition.name === 'wait_agent') {
        const selected = children.filter(child => !Array.isArray(args.agents) || args.agents.includes(child.id) || args.agents.includes(child.name));
        if (!selected.length) return result({ agents: [] });
        const wait = AbortSignal.any([signal, AbortSignal.timeout(Math.min(Number(args.timeoutMs ?? MULTI_AGENT_LIMITS.waitMs), MULTI_AGENT_LIMITS.maxWaitMs))]);
        const running = selected.filter(child => child.status === 'running');
        if (running.length) await Promise.race(running.map(child => this.wait(child, wait))).catch(error => { if (signal.aborted) throw error; });
        return result({ agents: (await this.children()).filter(child => selected.some(item => item.key === child.key)).map(child => this.answer(child)) });
      }
      const child = children.find(child => child.id === args.agent || child.name === args.agent || child.id === args.to || child.name === args.to);
      if (!child) throw new HttpError(404, 'Unknown sub-agent');
      if (definition.name === 'interrupt_agent') { await this.host.fetch(child.id, new Request('https://agent/requests', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: `interrupt-${api.callId}`, method: 'abort', params: {} }) })); return result({ agentId: child.id, interrupted: true }); }
      if (definition.name === 'send_message') {
        if (typeof args.text !== 'string' || args.text.length > MULTI_AGENT_LIMITS.taskChars) throw new HttpError(400, 'Invalid message');
        await this.host.fetch(child.id, new Request('https://agent/requests', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: `message-${api.callId}`, method: 'prompt', params: { text: args.text } }) }));
        return result({ agentId: child.id, sent: true });
      }
      throw new HttpError(400, 'Unknown delegation tool');
    } }));
  }
}
