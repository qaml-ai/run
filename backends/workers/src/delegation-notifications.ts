import { batchedEnding, childNotice, MULTI_AGENT_LIMITS, withBatch, type BatchedEnding } from './multi-agent-policy.ts';
import { childUsageCost, readChildPayload, type DelegatedChild } from './delegation.ts';
import type { Placement } from '../../../shared/owner.ts';
import { ChildRows } from './children-table.ts';
import type { MessageSource } from './sender.ts';

/** `delegation`: where the run the notice starts stands in its chain (an owner's message to its child), stored with it. */
export type RuntimeNotice = { source: MessageSource; root: string; costUsd: number; metadata: Record<string, unknown>; delegation?: Placement };
export type NoticeRequest = { id: string; method: 'prompt'; params: { endUser?: string; bucket?: string; text: string; allowDisconnected: true; whileRunning: 'followUp'; metadata?: Record<string, string> } };
export type WakeDecision = { allowed: boolean; hour: number };
/** `steer`: offered to the parent's running turn at its next step (delegate.notify "asap"), not queued behind it. */
export type NoticeDelivery = { run: true; steer?: true } | { run: false; stopped: 'agent_loop_limit' | 'aborted'; message: string };
/**
 * A notice in the outbox. `batch`: the other children's endings it carries, chosen once as it is claimed and stored with
 * it, so a send tried again sends the same request. `batchedInto`: the notice whose turn carried this one (it is then
 * `delivered`, and never sent itself).
 */
type PendingNotice = { request: NoticeRequest; notice: RuntimeNotice; childKey?: string; delivered?: true; wake?: WakeDecision; receipt?: unknown; delivery?: NoticeDelivery; batch?: BatchedEnding[]; batchedInto?: string;
  /** A carried notice whose staged copy (if any) was discarded; on the landing entry, that all it carries were. */
  discarded?: true; carriedDiscarded?: true;
  /** How a child's notice reaches a busy parent, decided once: `staged` (as a queued request, after its turn) or `steer`. */
  staged?: true; steer?: true };
const prefix = 'delegation-notice:';
/** What a carried notice's own request answers (as Node's landNotice says it). */
const CARRIED = "this sub-agent's ending reached the agent already, with another one's notification";
/** At most this many other workflows' notices ride in one workflow notice's turn; the rest land in the next. */
export const WORKFLOW_NOTICE_BATCH = 20;
/** A workflow's notice, as its object sends it (workflow-notices.ts): one held in the outbox, not a request of its own. */
const workflowNotice = (pending: PendingNotice) => pending.notice.metadata.kind === 'workflow' && !pending.delivery;
/** A workflow notice's sequence (its request id is `<workflow>_n<seq>`), to keep a workflow's latest. */
const noticeSeq = (pending: PendingNotice) => Number(/_n(\d+)$/.exec(pending.request.id)?.[1] ?? 0);

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
  /** The owner's children table; one is made over `storage` when left out. */
  children?: ChildRows;
  /** This is an internal call. A public request cannot provide its own RuntimeNotice. */
  submit(request: NoticeRequest, notice: RuntimeNotice, delivery: NoticeDelivery): Promise<unknown>;
  admitWake(root: string, requestId: string): Promise<WakeDecision>;
  /** A human prompt must remain pending; a child finishing cannot supersede it. */
  humanPending?(): Promise<boolean>;
  /** Completion notices land between turns; a running wait may take the ending first. */
  canLand?(): Promise<boolean>;
  /** Whether a child's notice may join the parent's running turn now: delegate.notify "asap", and no wait_agent in flight. */
  asap?(): Promise<boolean>;
  /** Expose a queued notice as a pending request while a wait may still take it. */
  stage?(request: NoticeRequest, notice: RuntimeNotice): Promise<void>;
  /** A wait consumed a staged ending before it reached the model, or another notice's turn carried it (`skipped` says which). */
  discard?(request: NoticeRequest, skipped?: string, carried?: boolean): Promise<void>;
  wakeLimit?: number;
  /** Uses the agent's existing alarm, preserving any earlier work. */
  retry(at: number): Promise<void>;
}

/** A child's ending as an outbox entry: built from its record alone, so every builder (deliver, a batch) writes the same. */
function outboxEntry(child: DelegatedChild): PendingNotice {
  const { text, notice } = childNotice({ agentId: child.id, name: child.name, root: child.root ?? child.id }, child, { startedAt: child.createdAt, endedAt: child.endedAt });
  notice.costUsd = child.spent ?? childUsageCost(child.outcome?.result?.usage);
  return { request: { id: `child_${child.requestId}`, method: 'prompt', params: { text, endUser: child.payer, bucket: child.bucket, allowDisconnected: true, whileRunning: 'followUp' } }, notice, childKey: child.key };
}

/** Durable outbox plus idempotent admission covers eviction before or after the parent's submit. */
export class DelegationNotifications {
  private active = new Map<string, Promise<unknown>>();
  private host: NotificationHost;
  private rows: ChildRows;
  constructor(host: NotificationHost) { this.host = host; this.rows = host.children ?? new ChildRows(host.storage); }
  async deliver(child: DelegatedChild): Promise<void> {
    const key = prefix + child.key;
    if (!await this.host.storage.get(key, { noCache: true })) await this.host.storage.put(key, outboxEntry(child), { noCache: true });
    await this.send(key);
  }
  async deliverMessage(request: NoticeRequest, notice: RuntimeNotice): Promise<unknown> {
    const key = prefix + request.id;
    if (!await this.host.storage.get(key, { noCache: true })) await this.host.storage.put(key, { request, notice } satisfies PendingNotice, { noCache: true });
    return this.send(key);
  }
  private send(key: string): Promise<unknown> {
    const previous = this.active.get(key);
    if (previous) return previous;
    const sending = this.sendPending(key).finally(() => { this.active.delete(key); });
    this.active.set(key, sending);
    return sending;
  }
  private async sendPending(key: string) {
    let pending = await this.host.storage.get<PendingNotice>(key, { noCache: true });
    if (!pending || pending.delivered) {
      // Carried by another notice's turn: a staged copy left by a crash before its discard goes now (discard is idempotent).
      if (pending?.batchedInto && !pending.discarded) await this.discardCarried(key, pending);
      return pending?.receipt;
    }
    try {
      if (!pending.delivery && await this.host.humanPending?.()) { await this.host.retry(Date.now() + MULTI_AGENT_LIMITS.sweepMs); return; }
      // A workflow's notice waits here, in the owner's own outbox, until the owner is between turns: it takes no slot in
      // the owner's request queue (many workflows would fill it, and a notice refused there is lost to its turn). When it
      // lands it carries every other workflow notice waiting (below), so many workflows cost the owner one turn.
      if (workflowNotice(pending) && this.host.canLand && !await this.host.canLand()) { await this.host.retry(Date.now() + 1000); return; }
      let steer = !!pending.steer;
      if (!pending.delivery && pending.childKey && !steer && this.host.canLand && !await this.host.canLand()) {
        // An agent set to hear endings at once (delegate.notify "asap"), with no wait_agent in flight, gets this one at its
        // running turn's next step. Decided once per notice: one staged already stays staged (its request's input is the
        // queued one), and one steered is always sent steered.
        if (pending.staged || !await this.host.asap?.()) {
          await this.stageUnlessCarried(key, pending);
          await this.host.retry(Date.now() + 1000);
          return;
        }
        steer = true;
      }
      // Compete with wait_agent in the same transaction, before either can
      // expose the answer. A durable outbox owns a notice claim through retry.
      const claim = await this.host.storage.transaction(async tx => {
        // Read again inside the claim: another notice's turn may have carried this one meanwhile (a batch).
        const current = await tx.get<PendingNotice>(key, { noCache: true });
        if (!current || current.delivered) return { state: 'carried' as const };
        const child = current.childKey ? await this.rows.get(current.childKey) : undefined;
        if (child?.landedBy === 'wait') return { state: 'waited' as const };
        if (child && !child.landedBy) await this.rows.put({ ...child, landedBy: 'notice' }, tx);
        // A child's notice that lands carries every other ended child's notice still in the outbox (a batch), chosen
        // once, in this transaction: each carried one is claimed for it (landedBy, as a wait_agent's take) and marked
        // delivered here, and the batch is stored with this notice, so a send tried again after a crash sends exactly
        // this. Agents' messages, and notices bound to land without a turn (`delivery`), keep their own.
        if (workflowNotice(current) && current.batch === undefined) {
          // Every other workflow notice waiting rides along, a workflow's latest only (it says where that workflow is
          // now; the earlier ones are folded into it), up to WORKFLOW_NOTICE_BATCH workflows.
          const waiting: [string, PendingNotice][] = [];
          for (const [otherKey, other] of await tx.list<PendingNotice>({ prefix, noCache: true }))
            if (otherKey !== key && !other.delivered && workflowNotice(other) && (other.request.params.endUser ?? null) === (current.request.params.endUser ?? null) && (other.request.params.bucket ?? null) === (current.request.params.bucket ?? null)) waiting.push([otherKey, other]);
          const own = current.notice.metadata.workflowId, groups = new Map<unknown, [string, PendingNotice][]>();
          for (const entry of waiting) groups.set(entry[1].notice.metadata.workflowId, [...groups.get(entry[1].notice.metadata.workflowId) ?? [], entry]);
          const batch: BatchedEnding[] = [], carried: NoticeRequest[] = [];
          let shownCount = 0;
          for (const [workflow, entries] of groups) {
            entries.sort((a, b) => noticeSeq(a[1]) - noticeSeq(b[1]));
            const [, latest] = entries.at(-1)!;
            // This notice's own workflow shows only a newer notice; its older ones fold into this one.
            const shown = workflow !== own || noticeSeq(latest) > noticeSeq(current);
            if (shown && shownCount >= WORKFLOW_NOTICE_BATCH) continue;
            for (const [otherKey, other] of entries) {
              await tx.put(otherKey, { ...other, delivered: true, batchedInto: key }, { noCache: true });
              carried.push(other.request);
            }
            if (!shown) continue;
            shownCount++;
            batch.push({ ...latest.notice.metadata, agentId: String(workflow ?? ''), name: latest.notice.source.name, status: String(latest.notice.metadata.status ?? ''), text: latest.request.params.text, costUsd: 0, requestId: latest.request.id });
          }
          batch.sort((a, b) => a.requestId < b.requestId ? -1 : 1);
          const next: PendingNotice = { ...current, batch };
          await tx.put(key, next, { noCache: true });
          return { state: 'claimed' as const, pending: next, carried };
        }
        if (!current.childKey || current.delivery || current.batch !== undefined) {
          const kept: PendingNotice = steer && !current.steer && current.childKey && !current.delivery ? { ...current, steer: true } : current;
          if (kept !== current) await tx.put(key, kept, { noCache: true });
          return { state: 'claimed' as const, pending: kept, carried: [] as NoticeRequest[] };
        }
        // Siblings are found by their records, not only their outbox entries: a child that has just ended may not have
        // one yet (its notice is written once its events drain), and then gets it here, already carried.
        const batch: BatchedEnding[] = [], carried: NoticeRequest[] = [];
        for (const sibling of await this.rows.ended()) {
          // (Not `notified`: a staged notice's child is marked so before it lands; its entry says whether it was delivered.)
          if (!sibling?.background || !sibling.id || sibling.key === current.childKey || sibling.status === 'running' || sibling.landedBy || sibling.folded) continue;
          // One without an entry is built from its record, if its start was accepted: a child whose start failed has no
          // ending to tell (the spawn call answered with its error).
          const otherKey = prefix + sibling.key, existing = await tx.get<PendingNotice>(otherKey, { noCache: true });
          if (!existing && !sibling.accepted) continue;
          const other = existing ?? outboxEntry(await readChildPayload(tx, sibling));
          if ((other.request.params.endUser ?? null) !== (current.request.params.endUser ?? null) || (other.request.params.bucket ?? null) !== (current.request.params.bucket ?? null)) continue;
          if (other.delivered || other.delivery || other.notice.metadata.kind === 'message') continue;
          await this.rows.put({ ...sibling, landedBy: 'notice' }, tx);
          await tx.put(otherKey, { ...other, delivered: true, batchedInto: key }, { noCache: true });
          batch.push(batchedEnding({ text: other.request.params.text, notice: other.notice }, other.request.id));
          carried.push(other.request);
        }
        const next: PendingNotice = { ...current, batch, ...(steer ? { steer: true as const } : {}) };
        await tx.put(key, next, { noCache: true });
        return { state: 'claimed' as const, pending: next, carried };
      });
      if (claim.state === 'carried') return (await this.host.storage.get<PendingNotice>(key, { noCache: true }))?.receipt;
      if (claim.state === 'waited') {
        await this.host.discard?.(pending.request);
        await this.host.storage.put(key, { ...pending, delivered: true }, { noCache: true });
        return;
      }
      pending = claim.pending;
      // Carried notices that were staged (exposed as pending requests while a wait could take them) are no longer: done
      // on every send until it is recorded, so a crash between the claim and these discards leaves no staged copy behind.
      if (pending.batch?.length && !pending.carriedDiscarded) {
        for (const [otherKey, other] of await this.host.storage.list<PendingNotice>({ prefix, noCache: true }))
          if (other?.batchedInto === key) await this.discardCarried(otherKey, other);
        pending = { ...pending, carriedDiscarded: true };
        await this.host.storage.put(key, pending, { noCache: true });
      }
      if (!pending.delivery && !pending.wake) {
        // Message admission decides against the live logical turn. A pending
        // operation receipt alone does not prove that it can still take a steer.
        pending.wake = pending.notice.metadata.kind === 'message'
          ? { allowed: true, hour: Math.floor(Date.now() / 3_600_000) }
          : await this.host.admitWake(pending.notice.root, pending.request.id);
        await this.host.storage.put(key, pending, { noCache: true });
      }
      const delivery: NoticeDelivery = pending.delivery ?? (pending.wake!.allowed ? { run: true, ...(pending.steer ? { steer: true as const } : {}) } : { run: false, stopped: 'agent_loop_limit', message: `This agent's chain has had ${this.host.wakeLimit ?? MULTI_AGENT_LIMITS.wakesPerHour} turns started by sub-agent notifications and messages this hour, its limit: the message is in its history, but no turn ran. Send a message to go on` });
      const receipt = await this.host.submit(pending.request, withBatch(pending.notice, pending.batch ?? []), delivery);
      await this.host.storage.put(key, { ...pending, delivered: true, receipt }, { noCache: true });
      return receipt;
    } catch (error) {
      const status = (error as { status?: number })?.status;
      // Gone parents cannot accept a notification. Other failures stay durable.
      if (status === 404 || status === 410) { await this.host.storage.put(key, { ...pending, delivered: true }, { noCache: true }); return; }
      await this.host.retry(Date.now() + 1000);
      throw error;
    }
  }
  /** An aborted parent still records queued child endings, without starting another turn. */
  async abortPending() {
    for (const [key, notice] of await this.host.storage.list<PendingNotice>({ prefix, noCache: true })) {
      if (notice.delivered) continue;
      await this.active.get(key);
      const pending = await this.host.storage.get<PendingNotice>(key, { noCache: true });
      if (!pending || pending.delivered) continue;
      await this.host.storage.put(key, { ...pending, delivery: { run: false, stopped: 'aborted', message: 'Aborted' } }, { noCache: true });
      await this.send(key);
    }
  }
  async drain() {
    for (const [key, notice] of await this.host.storage.list<PendingNotice>({ prefix, noCache: true })) {
      if (!notice.delivered || (notice.batch?.length && !notice.carriedDiscarded)) await this.send(key);
      else if (notice.batchedInto && !notice.discarded) await this.discardCarried(key, notice);
    }
  }
  /**
   * Stage a busy parent's notice (a pending request a wait may take) only while it is still its own: one another
   * notice's turn carried meanwhile is not staged, and one carried while it was being staged has its copy discarded.
   */
  private async stageUnlessCarried(key: string, pending: PendingNotice) {
    // Marked staged on a fresh read, in a transaction: a write of an older copy could undo a batch's claim of it.
    const before = await this.host.storage.transaction(async tx => {
      const current = await tx.get<PendingNotice>(key, { noCache: true });
      if (current && !current.delivered && !current.staged) await tx.put(key, { ...current, staged: true }, { noCache: true });
      return current;
    });
    if (!before || before.delivered) { if (before?.batchedInto) await this.discardCarried(key, before); return; }
    await this.host.stage?.(pending.request, pending.notice);
    const after = await this.host.storage.get<PendingNotice>(key, { noCache: true });
    if (after?.delivered && after.batchedInto) await this.discardCarried(key, after);
  }
  /** A carried notice's staged copy, if any, answers as carried; recorded, so a drain need not ask again. */
  private async discardCarried(key: string, entry: PendingNotice) {
    await this.host.discard?.(entry.request, CARRIED, true);
    if (!entry.discarded) await this.host.storage.put(key, { ...entry, discarded: true }, { noCache: true });
  }
  async pending() {
    return [...(await this.host.storage.list<PendingNotice>({ prefix, noCache: true })).values()].some(notice => !notice.delivered);
  }
}
