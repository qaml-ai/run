import { isDeepStrictEqual } from "node:util";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { RequestRecord } from "../shared/client-protocol.ts";
import type { Storage } from "../shared/storage.ts";
import { proveClosedInputHistory, type SourceSnapshot } from "./agent-v2-closed-inputs.ts";
import { visible, type JournalRecord } from "./client-sessions/state.ts";
import type { Db, Sql } from "./db.ts";
import { piRunning } from "./pi-durable/agent.ts";
import { JournalHistory, HOST_USER_KIND } from "./pi-durable/history.ts";
import { SESSION_CONVERSATION_ID } from "./pi-durable/seed.ts";
import { PostgresPiStorage } from "./pi-durable/storage.ts";
import { resumeId } from "./v1-client-state.ts";

type SourceRevision = {
  revision: string;
  owner_epoch: string;
  last_cursor: string;
  reserved_cursor: string | null;
  pi_version: string;
  inputs: string;
};

async function sourceRevision(sql: Sql, tenant: string, agent: string) {
  const { rows: [row] } = await sql.query<SourceRevision>(`
    select a.revision::text, o.epoch::text as owner_epoch, a.last_cursor::text, a.reserved_cursor::text,
      p.next_seq::text as pi_version,
      coalesce((select jsonb_agg(to_jsonb(i) order by i.id) from agent_inputs i where i.agent = a.id), '[]'::jsonb)::text as inputs
    from agents a join actor_owners o on o.actor = a.id
      join pi_durable_metadata p on p.session_id = a.id
    where a.tenant = $1 and a.id = $2 and not a.revoked and a.purged_at is null
      and (a.expires_at is null or a.expires_at > $3)
      and a.cursor_clean and a.last_cursor is not null and not a.pending_runs
      and o.node is null and o.session is null`, [tenant, agent, Date.now()]);
  return row;
}

const sameRevision = (expected: SourceRevision, actual: SourceRevision | undefined) => !!actual &&
  expected.owner_epoch === actual.owner_epoch && expected.revision === actual.revision &&
  expected.last_cursor === actual.last_cursor && expected.reserved_cursor === actual.reserved_cursor &&
  expected.pi_version === actual.pi_version && expected.inputs === actual.inputs;

type StoredInput = {
  id: string;
  tenant: string;
  agent: string;
  request_id: string;
  tool_call_id: string;
  version: number;
  blocking: boolean;
  state: string;
  input: Record<string, unknown>;
  answer?: SourceSnapshot["inputs"][number]["answer"];
};

function journalReceipts(entries: readonly JournalRecord[]) {
  const receipts = new Map<string, RequestRecord>();
  for (const entry of entries) {
    if (entry?.t === "request" && entry.record && typeof entry.record === "object") {
      receipts.set(entry.record.id, entry.record);
    } else if (entry?.t === "announced" && Array.isArray(entry.ids) && entry.ids.every(id => typeof id === "string")) {
      for (const id of entry.ids) {
        const request = receipts.get(id);
        if (request?.announce) {
          const { announce: _, ...announced } = request;
          receipts.set(id, announced);
        }
      }
    } else throw new Error("Unknown v1 request journal record");
  }
  return [...receipts.values()];
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

type PiReader = NonNullable<Awaited<ReturnType<typeof PostgresPiStorage.openExisting>>>;

async function placedPrompts(pi: PiReader, receipts: readonly RequestRecord[], inputRows: readonly StoredInput[]) {
  const placed = new Set<string>();
  const superseded = inputRows.filter(row => row.blocking && row.state === "superseded" && typeof row.answer?.at === "number");
  if (!superseded.length) return placed;
  const ids = new Set(superseded.map(row => row.request_id));
  const firstStop = receipts.reduce((first, receipt) => ids.has(receipt.id) ?
    Math.min(first, receipt.endedAt ?? Infinity) : first, Infinity);
  const firstAnswer = superseded.reduce((first, row) => Math.min(first, Number(row.answer?.at)), Infinity);
  const lastAnswer = superseded.reduce((last, row) => Math.max(last, Number(row.answer?.at)), -Infinity);
  for (const receipt of receipts) {
    if (receipt.method !== "prompt" || (receipt.began ?? 0) < firstStop || receipt.state !== "completed" ||
      (receipt.startedAt ?? Infinity) > lastAnswer || (receipt.endedAt ?? 0) < firstAnswer) continue;
    const submission = await pi.submissionByRequest(SESSION_CONVERSATION_ID, receipt.id, context);
    // A native input can finish unanswered after its user message lands. A host-only record has no entry.
    if (!submission || (submission.type !== "input" && submission.type !== "write") ||
      submission.status === "queued" || submission.entry === undefined) continue;
    const entry = (await pi.entry(submission.entry, context))?.entry;
    const message = (entry?.data as { message?: { role?: unknown; requestId?: unknown } } | undefined)?.message;
    if (entry?.conversationId === SESSION_CONVERSATION_ID && entry.kind === HOST_USER_KIND &&
      message?.role === "user" && message.requestId === receipt.id) placed.add(receipt.id);
  }
  return placed;
}

/** Evidence from a released v1 session. Keep it in this process and pass it to both fence and publication. */
export class ClosedV1InputWitness {
  private readonly tenant: string;
  private readonly agent: string;
  private readonly source: SourceRevision;
  private readonly inputReceipts: readonly RequestRecord[];

  private constructor(tenant: string, agent: string, source: SourceRevision, inputReceipts: readonly RequestRecord[]) {
    this.tenant = tenant;
    this.agent = agent;
    this.source = source;
    this.inputReceipts = inputReceipts;
  }

  /** The source must use v1's shared, claim-fenced journal storage, as production does. This does no writes. */
  static async read(db: Db, storage: Pick<Storage, "log">, tenant: string, agent: string) {
    const before = await sourceRevision(db, tenant, agent);
    if (!before || before.inputs === "[]") return;
    const rows: StoredInput[] = JSON.parse(before.inputs);
    if (rows.some(row => !object(row.input) || typeof row.input.message !== "string" ||
      !object(row.input.detail) || !object(row.input.responders))) return;
    const pi = await PostgresPiStorage.openExisting(db, agent);
    if (!pi) return;
    try {
      const history = await JournalHistory.openAny(pi);
      if (!history || history.active || history.awaiting.length || await piRunning(pi, SESSION_CONVERSATION_ID)) return;
      if ((await pi.scanSubmissions({ status: "queued" }, 1, undefined, context)).items.length) return;
      const receipts = journalReceipts(await storage.log<JournalRecord>(`client-sessions/${agent}.journal`).read());
      const proof = proveClosedInputHistory({
        tenant, agent, receipts,
        inputs: rows.map(row => ({
          id: row.id, tenant: row.tenant, agent: row.agent, requestId: row.request_id, toolCallId: row.tool_call_id,
          version: row.version, blocking: row.blocking, state: row.state, answer: row.answer,
          deliveryPending: Object.hasOwn(row.input, "delivery"),
        })),
        pi: { active: false, running: false, awaiting: [], completedPromptSubmissions: await placedPrompts(pi, receipts, rows) },
      });
      if (!proof.ok || !sameRevision(before, await sourceRevision(db, tenant, agent))) return;
      const ids = new Set(rows.filter(row => row.blocking).map(row => resumeId(row.request_id)));
      return new ClosedV1InputWitness(tenant, agent, before, receipts.filter(receipt => ids.has(receipt.id)).map(visible));
    } finally { await pi.close(context); }
  }

  /** Under the tenant admission lock, pin the released owner, header and Pi sequence before comparing. */
  async matchesLockedSource(sql: Sql, tenant: string, agent: string) {
    if (tenant !== this.tenant || agent !== this.agent) return false;
    const owner = await sql.query("select from actor_owners where actor = $1 and node is null and session is null for update", [agent]);
    if (!owner.rowCount) return false;
    await sql.query("select from agents where id = $1 and tenant = $2 for update", [agent, tenant]);
    await sql.query("select from pi_durable_metadata where session_id = $1 for update", [agent]);
    await sql.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [agent]);
    await sql.query("select from agent_inputs where agent = $1 for share", [agent]);
    return sameRevision(this.source, await sourceRevision(sql, tenant, agent));
  }

  /** The published archive must let an identical legacy answer retry see its original continuation. */
  includesRequiredReceipts(archive: readonly RequestRecord[]) {
    const byId = new Map(archive.map(record => [record.id, record]));
    return byId.size === archive.length && this.inputReceipts.every(record => isDeepStrictEqual(record, byId.get(record.id)));
  }
}
