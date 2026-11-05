import { childNotice, MULTI_AGENT_LIMITS } from './multi-agent-policy.ts';
import type { DelegatedChild } from './delegation.ts';
import type { MessageSource } from './sender.ts';

export type RuntimeNotice = { source: MessageSource; root: string; costUsd: number; metadata: Record<string, unknown> };
export type NoticeRequest = { id: string; method: 'prompt'; params: { text: string; allowDisconnected: true; whileRunning: 'followUp'; metadata?: Record<string, string> } };
export type WakeDecision = { allowed: boolean; hour: number };
export type NoticeDelivery = { run: true } | { run: false; stopped: 'agent_loop_limit'; message: string };
type PendingNotice = { request: NoticeRequest; notice: RuntimeNotice; childKey?: string; delivered?: true; wake?: WakeDecision };
const prefix = 'delegation-notice:';

/** The chain root owns this counter. Repeating an admitted request never takes another wake. */
export class DelegationWakeBudget {
  private storage: DurableObjectStorage;
  private limit: number;
  constructor(storage: DurableObjectStorage, limit: number = MULTI_AGENT_LIMITS.wakesPerHour) { this.storage = storage; this.limit = limit; }
  admit(requestId: string, now = Date.now()): Promise<WakeDecision> {
    const hour = Math.floor(now / 3_600_000);
    return this.storage.transaction(async tx => {
      const old = await tx.get<{ hour: number; requests: string[] }>('delegation-wakes');
      const requests = old?.hour === hour ? old.requests : [];
      if (requests.includes(requestId)) return { allowed: true, hour };
      if (requests.length >= this.limit) return { allowed: false, hour };
      await tx.put('delegation-wakes', { hour, requests: [...requests, requestId] });
      return { allowed: true, hour };
    });
  }
}

export interface NotificationHost {
  storage: DurableObjectStorage;
  /** This is an internal call. A public request cannot provide its own RuntimeNotice. */
  submit(request: NoticeRequest, notice: RuntimeNotice, delivery: NoticeDelivery): Promise<unknown>;
  admitWake(root: string, requestId: string): Promise<WakeDecision>;
  /** A human prompt must remain pending; a child finishing cannot supersede it. */
  humanPending?(): Promise<boolean>;
  /** Uses the agent's existing alarm, preserving any earlier work. */
  retry(at: number): Promise<void>;
}

/** Durable outbox plus idempotent admission covers eviction before or after the parent's submit. */
export class DelegationNotifications {
  private active = new Map<string, Promise<void>>();
  private host: NotificationHost;
  constructor(host: NotificationHost) { this.host = host; }
  async deliver(child: DelegatedChild): Promise<void> {
    const key = prefix + child.key;
    if (!await this.host.storage.get(key)) {
      const { text, notice } = childNotice({ agentId: child.id, name: child.name, root: child.root ?? child.id }, child);
      await this.host.storage.put(key, { request: { id: `child_${child.requestId}`, method: 'prompt', params: { text, allowDisconnected: true, whileRunning: 'followUp' } }, notice, childKey: child.key } satisfies PendingNotice);
    }
    return this.send(key);
  }
  async deliverMessage(request: NoticeRequest, notice: RuntimeNotice): Promise<void> {
    const key = prefix + request.id;
    if (!await this.host.storage.get(key)) await this.host.storage.put(key, { request, notice } satisfies PendingNotice);
    return this.send(key);
  }
  private send(key: string): Promise<void> {
    const previous = this.active.get(key);
    if (previous) return previous;
    const sending = this.sendPending(key).finally(() => { this.active.delete(key); });
    this.active.set(key, sending);
    return sending;
  }
  private async sendPending(key: string) {
    const pending = await this.host.storage.get<PendingNotice>(key);
    if (!pending || pending.delivered) return;
    try {
      if (await this.host.humanPending?.()) { await this.host.retry(Date.now() + MULTI_AGENT_LIMITS.sweepMs); return; }
      // Compete with wait_agent in the same transaction, before either can
      // expose the answer. A durable outbox owns a notice claim through retry.
      const claimed = await this.host.storage.transaction(async tx => {
        const child = pending.childKey ? await tx.get<DelegatedChild>(`delegation:${pending.childKey}`) : undefined;
        if (child?.landedBy === 'wait') { await tx.put(key, { ...pending, delivered: true }); return false; }
        if (child && !child.landedBy) await tx.put(`delegation:${pending.childKey}`, { ...child, landedBy: 'notice' });
        return true;
      });
      if (!claimed) return;
      if (!pending.wake) {
        pending.wake = await this.host.admitWake(pending.notice.root, pending.request.id);
        await this.host.storage.put(key, pending);
      }
      const delivery: NoticeDelivery = pending.wake.allowed ? { run: true } : { run: false, stopped: 'agent_loop_limit', message: `This agent's chain has had ${MULTI_AGENT_LIMITS.wakesPerHour} turns started by sub-agent notifications and messages this hour, its limit: the message is in its history, but no turn ran. Send a message to go on` };
      await this.host.submit(pending.request, pending.notice, delivery);
      await this.host.storage.put(key, { ...pending, delivered: true });
    } catch (error) {
      const status = (error as { status?: number })?.status;
      // Gone parents cannot accept a notification. Other failures stay durable.
      if (status === 404 || status === 410) { await this.host.storage.put(key, { ...pending, delivered: true }); return; }
      await this.host.retry(Date.now() + 1000);
      throw error;
    }
  }
  async drain() {
    for (const [key, notice] of await this.host.storage.list<PendingNotice>({ prefix })) if (!notice.delivered) await this.send(key);
  }
  async pending() {
    return [...(await this.host.storage.list<PendingNotice>({ prefix })).values()].some(notice => !notice.delivered);
  }
}
