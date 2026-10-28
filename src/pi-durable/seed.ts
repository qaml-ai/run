import { createHash } from "node:crypto";
import type { Context, JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import type { ConversationId, DocumentId, EntryId, Storage, StorageWrite } from "@earendil-works/pi-durable";
import { baseWrites, HOST_MESSAGE_KIND, HOST_USER_KIND, MARKER_KIND } from "./history.ts";
import { ARCHIVE_KIND, type ArchiveData } from "./ordinals.ts";

/**
 * The marker every session's Pi storage starts with (`seedJournal`): releases before #326 refuse a root whose first entry
 * is not it, so it stays. Sessions seeded before the host transcript's removal follow it with their host generation
 * (`HOST_BOOTSTRAP_KIND`), its archive and the host document; those since, with their journal history's base.
 */
export const SEED_MARKER_KIND = "camel.legacy.migration";
/** An archive block of the first seeds, before the host generation took its archive. */
export const SEED_RECORD_KIND = "camel.legacy.record";
/** The host transcript's generation marker and archive blocks, in sessions seeded before its removal (retired-host.ts). */
export const HOST_BOOTSTRAP_KIND = "camel.host.bootstrap", HOST_ARCHIVE_KIND = "camel.host.archive";
const CONTEXT_HEAD_KIND = "camel.legacy.context";
/** One message of a context checkpoint after its head entry: Pi can choose a compaction cut between them. */
const CONTEXT_MESSAGE_KIND = "camel.context.message";
/** Each Camel session has its own fenced Pi storage, so it uses Pi's reserved root. */
export const SESSION_CONVERSATION_ID = 1 as ConversationId;
const VERSION = 1;

export interface SeedMetadata {
  version: 1;
  sessionId: string;
  fingerprint: string;
  conversationId: ConversationId;
  recordCount: number;
  historyCount: number;
  contextCount: number;
  importedAt: number;
  markerId: EntryId;
  contextEntryId: EntryId;
  /** The host generation the seed started (seeds before #322 and since the host transcript's removal have none). */
  generationId?: EntryId;
  /** "legacy-log": the records were too large to copy, so they stayed in the session's legacy log (seeds before the host transcript's removal). */
  archive?: "legacy-log";
}

/** Seeded storage belongs to one session and one source. */
export class SeedConflict extends Error {
  constructor(detail: string) {
    super(`Pi session seed conflict: ${detail}`);
    this.name = "SeedConflict";
  }
}

const json = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const payload = (value: unknown): JsonValue => json(value) as JsonValue;

/**
 * A context checkpoint as Pi entries: a head with the first message, then one entry per message, so the first run
 * after a seed need not split it again (Pi can only cut a compaction between entries). `ids` has one per message.
 */
export function contextWrites(ids: readonly number[], conversationId: ConversationId, model: readonly Message[], data?: JsonValue): StorageWrite[] {
  if (ids.length !== Math.max(1, model.length)) throw new Error("A context checkpoint needs one ID per message");
  const head = ids[0] as EntryId;
  return [
    { type: "entry", value: { id: head, conversationId, kind: CONTEXT_HEAD_KIND, head, model: model.slice(0, 1), ...(data === undefined ? {} : { data }) } },
    ...model.slice(1).map((message, index): StorageWrite => ({ type: "entry", value: { id: ids[index + 1] as EntryId, conversationId, kind: CONTEXT_MESSAGE_KIND, model: [message] } })),
  ];
}

/** The seed marker, the root's first entry; undefined when the root does not exist. */
export async function loadSeedMarker(storage: Storage, context: Context = BACKGROUND_CONTEXT): Promise<SeedMetadata | undefined> {
  if (!await storage.conversation(SESSION_CONVERSATION_ID, context)) return undefined;
  const first = (await storage.scanEntries({ conversationId: SESSION_CONVERSATION_ID, order: "ascending" }, 1, undefined, context)).items[0];
  if (!first || first.kind !== SEED_MARKER_KIND) throw new SeedConflict("Pi root contains data without a seed marker");
  const metadata = first.data as unknown as SeedMetadata;
  if (metadata?.version !== VERSION || metadata.markerId !== first.id || metadata.conversationId !== SESSION_CONVERSATION_ID) {
    throw new SeedConflict("unsupported or malformed seed marker");
  }
  return json(metadata);
}

const lines = new WeakMap<Storage, Promise<unknown>>();

/**
 * Start a session's journal (a new agent's, an import's, a fork's) in one commit, under the session's claim: the seed
 * marker, the history's base (`before`: how many messages come before it, which the history index holds: a fork's),
 * the history the session starts with as native entries, each turn marked (`messages`: an import's), the context
 * checkpoint Pi starts from (`model`: its head, before the history's message `headAt`, so Pi's context is the head and
 * the messages after it, which are not copied), and the request IDs of that history as terminal submissions (so a
 * retried one is never run again): a failed commit leaves nothing. Seeding the same source again finds it seeded
 * (`existing`).
 */
/** About as much as one archive entry holds: a turn larger than it takes several. */
const ARCHIVE_BYTES = 1_000_000;

/** History kept before a base (messages from `start`), as archive entries: one per turn (`turns`: where they start), split past ARCHIVE_BYTES. */
export function archiveEntries(messages: AgentMessage[], turns: readonly number[], start = 0): ArchiveData[] {
  const entries: ArchiveData[] = [];
  const starts = new Set(turns);
  let current: ArchiveData | undefined, bytes = 0;
  messages.forEach((message, index) => {
    const size = JSON.stringify(message).length;
    const turn = starts.has(start + index);
    if (!current || turn || bytes + size > ARCHIVE_BYTES) {
      current = { start: start + index, messages: [], ...(turn ? { turn: true } : {}) };
      entries.push(current); bytes = 0;
    }
    current.messages.push(message); bytes += size;
  });
  return entries;
}

export async function seedJournal(options: {
  storage: Storage;
  sessionId: string;
  model: Message[];
  before?: { total: number; calls?: [string, number][] };
  /** The history before the base (a fork's copy of its source's) and its turn starts, kept as archive entries: `before.total` is its length. */
  archive?: { messages: AgentMessage[]; turns: number[] };
  messages?: AgentMessage[];
  /** Where the checkpoint goes among `messages` (an import's summary at its cut); 0 by default. */
  headAt?: number;
  /** Requests whose messages the history holds before its base. */
  requests?: string[];
  context?: Context;
  now?: number;
}): Promise<SeedMetadata & { status: "seeded" | "existing" }> {
  const { storage, sessionId, model, context = BACKGROUND_CONTEXT, now = Date.now() } = options;
  if (!sessionId) throw new TypeError("A seed needs the session's public ID");
  const messages = options.messages ?? [], before = options.before?.total ?? 0;
  const headAt = Math.min(options.headAt ?? 0, messages.length);
  const archive = options.archive ? archiveEntries(options.archive.messages, options.archive.turns) : [];
  if (options.archive && options.archive.messages.length !== before) throw new TypeError("A seed's archive is the history before its base");
  const fingerprint = createHash("sha256").update(JSON.stringify({ before, messages, model, headAt, ...(options.archive?.messages.length ? { archive: options.archive.messages } : {}) })).digest("hex");
  const requests = [...new Set([...options.requests ?? [], ...messages.flatMap(message => message.role === "user" && (message as { requestId?: string }).requestId ? [(message as { requestId?: string }).requestId!] : [])])];
  const run = (lines.get(storage) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const previous = await loadSeedMarker(storage, context);
    if (previous) {
      if (previous.sessionId !== sessionId || previous.fingerprint !== fingerprint) throw new SeedConflict("storage belongs to another session or source");
      return { ...previous, status: "existing" as const };
    }
    // Where turns begin in the history written here: at a user message after anything else.
    const turns = messages.flatMap((message, index) => message.role === "user" && messages[index - 1]?.role !== "user" ? [index] : []);
    const contextIds = Math.max(1, model.length);
    const count = 3 + archive.length + messages.length + 2 * turns.length + contextIds + requests.length;
    const bulk = storage as Storage & { mintIds?(count: number): Promise<number[]> };
    const ids = bulk.mintIds ? await bulk.mintIds(count) : await (async () => {
      const ids: number[] = [];
      for (let index = 0; index < count; index++) ids.push(await storage.mintId());
      return ids;
    })();
    if (ids.length !== count || ids.some((id, index) => !Number.isSafeInteger(id) || id <= 1 || index > 0 && id <= ids[index - 1])) {
      throw new SeedConflict("storage returned an invalid ID reservation");
    }
    let nextId = 0;
    const markerId = ids[nextId++] as EntryId, baseId = ids[nextId++] as EntryId, documentId = ids[nextId++] as DocumentId;
    const body: StorageWrite[] = archive.map(data => ({ type: "entry" as const, value: { id: ids[nextId++] as EntryId, conversationId: SESSION_CONVERSATION_ID, kind: ARCHIVE_KIND, data: payload(data) } }));
    let contextEntryId = 0 as EntryId;
    const checkpoint = () => {
      contextEntryId = ids[nextId] as EntryId;
      body.push(...contextWrites(ids.slice(nextId, nextId += contextIds), SESSION_CONVERSATION_ID, model, payload({ fingerprint })));
    };
    for (const [index, message] of messages.entries()) {
      if (index === headAt) checkpoint();
      if (turns.includes(index)) {
        if (index) body.push({ type: "entry", value: { id: ids[nextId++] as EntryId, conversationId: SESSION_CONVERSATION_ID, kind: MARKER_KIND, data: { t: "turn", active: false, total: before + index } } });
        body.push({ type: "entry", value: { id: ids[nextId++] as EntryId, conversationId: SESSION_CONVERSATION_ID, kind: MARKER_KIND, data: { t: "turn", active: true, total: before + index } } });
      }
      body.push({ type: "entry", value: { id: ids[nextId++] as EntryId, conversationId: SESSION_CONVERSATION_ID, ...(message.role === "user"
        ? { kind: HOST_USER_KIND, data: payload({ message }), model: payload([{ role: "user", content: message.content, timestamp: message.timestamp }]) as never }
        : { kind: HOST_MESSAGE_KIND, model: payload([message]) as never }) } });
    }
    if (headAt === messages.length) checkpoint();
    if (turns.length) body.push({ type: "entry", value: { id: ids[nextId++] as EntryId, conversationId: SESSION_CONVERSATION_ID, kind: MARKER_KIND, data: { t: "turn", active: false, total: before + messages.length } } });
    const metadata: SeedMetadata = {
      version: VERSION, sessionId, fingerprint, conversationId: SESSION_CONVERSATION_ID,
      recordCount: 0, historyCount: before + messages.length, contextCount: model.length,
      importedAt: now, markerId, contextEntryId,
    };
    const writes: StorageWrite[] = [
      { type: "conversation", value: { id: SESSION_CONVERSATION_ID } },
      { type: "entry", value: { id: markerId, conversationId: SESSION_CONVERSATION_ID, kind: SEED_MARKER_KIND, data: payload(metadata) } },
      ...baseWrites(baseId, { t: "base", total: before, active: false, turnStart: before, awaiting: [], ...(options.before?.calls?.length ? { calls: options.before.calls } : {}) }, { id: documentId, create: true }),
      ...body,
    ];
    for (const requestId of requests) writes.push({
      type: "submission",
      value: { id: ids[nextId++] as never, conversationId: SESSION_CONVERSATION_ID, requestId, type: "input", status: "unanswered", reason: "legacy_import", detail: "Request already recorded in the history this session started with." },
    });
    await storage.commit(writes, () => {}, context);
    // The commit is atomic: reading back its marker confirms it landed.
    const landed = await loadSeedMarker(storage, context);
    if (!landed || !same(landed, metadata)) throw new SeedConflict("the persisted seed marker differs from the source");
    return { ...metadata, status: "seeded" as const };
  });
  lines.set(storage, run);
  try { return await run; }
  finally { if (lines.get(storage) === run) lines.delete(storage); }
}
