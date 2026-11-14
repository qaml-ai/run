import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { InboxDoc, LiveDoc } from "@earendil-works/pi-durable";
import { answers } from "./batch-runs.ts";
import { batchable, joins } from "../../../shared/queue-mode.ts";
import { reqKey, type RequestRecord, type Config } from "./agent-types.ts";
import type { AgentRuntime } from "./agent-runtime.ts";

const HOLD = "batch-hold:";
/** Releases of a held prompt that may fail (its Pi submission refused) before it ends failed, so the queue goes on. */
const RELEASE_ATTEMPTS = 5;

/** A prompt held back from Pi's inbox, with the submission that gives it to Pi (`admit`). */
type Hold = {
  id: string; key: string; startedAt: number; content: unknown; submission: Record<string, unknown>;
  actor?: string; bucket?: string; params?: Record<string, unknown>;
  /** Held only for its agent's window (`queue.windowMs`): Pi was idle. */
  window?: true; failures?: number;
};
type Inbox = { items: { mode: string; entry?: { data?: { requestId?: string } } }[] };
type Member = { id?: string; actor?: string; bucket?: string; params?: unknown };

/**
 * Batching for an agent whose queue batches (`queue: {mode: "batch"}`, shared/queue-mode.ts), on Pi's own queue: Pi's
 * `followUpMode` is "all" for it (agent-tools.ts `settings`), so the follow-ups waiting in Pi's inbox when a run ends
 * are placed together and start one run, each its own user message, and Pi settles them all with that run's answer.
 * Pi merges whatever is in its inbox, so the inbox must only ever hold prompts that may share a turn (`joins`): a prompt
 * that may not (an output schema, limits of its own, another actor, payer selection or bucket, a delegated or runtime prompt, a
 * notification) is held here while follow-ups wait in Pi's inbox, and so is everything after it, in order. Once Pi has
 * no follow-ups waiting, `release` gives Pi the first held prompt, and those after it that may join it.
 *
 * A window (`queue.windowMs`) holds a joinable prompt that reaches an idle agent that long, and those arriving with it.
 */
export class BatchQueue {
  private readonly runtime: AgentRuntime;
  constructor(runtime: AgentRuntime) { this.runtime = runtime; }

  private get storage() { return this.runtime.ctx.storage; }

  /** The follow-ups waiting in Pi's inbox (their request ids, in order), and whether Pi has nothing running or queued. */
  private async inbox() {
    const pi = await this.runtime.harness.pi(), root = await pi.root(BACKGROUND_CONTEXT);
    const [inbox, live] = await Promise.all([pi.snapshot(InboxDoc, root.id, BACKGROUND_CONTEXT), pi.snapshot(LiveDoc, root.id, BACKGROUND_CONTEXT)]);
    const items = (inbox as Inbox | undefined)?.items ?? [];
    return { waiting: items.filter(item => item.mode === "followUp").map(item => item.entry?.data?.requestId), steering: items.some(item => item.mode === "steer"), idle: live?.run === undefined && !items.length };
  }

  /** At a final boundary Pi can place a steer and queued follow-ups in the same run. */
  async canSteer(endUser: string | undefined) {
    const { waiting } = await this.inbox();
    for (const id of waiting) {
      const record = id ? await this.storage.get<RequestRecord>(reqKey(id)) : undefined;
      if (!record || (record.params?.endUser ?? null) !== (endUser ?? null)) return false;
    }
    return true;
  }

  /**
   * Whether a request being admitted is held rather than given to Pi now: everything while prompts are held (the queue
   * keeps its order), and on a batching agent one that may not join the follow-ups waiting in Pi's inbox, or a joinable
   * prompt that reaches an idle agent with a window ("window").
   */
  async holds(conf: Config, candidate: Member, notice: boolean): Promise<false | "hold" | "window"> {
    if ((await this.storage.list({ prefix: HOLD, limit: 1 })).size) return "hold";
    const { waiting, steering, idle } = await this.inbox();
    // Pi can drain a queued steer together with follow-ups. Keep unrelated inputs out until it is consumed.
    // A steer no turn could take must start at an idle boundary, even on an agent whose queue does not batch.
    if (steering || ((candidate.params as { whileRunning?: string } | undefined)?.whileRunning === "steer" && !idle)) return "hold";
    const queue = conf.config.queue;
    if (queue?.mode !== "batch" || conf.config.type === "subagent") return false;
    // A steer no turn could take queues as its own follow-up; it cannot share a later batch.
    const joinable = !notice && (candidate.params as { whileRunning?: string } | undefined)?.whileRunning !== "steer" && batchable(candidate.params, candidate.id);
    if (waiting.length) {
      const head = waiting[0] ? await this.storage.get<RequestRecord>(reqKey(waiting[0])) : undefined;
      return joinable && head && joins(memberOf(head), candidate) ? false : "hold";
    }
    return joinable && idle && (queue.windowMs ?? 0) > 0 ? "window" : false;
  }

  /** Hold `record` for a later release; it is accepted and queued, and nothing waits on Pi for it. */
  async hold(record: RequestRecord, content: unknown, submission: Record<string, unknown>, window: boolean) {
    const accepted = await this.storage.transaction(async tx => {
      const latest = (await tx.get<RequestRecord>(reqKey(record.id))) ?? record;
      if (latest.batchHeld || latest.state === "completed") return latest;
      const sequence = ((await tx.get<number>("batch-hold-seq")) ?? 0) + 1;
      const key = `${HOLD}${String(sequence).padStart(12, "0")}`;
      await tx.put("batch-hold-seq", sequence);
      await tx.put(key, { key, startedAt: latest.startedAt, content, submission, ...memberOf(latest), id: record.id, ...(window ? { window: true as const } : {}) } satisfies Hold);
      const held: RequestRecord = { ...latest, state: "queued", accepted: true, batchHeld: key };
      await tx.put(reqKey(record.id), held);
      return held;
    });
    this.kick();
    return accepted;
  }

  /** When the first held prompt's window ends, for the alarm; Infinity when none waits on a window still to come. */
  async deadline(conf: Config | undefined) {
    const first = [...(await this.storage.list<Hold>({ prefix: HOLD, limit: 1 })).values()][0];
    if (!first?.window) return Infinity;
    const at = first.startedAt + (conf?.config.queue?.mode === "batch" ? conf.config.queue.windowMs ?? 0 : 0);
    // Past already: released now, not armed for a time gone by (which would wake the agent again at once).
    if (at <= Date.now()) { this.kick(); return Infinity; }
    return at;
  }

  /** Ask for a release, after the admissions before it. */
  kick() {
    const work = this.runtime.admission.then(() => this.release());
    this.runtime.admission = work.catch(error => console.error(JSON.stringify({ type: "batch_release_failed", error: error instanceof Error ? error.message : String(error) })));
  }

  /**
   * Give Pi the first held prompt and those after it that may join it, once Pi has no follow-ups waiting (and the first's
   * window has passed). An agent that no longer batches has every held prompt given at once, in order: Pi's own queue
   * keeps it.
   */
  private async release() {
    const holds = [...(await this.storage.list<Hold>({ prefix: HOLD })).values()];
    if (!holds.length) return;
    const conf = await this.runtime.config();
    const { waiting, steering, idle } = await this.inbox();
    if (steering || ((holds[0].params as { whileRunning?: string } | undefined)?.whileRunning === "steer" && !idle)) return;
    if (conf.config.queue?.mode !== "batch") {
      for (const hold of holds) if (!await this.give(hold)) return;
      return;
    }
    if (waiting.length) return;
    const [first, ...rest] = holds;
    const due = first.startedAt + (conf.config.queue.windowMs ?? 0);
    if (first.window && idle && Date.now() < due) { await this.runtime.arm(due); return; }
    if (!await this.give(first)) return;
    for (const hold of rest) if (!joins(first, hold) || !await this.give(hold)) return;
  }

  /**
   * Give Pi one held prompt (its submission is idempotent by its request id), and wait on it as on any request. A stop
   * or cancellation that reached it ends it instead. One Pi keeps refusing ends failed after RELEASE_ATTEMPTS, so the
   * queue behind it goes on. Answers whether the next may go.
   */
  private async give(hold: Hold) {
    if (await this.storage.get(`cancelled-request:${hold.id}`)) { await this.cancel(hold.id); return true; }
    try { await this.runtime.harness.submit(hold.content as never, hold.submission as never); }
    catch (error) {
      const failures = (hold.failures ?? 0) + 1, message = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({ type: "batch_release_refused", request: hold.id, failures, error: message }));
      if (failures < RELEASE_ATTEMPTS) { await this.storage.put(hold.key, { ...hold, failures }); return false; }
      await this.end(hold.id, { error: `The runtime could not start this run: ${message}` });
      return true;
    }
    await this.storage.transaction(async tx => {
      const record = await tx.get<RequestRecord>(reqKey(hold.id));
      await tx.delete(hold.key);
      if (!record?.batchHeld) return;
      const { batchHeld: _held, ...rest } = record;
      await tx.put(reqKey(hold.id), rest);
    });
    this.runtime.track(hold.id);
    return true;
  }

  /** Cancel a held prompt: its hold goes and its request completes as cancelled. */
  async cancel(id: string) {
    if (!await this.end(id, { result: { error: "Queued run cancelled", code: "cancelled" } })) return false;
    await this.runtime.emit({ type: "event", requestId: id, event: { type: "run_cancelled", reason: "stopped" } });
    return true;
  }

  /** End a held request, never given to Pi, failed with `outcome`: its hold goes, and so do its busy slot and its tenant's admission. */
  private async end(id: string, outcome: NonNullable<RequestRecord["outcome"]>) {
    const done = await this.storage.transaction(async tx => {
      const record = await tx.get<RequestRecord>(reqKey(id));
      if (!record?.batchHeld || record.state === "completed") return undefined;
      await tx.delete(record.batchHeld);
      const { batchHeld: _held, ...rest } = record;
      const completed: RequestRecord = { ...rest, state: "completed", status: "failed", endedAt: Date.now(), outcome };
      await tx.put(reqKey(id), completed);
      return completed;
    });
    if (!done) return false;
    const conf = await this.runtime.config();
    await this.runtime.env.TENANTS.getByName(conf.tenantId).release(`${conf.id}:${id}`);
    await this.runtime.emit({ type: "response", id, outcome: done.outcome });
    return true;
  }

  /** Every held prompt (a stop that cancels the queue): each cancelled. Their ids. */
  async cancelAll() {
    const cancelled: string[] = [];
    for (const hold of (await this.storage.list<Hold>({ prefix: HOLD })).values()) if (await this.cancel(hold.id)) cancelled.push(hold.id);
    return cancelled;
  }

  /** A held request a waiter reached (`settle`): one a stop or cancellation marked ends now; any other stays held. */
  async settleHeld(record: RequestRecord) {
    if (await this.storage.get(`cancelled-request:${record.id}`)) await this.cancel(record.id);
    else this.kick();
    return (await this.storage.get<RequestRecord>(reqKey(record.id))) ?? record;
  }

  /**
   * Which run of Pi's placed a request's input, as a key two inputs share when one run had both: Pi settles every input
   * of a run with its answer (`done`, the answer's entry), and only the running run has inputs `placed`. One that ended
   * unanswered (its run failed) shares its run with nothing it can be told from, so it keys alone.
   */
  async runKey(requestId: string): Promise<string> {
    const pi = await this.runtime.harness.pi(), root = await pi.root(BACKGROUND_CONTEXT);
    const submission = await root.commit(async tx => tx.submissionByRequest(root.id, requestId), BACKGROUND_CONTEXT);
    if (submission?.status === "done") return `answer:${submission.answer}`;
    if (submission?.status === "placed") return "running";
    return `alone:${requestId}`;
  }

  /**
   * The batch a request's input is in, from Pi's transcript, on an agent whose queue batches: the prompts Pi placed in
   * the same run (`runKey`) beside it, before the run's first answer, in order; the first started the run. Empty for a
   * prompt alone.
   */
  async batchOf(id: string): Promise<string[]> {
    const conf = await this.runtime.config();
    if (conf.config.queue?.mode !== "batch") return [];
    const pi = await this.runtime.harness.pi(), root = await pi.root(BACKGROUND_CONTEXT);
    const placed = await root.commit(async tx => (await tx.submissionByRequest(root.id, id))?.entry, BACKGROUND_CONTEXT);
    if (placed === undefined) return [];
    const key = await this.runKey(id);
    if (key.startsWith("alone:")) return [];
    const side = async (order: "ascending" | "descending") => {
      const found: string[] = [];
      for (let cursor, done = false; !done;) {
        const page = await root.entries(order === "ascending" ? { order, minEntryId: Number(placed) + 1 } as never : { order, maxEntryId: Number(placed) - 1 } as never, 16, cursor, BACKGROUND_CONTEXT);
        for (const entry of page.items) {
          if (answers(entry)) { done = true; break; }
          const other = entry.kind === "camel.prompt" ? (entry.data as { requestId?: string } | undefined)?.requestId : undefined;
          if (other && await this.runKey(other) === key) found.push(other);
        }
        cursor = page.next;
        if (cursor === undefined) done = true;
      }
      return order === "ascending" ? found : found.reverse();
    };
    const batch = [...await side("descending"), id, ...await side("ascending")];
    return batch.length > 1 ? batch : [];
  }
}

/** What `joins` compares of a request: its id, actor, bucket and params. */
function memberOf(record: RequestRecord) {
  return { id: record.id, ...(record.actor ? { actor: record.actor } : {}), ...(record.params?.bucket ? { bucket: String(record.params.bucket) } : {}), ...(record.params ? { params: record.params } : {}) };
}
