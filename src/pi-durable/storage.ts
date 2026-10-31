/*
 * Storage semantics adapted from @earendil-works/pi-durable 1.3.0 (MIT).
 * Copyright (c) 2025 Mario Zechner. Full notice: ../../third-party/pi-durable-LICENSE.txt.
 */
import { chmod, mkdir, open as openFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";
// The supported runtime is Node >=22.21; use a narrow bridge while other packages still use Node 20 declarations.
type ReadonlySqliteDatabase = { prepare(sql: string): { all(...params: (string | number | null)[]): unknown[] }; close(): void };
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
    DatabaseSync: new (path: string, options: { readOnly: true }) => ReadonlySqliteDatabase;
};
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { validKey } from "../../shared/storage.ts";
import { LostClaim, underClaim, type Claim } from "../ownership.ts";
import { databaseRetryable, databaseUnavailable, transaction, type Db, type Sql } from "../db.ts";
import { clock } from "../node-context.ts";
import { timedStorage } from "../metrics.ts";
import type { SystemMessage } from "@earendil-works/pi-ai";

import type { Context, JsonValue } from "@earendil-works/chord";
import { apply, type Op } from "@earendil-works/chord/delta";
import { StorageRequestError } from "@earendil-works/pi-durable";
import { placeEntries, type Placement } from "./ordinals.ts";
import { SEED_MARKER_KIND } from "./seed.ts";

import type {
	CommitResult,
	ConversationId,
	ConversationQuery,
	ConversationRecord,
	Cursor,
	DocumentAddress,
	DocumentContent,
	DocumentCreate,
	DocumentId,
	DocumentPoint,
	DocumentQuery,
	DocumentRecord,
	EntryId,
	EntryQuery,
	EntryRecord,
	Id,
	JsonObject,
	Page,
	ScanOrder,
	Seq,
	Storage,
	StorageWrite,
	StoredDocument,
	SubmissionId,
	SubmissionQuery,
	SubmissionRecord,
	TaskId,
	TaskQuery,
	TaskRecord,
} from "@earendil-works/pi-durable";

/** One batch through `Storage.commit`, for a writer outside a Session; a refusal throws. */
export async function commitBatch(storage: Pick<Storage, "commit">, writes: readonly StorageWrite[], context: Context): Promise<void> {
    const result = await storage.commit([writes], () => {}, context);
    if (result.stored === 0) throw result.refused;
}

/** `storage` for a Harness or Session whose close leaves it open: its caller owns it. */
export const keepingOpen = (storage: Storage): Storage => new Proxy(storage, { get(target, key) {
    if (key === "close") return async () => {};
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
} });

/** A batch Durable's own checks (global IDs, document actions, copy sources) refuse: nothing of it is stored. */
class Refused {
    readonly error: unknown;
    constructor(error: unknown) { this.error = error; }
}

const TABLES = {
    durableMetadata: "pi_durable_metadata", recordIds: "pi_durable_record_ids",
    conversations: "pi_durable_conversations", entries: "pi_durable_entries",
    tasks: "pi_durable_tasks", submissions: "pi_durable_submissions",
    documents: "pi_durable_documents", documentRevisions: "pi_durable_document_revisions",
} as const;
type PgSchema = { tables: typeof TABLES };
export type PiCommitEffect = (entry: EntryRecord, sql?: Sql) => Promise<void>;

/** A seed copies history, including its original usage. None of its entries incurred new spend. */
async function commitEffects(writes: readonly StorageWrite[], committing?: PiCommitEffect, sql?: Sql): Promise<void> {
    // Inspect the batch itself so this also holds across the host process boundary and on retries.
    if (!committing || writes.some(write => write.type === "entry" && write.value.kind === SEED_MARKER_KIND)) return;
    for (const write of writes) if (write.type === "entry") await committing(write.value, sql);
}

type PgExecutor = {
    sql: Sql;
    get<T>(query: string, ...params: unknown[]): Promise<T | undefined>;
    all<T>(query: string, ...params: unknown[]): Promise<T[]>;
    run(query: string, ...params: unknown[]): Promise<void>;
};
/**
 * `transaction(work, advance)` locks the session's metadata row by taking the next commit sequence: `metadata.next_seq`
 * is then the transaction's own, and `next_id` is at least `advance.nextId`. Without `advance` it only locks the row.
 */
type PgDatabase = PgExecutor & { retryMs: number; slowAll<T>(timeoutMs: number, query: string, ...params: unknown[]): Promise<T[]>; transaction<T>(work: (sql: PgExecutor, metadata: MetadataRow | undefined) => Promise<T>, advance?: { nextId: number }): Promise<T>; close(): Promise<void> };
/**
 * Run `work` again while the database is unreachable (a failover, a network fault), for up to `retryMs`, as the log tail
 * repeats its appends. `settled`, given the failure, says whether the work landed anyway (its answer was lost).
 */
async function whileUnavailable<T>(retryMs: number, work: () => Promise<T>, settled?: () => Promise<{ value: T } | undefined>): Promise<T> {
    const deadline = Date.now() + retryMs;
    for (let delay = 100; ; delay = Math.min(delay * 2, 2_000)) {
        try { return await work(); }
        catch (error) {
            // Unreachable, or a statement the server gave up on (a timeout, a deadlock): nothing of it was kept.
            if (!(databaseUnavailable(error) || databaseRetryable(error)) || Date.now() + delay > deadline) throw error;
            await clock().sleep(delay);
            const landed = await whileUnavailable(Math.max(0, deadline - Date.now()), async () => settled?.());
            if (landed) return landed.value;
        }
    }
}

function postgresDatabase(db: Db, sessionId: string, claim?: Claim, retryMs = 0): PgDatabase {
    const executor = (sql: Sql): PgExecutor => {
        const query = (text: string, params: unknown[]) => {
            let n = 1;
            return sql.query(text.replace(/\?/g, () => `$${++n}`), [sessionId, ...params]);
        };
        return {
            sql,
            get: async <T>(text: string, ...params: unknown[]) => (await query(text, params)).rows[0] as T | undefined,
            all: async <T>(text: string, ...params: unknown[]) => (await query(text, params)).rows as T[],
            run: async (text: string, ...params: unknown[]) => { await query(text, params); },
        };
    };
    const pool = executor(db);
    return {
        // Reads change nothing: one the database did not answer is asked again.
        sql: db,
        get: (text, ...params) => timedStorage(() => whileUnavailable(retryMs, () => pool.get(text, ...params))),
        all: (text, ...params) => timedStorage(() => whileUnavailable(retryMs, () => pool.all(text, ...params))),
        run: (text, ...params) => timedStorage(() => whileUnavailable(retryMs, () => pool.run(text, ...params))),
        retryMs,
        // A read that may outlast the pool's query timeout: the server ends it at `timeoutMs` (statement_timeout), and
        // the client waits a little past that for its answer, so a read we gave up on never keeps scanning. Never run
        // again: a second attempt would only scan as long.
        slowAll: <T>(timeoutMs: number, text: string, ...params: unknown[]) => timedStorage(() => transaction(db, async sql => {
            await sql.query(`set local statement_timeout = ${Math.floor(timeoutMs)}`);
            let n = 1;
            const config = { text: text.replace(/\?/g, () => `$${++n}`), values: [sessionId, ...params], query_timeout: timeoutMs + 5_000 };
            return (await (sql as unknown as { query(config: { text: string; values: unknown[]; query_timeout: number }): Promise<{ rows: T[] }> }).query(config)).rows;
        }, { rerun: false })),
        transaction: (work, advance) => timedStorage(() => transaction(db, async sql => {
            // Serializes mutations by session, including separate handles on this node. One statement checks the
            // claim (its ownership row FOR SHARE, as underClaim does: a takeover waits until this commits, and a claim
            // no longer current writes nothing), locks and reads the metadata row (a commit's also takes its
            // sequence) and turns synchronous commit on for this transaction.
            const lock = advance === undefined
                ? "select next_id, next_seq, history_next, history_last_id, set_config('synchronous_commit', 'on', true) from pi_durable_metadata where session_id = $1 for update"
                : "update pi_durable_metadata set next_id = greatest(next_id::bigint, $2::bigint)::text, next_seq = next_seq + 1 where session_id = $1 returning next_id, next_seq - 1 as next_seq, history_next, history_last_id, set_config('synchronous_commit', 'on', true)";
            const params: unknown[] = advance === undefined ? [sessionId] : [sessionId, advance.nextId];
            let metadata: MetadataRow | undefined;
            if (!claim) metadata = (await sql.query<MetadataRow>(lock, params)).rows[0];
            else {
                const at = params.length;
                // The claim's row is locked before the metadata's: `m` runs only when `owner` holds a row.
                const row = (await sql.query<MetadataRow & { held: boolean; next_id: string | null }>(
                    `with owner as materialized (select 1 from actor_owners where actor = $${at + 1} and session = $${at + 2} and epoch = $${at + 3} for share),
                     m as (${lock.replace(" where session_id = $1", " where session_id = $1 and exists (select from owner)")})
                     select exists (select from owner) as held, m.* from (select 1) one left join m on true`,
                    [...params, claim.actor, claim.session, claim.epoch])).rows[0];
                if (!row.held) throw new LostClaim(claim.actor);
                metadata = row.next_id === null ? undefined : row;
            }
            // No row (the session's first open creates it): set_config did not run, so turn synchronous commit on here.
            if (!metadata) await sql.query("set local synchronous_commit = on");
            return work(executor(sql), metadata);
        })),
        async close() {}, // The supervisor, not an individual Pi session, owns the pool.
    };
}
/** `executor`, noting in `calls` when one of its statements fails: the database's failure, not a check's own. */
function watchedExecutor(executor: PgExecutor, calls: { failed: boolean }): PgExecutor {
    const watched = async <T>(call: Promise<T>): Promise<T> => {
        try { return await call; }
        catch (error) { calls.failed = true; throw error; }
    };
    return {
        sql: executor.sql,
        get: (text, ...params) => watched(executor.get(text, ...params)),
        all: (text, ...params) => watched(executor.all(text, ...params)),
        run: (text, ...params) => watched(executor.run(text, ...params)),
    };
}

/** About as much as one statement of `Statements` carries: the bound each entries insert keeps for imports. */
const STATEMENT_BYTES = 4 * 1024 * 1024;
/**
 * A commit's writes, sent as few statements as they fit in: each write a data-modifying `WITH` query of one statement,
 * so a batch costs one round trip to the database instead of one per table. All of a statement's parts see the
 * database as it was before it, so a part must not depend on another's rows (an insert after a delete of the same
 * rows is fine: the delete never sees it).
 */
class Statements {
    private parts: { text: string; params: unknown[] }[] = [];
    private bytes = 0;
    private readonly executor: PgExecutor;
    constructor(executor: PgExecutor) { this.executor = executor; }

    /** Adds a write of about `bytes`, first sending those before it when together they would pass `STATEMENT_BYTES`. */
    async add(text: string, params: unknown[], bytes = 0): Promise<void> {
        if (this.parts.length && this.bytes + bytes > STATEMENT_BYTES) await this.flush();
        this.parts.push({ text, params });
        this.bytes += bytes;
    }

    async flush(): Promise<void> {
        const parts = this.parts;
        this.parts = []; this.bytes = 0;
        if (!parts.length) return;
        const text = parts.length === 1 ? parts[0].text
            : `WITH ${parts.map((part, index) => `w${index} AS (${part.text})`).join(", ")} SELECT 1`;
        await this.executor.run(text, ...parts.flatMap(part => part.params));
    }
}

/** IDs `mintId` reserves at a time. */
const ID_BLOCK = 256;
const idFromNumber = <I extends Id<string>>(value: number): I => {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid durable ID: ${value}`);
    return value as I;
};
const seqFromNumber = (value: number): Seq => idFromNumber(value) as unknown as Seq;
function validateReservationCount(count: unknown): asserts count is number {
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 1 || count > 1_000_000) throw new Error("Invalid durable ID reservation count");
}

type ScanStart = { order: ScanOrder; after: number | undefined };
function scanStart(requested: ScanOrder | undefined, cursor: Cursor | undefined, fallback: ScanOrder): ScanStart {
    if (requested !== undefined && requested !== "ascending" && requested !== "descending") throw new StorageRequestError("Invalid scan order");
    if (!cursor) return { order: requested ?? fallback, after: undefined };
    if (typeof cursor.after !== "number" || !Number.isSafeInteger(cursor.after)) throw new StorageRequestError("Invalid storage cursor");
    const order = cursor.order ?? fallback;
    if (order !== "ascending" && order !== "descending") throw new StorageRequestError("Invalid storage cursor");
    if (requested !== undefined && requested !== order) throw new StorageRequestError("Storage cursor order differs from query");
    return { order, after: cursor.after };
}
const nextCursor = (id: Id<string>, order: ScanOrder): Cursor => ({ after: id, order });

/** `directory` is the owning session directory; `db` selects shared indexed storage. */
export async function openPiStorage(options: { sessionId: string; directory: string; db?: Db; claim?: Claim; committing?: PiCommitEffect; retryMs?: number }): Promise<Storage> {
    validKey(options.sessionId);
    if (options.db) return PostgresPiStorage.open(options.db, options.sessionId, options.claim, options.committing, options.retryMs);
    if (options.claim) throw new Error("A distributed Pi session needs Postgres storage");
    await mkdir(options.directory, { recursive: true, mode: 0o700 });
    const path = join(options.directory, "pi-durable.sqlite");
    // Create privately before SQLite creates its WAL; SQLite gives the WAL the database's mode.
    const file = await openFile(path, "a", 0o600);
    await file.close();
    await chmod(path, 0o600);
    const database = await openNodeSqliteDatabase(path);
    try {
        // Upstream defaults to NORMAL. FULL syncs the WAL before acknowledging each commit,
        // preserving our durable-before-publish contract across host power loss.
        await database.exec("PRAGMA synchronous = FULL");
        const storage = await SqliteStorage.open(database);
        const range = `
                WITH RECURSIVE lineage AS (
                    SELECT id, record, 9223372036854775807 AS upper_id, 0 AS depth FROM conversations WHERE id = ?
                    UNION ALL
                    SELECT c.id, c.record, min(l.upper_id, json_extract(l.record, '$.parent.at')), l.depth + 1
                    FROM lineage l JOIN conversations c ON c.id = json_extract(l.record, '$.parent.conversationId')
                ), marker AS (
                    SELECT e.id, e.head FROM lineage l JOIN entries e ON e.conversation_id = l.id
                    WHERE e.head IS NOT NULL AND e.id <= l.upper_id ORDER BY l.depth, e.id DESC LIMIT 1
                )`;
        const sized = storage as unknown as Storage & ContextRangeSizer & ContextSystemReader;
        sized.contextRangeSize = async conversationId => {
            const row = await database.get<{ entries: number; bytes: number }>(`${range}
                SELECT count(*) AS entries, coalesce(sum(length(CAST(e.record AS BLOB))), 0) AS bytes
                FROM lineage l JOIN entries e ON e.conversation_id = l.id
                AND e.id >= coalesce((SELECT head FROM marker), 0) AND e.id <= l.upper_id`, conversationId);
            return { entries: Number(row!.entries), bytes: Number(row!.bytes) };
        };
        sized.contextSystemRows = async conversationId => {
            const rows = await database.all<{ id: number; head: number | null; marker: number | null; system: string; omits: string; replaces: string }>(`${range}
                SELECT e.id, e.head, (SELECT id FROM marker) AS marker,
                  (SELECT json_group_array(json(m.value)) FROM json_each(e.record, '$.model') m WHERE json_extract(m.value, '$.role') = 'system') AS system,
                  (SELECT json_group_array(json_extract(x.value, '$.target')) FROM json_each(e.record, '$.edits') x WHERE json_extract(x.value, '$.action') = 'omit') AS omits,
                  (SELECT json_group_array(json_extract(x.value, '$.target')) FROM json_each(e.record, '$.edits') x WHERE json_extract(x.value, '$.action') = 'replace') AS replaces
                FROM lineage l JOIN entries e ON e.conversation_id = l.id
                AND e.id >= coalesce((SELECT head FROM marker), 0) AND e.id <= l.upper_id
                WHERE instr(e.record, '"role":"system"') > 0 OR instr(e.record, '"edits":[') > 0 ORDER BY e.id`, conversationId);
            return rows.map(row => ({ id: Number(row.id), head: row.head ?? undefined, marker: row.marker ?? undefined,
                system: JSON.parse(row.system), omits: (JSON.parse(row.omits) as unknown[]).map(Number), replaces: (JSON.parse(row.replaces) as unknown[]).map(Number) }));
        };
        if (!options.committing) return storage;
        const inner = { commit: storage.commit.bind(storage) };
        // A batch at a time: each batch's effects come before it is stored, and a refusal leaves those after it without any.
        storage.commit = async (batches, receive, context) => {
            const seqs: Seq[] = [];
            try {
                for (const writes of batches) {
                    await commitEffects(writes, options.committing);
                    const result = await inner.commit([writes], (_index, seq) => { seqs.push(seq); }, context);
                    if (result.stored === 0) return { stored: seqs.length, refused: result.refused };
                }
                return { stored: seqs.length };
            } finally { seqs.forEach((seq, index) => receive(index, seq)); }
        };
        return storage;
    } catch (error) { await database.close().catch(() => {}); throw error; }
}

/** Probe without opening storage or creating a namespace, used to find migrated sessions on rollback. */
export async function hasPiStorage(options: { sessionId: string; directory: string; db?: Db }): Promise<boolean> {
    validKey(options.sessionId);
    if (options.db) return !!(await options.db.query("select session_id from pi_durable_metadata where session_id = $1", [options.sessionId])).rowCount;
    try { return (await stat(join(options.directory, "pi-durable.sqlite"))).isFile(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

export type PiJournalReader = Pick<Storage, "scanEntries" | "close">;

/** A journal-only reader: no namespace creation, migrations, WAL checkpoint, ID reservation, or claim acquisition. */
export async function openPiJournalReader(options: { sessionId: string; directory: string; db?: Db }): Promise<PiJournalReader | undefined> {
    if (!await hasPiStorage(options)) return undefined;
    let closed = false;
    const sqlite = options.db ? undefined : new DatabaseSync(join(options.directory, "pi-durable.sqlite"), { readOnly: true });
    const shared = !!options.db;
    const select = async <T>(text: string, params: unknown[]): Promise<T[]> => {
        if (closed) throw new Error("Pi journal reader is closed");
        if (options.db) {
            let index = 1;
            return (await options.db.query<T>(text.replace(/\?/g, () => `$${++index}`), [options.sessionId, ...params])).rows;
        }
        return sqlite!.prepare(text).all(...params as (string | number | null)[]) as T[];
    };
    const table = (name: "conversations" | "entries") => shared ? `pi_durable_${name}` : name;
    const namespace = shared ? "session_id = $1 AND " : "";
    let root: JsonRow[];
    try { root = await select<JsonRow>(`select record from ${table("conversations")} where ${namespace}id = ?`, [1]); }
    catch (error) {
        // A session file its first open has created but not yet given a schema holds no journal yet.
        if (sqlite && /no such table/.test(String((error as Error).message))) { sqlite.close(); return undefined; }
        sqlite?.close(); throw error;
    }
    if (!root.length) { sqlite?.close(); return undefined; }
    const conversation = async (id: ConversationId): Promise<ConversationRecord> => {
        const row = (await select<JsonRow>(`select record from ${table("conversations")} where ${namespace}id = ?`, [id]))[0];
        if (!row) throw new StorageRequestError(`Unknown conversation: ${id}`);
        return parseJson<ConversationRecord>(row.record);
    };
    return {
        async scanEntries(query, limit, cursor) {
            const { order, after } = scanStart(query.order, cursor, "descending");
            const segments: { conversationId: ConversationId; upper?: number }[] = [];
            let current = await conversation(query.conversationId);
            let upper: number | undefined = query.maxEntryId;
            // Conversation ancestry is immutable. Every segment stays capped at its original fork point.
            while (true) {
                segments.push({ conversationId: current.id, upper });
                if (!current.parent) break;
                upper = Math.min(upper ?? Number.MAX_SAFE_INTEGER, current.parent.at);
                if (query.minEntryId !== undefined && upper < query.minEntryId) break;
                current = await conversation(current.parent.conversationId);
            }
            const items: EntryRecord[] = [];
            for (const segment of order === "ascending" ? segments.reverse() : segments) {
                const clauses = ["conversation_id = ?"];
                const params: unknown[] = [segment.conversationId];
                let lower = query.minEntryId, maximum = segment.upper;
                if (after !== undefined) {
                    if (order === "ascending") lower = Math.max(lower ?? after + 1, after + 1) as EntryId;
                    else maximum = Math.min(maximum ?? Number.MAX_SAFE_INTEGER, after - 1);
                }
                if (lower !== undefined) { clauses.push("id >= ?"); params.push(lower); }
                if (maximum !== undefined) { clauses.push("id <= ?"); params.push(maximum); }
                params.push(limit + 1 - items.length);
                const rows = await select<JsonRow>(`select record from ${table("entries")} where ${namespace}${clauses.join(" AND ")} order by id ${order === "ascending" ? "asc" : "desc"} limit ?`, params);
                items.push(...rows.map(row => parseJson<EntryRecord>(row.record)));
                if (items.length > limit) break;
            }
            return page(items, limit, order);
        },
        async close() { if (!closed) { closed = true; sqlite?.close(); } },
    };
}

export async function purgePiStorage(db: Db, sessionId: string, claim?: Claim): Promise<void> {
    await underClaim(db, claim, sql => deletePiStorage(sql, sessionId));
}

/** Delete in the caller's existing fenced transaction, alongside its session tombstone and pins. */
export async function deletePiStorage(sql: Sql, sessionId: string): Promise<void> {
    for (const table of Object.values(TABLES).reverse()) await sql.query(`delete from ${table} where session_id = $1`, [sessionId]);
}

const STORAGE_METHODS = ["commit", "mintId", "mintIds", "entryIds", "contextRangeSize", "conversation", "scanConversations", "entry", "findLatestHeadMarker", "scanEntries", "task", "scanTasks", "submission", "scanSubmissions", "submissionByRequest", "findDocument", "document", "scanDocuments", "close"] as const;
export type PiStorageMethod = typeof STORAGE_METHODS[number];
export type PiStorageRequest = { method: PiStorageMethod; args: unknown[]; undefinedArgs?: number[] };
/** The supervisor is the only process that holds the database/file handle and its claim. */
export async function storageRequest(storage: Storage, request: PiStorageRequest): Promise<unknown> {
    if (!STORAGE_METHODS.includes(request.method)) throw new Error("Unknown Pi storage method");
    if (request.method === "mintIds") {
        const count = request.args[0];
        validateReservationCount(count);
        const bulk = storage as Storage & { mintIds?(count: number): Promise<number[]> };
        if (bulk.mintIds) return bulk.mintIds(count);
        const ids: number[] = [];
        for (let index = 0; index < count; index++) ids.push(await storage.mintId());
        return ids;
    }
    if (request.method === "commit") {
        const [batches] = request.args;
        if (!Array.isArray(batches) || !batches.every(Array.isArray)) throw new Error("Invalid Pi storage argument");
        // The receipts cannot cross the process boundary: the child takes them once this answers (when it rejects, none:
        // its Session fails, and a reopen finds what was stored).
        const seqs: Seq[] = [];
        const result = await storage.commit(batches as StorageWrite[][], (_index, seq) => { seqs.push(seq); }, BACKGROUND_CONTEXT);
        return { seqs, ...result.stored < batches.length ? { refused: result.refused instanceof Error ? result.refused.message : String(result.refused) } : {} };
    }
    if (request.method === "contextRangeSize") {
        const [conversationId] = request.args as number[];
        if (!Number.isSafeInteger(conversationId)) throw new Error("Invalid Pi storage argument");
        return contextRangeSize(storage, conversationId as ConversationId);
    }
    if (request.method === "entryIds") {
        const [conversationId, minId, maxId] = request.args as number[];
        if (![conversationId, minId, maxId].every(Number.isSafeInteger)) throw new Error("Invalid Pi storage argument");
        return entryIds(storage, conversationId as ConversationId, minId, maxId);
    }
    const method = storage[request.method] as (...args: unknown[]) => Promise<unknown>;
    const args = [...request.args];
    for (const index of request.undefinedArgs ?? []) {
        if (!Number.isSafeInteger(index) || index < 0 || index >= args.length) throw new Error("Invalid Pi storage argument");
        args[index] = undefined;
    }
    return method.apply(storage, request.method === "mintId" ? [] : [...args, BACKGROUND_CONTEXT]);
}
/** Serialized bytes in the visible range Pi retains, including entries hidden from model messages. */
export type ContextRangeSize = { entries: number; bytes: number };
export type ContextRangeSizer = { contextRangeSize(conversationId: ConversationId): Promise<ContextRangeSize> };
/** No scan fallback: a guard must not load the very range it is protecting against. */
export async function contextRangeSize(storage: Storage, conversationId: ConversationId): Promise<ContextRangeSize> {
    const sized = storage as Storage & Partial<ContextRangeSizer>;
    if (!sized.contextRangeSize) throw new Error("Pi storage cannot measure its context range");
    return sized.contextRangeSize(conversationId);
}

/**
 * A range entry whose record names a system message or has edits: its system messages (`system`, in order), the
 * entries its edits omit (`omits`) and replace (`replaces`), whether it is a head marker (`head`), and the range's
 * newest marker (`marker`).
 */
export type ContextSystemRow = { id: number; head?: number; marker?: number; system: SystemMessage[]; omits: number[]; replaces: number[] };
/** How long the database may scan a context's records for its system messages before it gives up (statement_timeout). */
export const CONTEXT_SYSTEM_TIMEOUT_MS = 120_000;
export type ContextSystemReader = { contextSystemRows(conversationId: ConversationId): Promise<ContextSystemRow[]> };
/** The context's system messages, read without loading the range: none of its other messages leave the database. */
export async function contextSystemRows(storage: Storage, conversationId: ConversationId): Promise<ContextSystemRow[]> {
    const reader = storage as Storage & Partial<ContextSystemReader>;
    if (!reader.contextSystemRows) throw new Error("Pi storage cannot read its context's system messages");
    return reader.contextSystemRows(conversationId);
}

/** A storage that lists a conversation's entry IDs without reading their records (PostgresPiStorage). */
export type EntryIdLister = { entryIds(conversationId: ConversationId, minId: number, maxId: number): Promise<number[]> };

/**
 * The IDs of a conversation's own entries from `minId` to `maxId`, in order: without their records where the storage
 * lists them (Postgres), else read from a scan.
 */
export async function entryIds(storage: Pick<Storage, "scanEntries"> & Partial<EntryIdLister>, conversationId: ConversationId, minId: number, maxId: number): Promise<number[]> {
    if (storage.entryIds) return storage.entryIds(conversationId, minId, maxId);
    const ids: number[] = [];
    let cursor;
    do {
        const page = await storage.scanEntries({ conversationId, order: "ascending", minEntryId: minId as EntryId, maxEntryId: maxId as EntryId }, 256, cursor, BACKGROUND_CONTEXT);
        ids.push(...page.items.map(entry => entry.id));
        cursor = page.next;
    } while (cursor !== undefined);
    return ids;
}

/** Contexts are process-local; the owner attaches its background context to each dispatched operation. */
export function remotePiStorage(request: (request: PiStorageRequest) => Promise<unknown>): Storage {
    const methods: Record<string, unknown> = Object.fromEntries(STORAGE_METHODS.map(method => [method, (...args: unknown[]) => {
        if (method !== "mintId" && method !== "mintIds" && method !== "entryIds" && method !== "contextRangeSize") args.pop();
        const undefinedArgs = args.flatMap((value, index) => value === undefined ? [index] : []);
        return request({ method, args, ...(undefinedArgs.length ? { undefinedArgs } : {}) });
    }]));
    // The batches are durable once the owner answers: its receipts come then, before this resolves.
    methods.commit = async (batches: readonly (readonly StorageWrite[])[], receive: (index: number, seq: Seq) => void): Promise<CommitResult> => {
        const { seqs, refused } = await request({ method: "commit", args: [batches] }) as { seqs: Seq[]; refused?: string };
        seqs.forEach((seq, index) => receive(index, seq));
        return refused === undefined ? { stored: seqs.length } : { stored: seqs.length, refused: new Error(refused) };
    };
    return methods as unknown as Storage;
}

type StoredTask = TaskRecord<JsonValue, JsonValue, JsonValue>;
type TableName = "conversation" | "entry" | "task" | "submission" | "document";
type JsonRow = { readonly record: string };
type EntryJsonRow = { readonly record: string; readonly commit_seq: number };
type RevisionRow = {
	readonly seq: number;
	readonly kind: DocumentContent["kind"];
	readonly version: number;
	readonly content: string;
};
type IdRow = { readonly id: number };
/** `history_next` and `history_last_id`: the session's history ordinals (ordinals.ts), null until placed. */
type MetadataRow = { readonly next_id: string; readonly next_seq: number; readonly history_next?: number | null; readonly history_last_id?: string | null };
type DocumentAction = {
	create?: DocumentCreate;
	copy?: Extract<StorageWrite, { readonly type: "document.copy" }>["source"];
	content?: DocumentContent;
	retire: boolean;
};
type ScopeColumns = {
	readonly scopeKind: DocumentRecord["scope"]["kind"];
	readonly ownerId: number;
};

const parseJson = <T>(value: string): T => JSON.parse(value) as T;
const encodeJson = (value: unknown): string => JSON.stringify(value) as string;
// Some SQLite bindings replace lone UTF-16 surrogates. JSON encoding keeps indexed identities lossless.
const encodeIndexedString = (value: string): string => JSON.stringify(value);

const cursorId = <I extends Id<string>>(cursor: Cursor | undefined): I | undefined => {
	const after = cursor?.after;
	if (after === undefined) return undefined;
	if (typeof after !== "number" || !Number.isSafeInteger(after))
		throw new StorageRequestError("Invalid storage cursor");
	return idFromNumber<I>(after);
};

const page = <T extends { readonly id: Id<string> }>(
	values: readonly T[],
	limit: number,
	order: ScanOrder = "ascending",
): Page<T, Cursor> => {
	const items = values.slice(0, limit);
	if (values.length <= limit) return { items };
	return { items, next: nextCursor(items.at(-1)!.id, order) };
};

/** The ID condition, its parameter, and the `ORDER BY` direction of a table scan. */
const scanSql = (start: ScanStart): { readonly clause: string; readonly param: number; readonly direction: string } =>
	start.order === "ascending"
		? { clause: "id > ?", param: start.after ?? -1, direction: "ASC" }
		: { clause: "id < ?", param: start.after ?? Number.MAX_SAFE_INTEGER, direction: "DESC" };

const scopeColumns = (scope: DocumentRecord["scope"]): ScopeColumns => {
	switch (scope.kind) {
		case "session":
			return { scopeKind: "session", ownerId: 0 };
		case "conversation":
			return { scopeKind: "conversation", ownerId: scope.conversationId };
		case "task":
			return { scopeKind: "task", ownerId: scope.taskId };
	}
};

const addressParts = (address: DocumentAddress | DocumentCreate | DocumentRecord) => {
	const scope = scopeColumns(address.scope);
	return {
		kind: encodeIndexedString(address.kind),
		...scope,
		family: address.key === undefined ? 0 : 1,
		keyValue: encodeIndexedString(address.key ?? ""),
	};
};

const addressKey = (address: DocumentAddress | DocumentCreate | DocumentRecord): string => {
	const parts = addressParts(address);
	return JSON.stringify([parts.kind, parts.scopeKind, parts.ownerId, parts.family, parts.keyValue]);
};

const isAliveAt = (record: DocumentRecord, at: DocumentPoint): boolean => {
	if (at === "current") return record.retiredAt === undefined;
	return record.createdAt <= at && (record.retiredAt === undefined || at < record.retiredAt);
};

const isCurrentOnly = (record: DocumentRecord): boolean =>
	record.scope.kind !== "conversation" || record.history === "latest";

const writeId = (write: StorageWrite): Id<string> | undefined => {
	switch (write.type) {
		case "conversation":
		case "entry":
		case "task":
		case "submission":
			return write.value.id;
		case "document.create":
		case "document.copy":
			return write.record.id;
		case "document.change":
		case "document.retire":
			return undefined;
	}
};

/** Pi 1.3 indexed storage semantics adapted to shared, namespaced Postgres tables.
 * No transcript replay or in-memory archive is needed to reopen the active context.
 */
export class PostgresPiStorage implements Storage {
	private readonly db: PgDatabase;
	private readonly schema: PgSchema;
	private nextId: number;
	/** IDs reserved in the metadata row but not handed out yet: `mintId` takes them in order, without a transaction. */
	private block = { next: 0, end: 0 };
	private reserving: Promise<void> | undefined;
	private closed = false;
	private closing: Promise<void> | undefined;
	private admittedReads = 0;
	private readsDrained: (() => void) | undefined;

    private committing?: PiCommitEffect;
	private constructor(db: PgDatabase, schema: PgSchema, nextId: number, committing?: PiCommitEffect) {
        this.committing = committing;
		this.db = db;
		this.schema = schema;
		this.nextId = nextId;
	}

	static async open(db: Db, sessionId: string, claim?: Claim, committing?: PiCommitEffect, retryMs = 0): Promise<PostgresPiStorage> {
        const database = postgresDatabase(db, sessionId, claim, retryMs);
        await database.transaction(async sql => {
            // A new session's history is placed from its start (ordinals.ts); one from before ordinals waits for its fill.
            await sql.run(`INSERT INTO ${TABLES.durableMetadata} (session_id, singleton, next_id, next_seq, history_next, history_last_id) VALUES ($1, 1, '2', 1, 0, 0) ON CONFLICT(session_id) DO NOTHING`);
        });
        const metadata = await database.get<MetadataRow>(`SELECT next_id, next_seq FROM ${TABLES.durableMetadata} WHERE session_id = $1 AND singleton = 1`);
        if (!metadata) throw new Error("Durable Postgres metadata is missing");
        return new PostgresPiStorage(database, { tables: TABLES }, Number(metadata.next_id), committing);
    }

	/**
	 * Each batch in a transaction of its own, in order, as the one commit it is. The receipts come once the batches that
	 * were stored are (also after a lost answer that landed), before this settles; a batch that fails rejects the call
	 * with the earlier ones' receipts given, a refused one resolves with its refusal.
	 */
	async commit(batches: readonly (readonly StorageWrite[])[], receive: (index: number, seq: Seq) => void, _context?: Context): Promise<CommitResult> {
		this.assertOpen();
		const seqs: Seq[] = [];
		try {
			for (const writes of batches) seqs.push(await this.commitBatch(writes));
			return { stored: seqs.length };
		} catch (error) {
			if (error instanceof Refused) return { stored: seqs.length, refused: error.error };
			throw error;
		} finally {
			seqs.forEach((seq, index) => receive(index, seq));
		}
	}

	private async commitBatch(writes: readonly StorageWrite[]): Promise<Seq> {
		let documentActions: Map<DocumentId, DocumentAction>;
		try { documentActions = this.prepareDocumentActions(writes); }
		catch (error) { throw new Refused(error); }
		const candidateNextId = this.candidateNextId(writes);
		// The sequence the latest attempt took and the IDs it found unclaimed: a commit whose answer was lost is found by what it wrote (`landed`).
		let attempted: { seq: Seq; created?: Id<string>[] } | undefined;
		// Each statement is a round trip to the database, and a turn's every step commits: the metadata lock takes the
		// sequence, one read checks the batch's IDs and documents, and one statement writes it all.
		const seq = await whileUnavailable(this.db.retryMs, () => this.db.transaction(async (transaction, metadata) => {
			if (metadata === undefined) throw new Error("Durable Postgres metadata is missing");
			const committedSeq = seqFromNumber(Number(metadata.next_seq));
			attempted = { seq: committedSeq };
			// Whether a statement of the checks failed: then what they throw is an unknown outcome, not a refusal.
			const checks = { failed: false };
			const checked = watchedExecutor(transaction, checks);
			const stored = await this.readCommitState(transaction, writes, documentActions);
			attempted.created = writes.flatMap(write => { const id = writeId(write); return id === undefined || stored.ids.has(id) ? [] : [id]; });
			let existing: Map<DocumentId, DocumentRecord>;
			try {
				this.checkGlobalIds(writes, stored.ids);
				existing = await this.checkDocumentActions(checked, documentActions, stored.documents);
			} catch (error) {
				if (checks.failed) throw error;
				throw new Refused(error);
			}
			// Each history entry's place (ordinals.ts): earlier rows moved now, the batch's own with its insert.
			const ordinals = metadata.history_next === undefined || metadata.history_next === null ? undefined
				: await placeEntries(transaction, writes, { next: metadata.history_next, lastId: Number(metadata.history_last_id ?? 0) });
			const statements = new Statements(transaction);
			await this.applyTableWrites(statements, writes, committedSeq, ordinals?.placements);
			if (ordinals) await statements.add(`UPDATE ${this.schema.tables.durableMetadata} SET history_next = ?, history_last_id = ? WHERE session_id = $1`, [ordinals.state.next, ordinals.state.lastId]);
			const after = await this.applyDocumentActions(transaction, statements, documentActions, committedSeq, existing);
			await statements.flush();
			for (const id of after) await transaction.run(`DELETE FROM ${this.schema.tables.documentRevisions} WHERE session_id = $1 AND document_id = ?`, id);
            await commitEffects(writes, this.committing, transaction.sql);
			return committedSeq;
		}, { nextId: candidateNextId }), async () => attempted?.created !== undefined && await this.landed(writes, attempted.created, attempted.seq) ? { value: attempted.seq } : undefined);
		this.nextId = Math.max(this.nextId, candidateNextId);
		return seq;
	}

	/**
	 * Whether a commit whose answer was lost landed at `seq`: a record it created exists (`created`, its IDs are its own; a
	 * record it only updated says nothing), or one of its documents has its revision or retirement at `seq`. Unsure (records
	 * updated alone), it did not: it runs again, and an update writes the same record again.
	 */
	private async landed(writes: readonly StorageWrite[], created: readonly Id<string>[], seq: Seq): Promise<boolean> {
		const id = created[0];
		if (id !== undefined) return !!await this.db.get(`SELECT 1 AS found FROM ${this.schema.tables.recordIds} WHERE session_id = $1 AND id = ?`, id);
		const change = writes.find(write => write.type === "document.change");
		if (change?.type === "document.change") return !!await this.db.get(`SELECT 1 AS found FROM ${this.schema.tables.documentRevisions} WHERE session_id = $1 AND document_id = ? AND seq = ?`, change.id, seq);
		const retire = writes.find(write => write.type === "document.retire");
		if (retire?.type !== "document.retire") return false;
		return !!await this.db.get(`SELECT 1 AS found FROM ${this.schema.tables.documents} WHERE session_id = $1 AND id = ? AND retired_at = ?`, retire.id, seq);
	}

	/**
	 * Hands out IDs from a block reserved in the metadata row (one fenced transaction per ID_BLOCK IDs, not per ID).
	 * The row holds the block's end before any of it is used, so a later holder of the session, here or on another node,
	 * starts past it and never reuses one; IDs this holder leaves unused are a gap. A block is dropped once an ID at or
	 * past its next one was stored or reserved here (a bulk reservation, a write with its own IDs), keeping each ID
	 * greater than every one minted or stored before.
	 */
	async mintId<I extends Id<string>>(): Promise<I> {
        this.assertOpen();
        while (this.block.next >= this.block.end || this.block.next < this.nextId) {
            this.reserving ??= this.reserve(ID_BLOCK).then(first => {
                this.block = { next: Math.max(first, this.nextId), end: first + ID_BLOCK };
            }).finally(() => { this.reserving = undefined; });
            await this.reserving;
            this.assertOpen();
        }
        const id = this.block.next++;
        this.nextId = id + 1;
        return id as I;
    }

    /** Optional Camel import extension: reserve a namespace-safe range with one durable fenced update. */
    async mintIds(count: number): Promise<number[]> {
        this.assertOpen();
        validateReservationCount(count);
        const first = await this.reserve(count);
        this.nextId = Math.max(this.nextId, first + count);
        return Array.from({ length: count }, (_, index) => first + index);
    }

    private async reserve(count: number): Promise<number> {
        // Run again when its answer is lost: IDs the lost attempt took are skipped, never reused.
        return whileUnavailable(this.db.retryMs, () => this.db.transaction(async sql => {
            const value = await sql.get<{ id: number }>(`UPDATE ${this.schema.tables.durableMetadata} SET next_id = (next_id::bigint + ?)::text WHERE session_id = $1 AND singleton = 1 RETURNING (next_id::bigint - ?) as id`, count, count);
            if (!value || !Number.isSafeInteger(value.id) || !Number.isSafeInteger(value.id + count - 1)) throw new Error("ID space is exhausted");
            return value.id;
        }));
    }

	async conversation(id: ConversationId, _context: Context): Promise<ConversationRecord | undefined> {
		this.assertOpen();
		const row = await this.db.get<JsonRow>(`SELECT record FROM ${this.schema.tables.conversations} WHERE session_id = $1 AND id = ?`, id);
		return row === undefined ? undefined : parseJson<ConversationRecord>(row.record);
	}

	async scanConversations(
		query: ConversationQuery,
		limit: number,
		cursor: Cursor | undefined,
		_context: Context,
	): Promise<Page<ConversationRecord, Cursor>> {
		this.assertOpen();
		const start = scanStart(query.order, cursor, "ascending");
		const scan = scanSql(start);
		const clauses = [scan.clause];
		const params: unknown[] = [scan.param];
		if (query.ownerConversationId !== undefined) {
			clauses.push("owner_conversation_id = ?");
			params.push(query.ownerConversationId);
		}
		if (query.ownerTaskId !== undefined) {
			clauses.push("owner_task_id = ?");
			params.push(query.ownerTaskId);
		}
		params.push(limit + 1);
		const rows = await this.db.all<JsonRow>(
			`SELECT record FROM ${this.schema.tables.conversations} WHERE session_id = $1 AND ${clauses.join(" AND ")} ORDER BY id ${scan.direction} LIMIT ?`,
			...params,
		);
		return page(
			rows.map((row) => parseJson<ConversationRecord>(row.record)),
			limit,
			start.order,
		);
	}

	entry(id: EntryId, context: Context): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined>;
	entry(
		conversationId: ConversationId,
		id: EntryId,
		context: Context,
	): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined>;
	entry(
		idOrConversationId: EntryId | ConversationId,
		idOrContext: EntryId | Context,
		context?: Context,
	): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined> {
		return this.admitRead(() => this.readEntry(idOrConversationId, idOrContext, context));
	}

	findLatestHeadMarker(
		conversationId: ConversationId,
		atOrBeforeEntryId: EntryId | undefined,
		_context: Context,
	): Promise<(EntryRecord & { readonly head: EntryId }) | undefined> {
		return this.admitRead(() => this.readLatestHeadMarker(conversationId, atOrBeforeEntryId));
	}

	scanEntries(
		query: EntryQuery,
		limit: number,
		cursor: Cursor | undefined,
		_context: Context,
	): Promise<Page<EntryRecord, Cursor>> {
		return this.admitRead(() => this.readEntries(query, limit, cursor));
	}

	private async readEntry(
		idOrConversationId: EntryId | ConversationId,
		idOrContext: EntryId | Context,
		context?: Context,
	): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined> {
		const id =
			context === undefined
				? idFromNumber<EntryId>(idOrConversationId)
				: typeof idOrContext === "number"
					? idFromNumber<EntryId>(idOrContext)
					: undefined;
		if (id === undefined) throw new StorageRequestError("Storage.entry() requires an entry ID");
		let conversation: ConversationRecord | undefined;
		let row: EntryJsonRow | undefined;
		if (context !== undefined) {
			// The conversation and the entry in one statement.
			const conversationId = idFromNumber<ConversationId>(idOrConversationId);
			const found = await this.db.get<{ conversation: string; record: string | null; commit_seq: number | null }>(
				`SELECT c.record AS conversation, e.record, e.commit_seq FROM ${this.schema.tables.conversations} c
					LEFT JOIN ${this.schema.tables.entries} e ON e.session_id = c.session_id AND e.id = ?
					WHERE c.session_id = $1 AND c.id = ?`,
				id,
				conversationId,
			);
			if (found === undefined) throw new StorageRequestError(`Unknown conversation: ${conversationId}`);
			conversation = parseJson<ConversationRecord>(found.conversation);
			row = found.record === null ? undefined : { record: found.record, commit_seq: found.commit_seq! };
		} else {
			row = await this.db.get<EntryJsonRow>(
				`SELECT record, commit_seq FROM ${this.schema.tables.entries} WHERE session_id = $1 AND id = ?`,
				id,
			);
		}
		if (row === undefined) return undefined;
		const entry = parseJson<EntryRecord>(row.record);
		if (conversation !== undefined) {
			let upperEntryId = Number.POSITIVE_INFINITY;
			while (conversation.id !== entry.conversationId) {
				if (conversation.parent === undefined) return undefined;
				upperEntryId = Math.min(upperEntryId, conversation.parent.at);
				conversation = (await this.readConversation(conversation.parent.conversationId))!;
			}
			if (entry.id > upperEntryId) return undefined;
		}
		return { entry, commitSeq: seqFromNumber(row.commit_seq) };
	}

	private async readLatestHeadMarker(
		conversationId: ConversationId,
		atOrBeforeEntryId: EntryId | undefined,
	): Promise<(EntryRecord & { readonly head: EntryId }) | undefined> {
		const own = await this.conversationEntries(conversationId, "head IS NOT NULL", atOrBeforeEntryId, "DESC", 1);
		if (own.entries.length) return own.entries[0] as EntryRecord & { readonly head: EntryId };
		let conversation = own.conversation;
		let upper: number | undefined = atOrBeforeEntryId;
		while (true) {
			if (conversation.parent === undefined) return undefined;
			upper = upper === undefined ? conversation.parent.at : Math.min(upper, conversation.parent.at);
			conversation = (await this.readConversation(conversation.parent.conversationId))!;
			const row =
				upper === undefined
					? await this.db.get<JsonRow>(
							`SELECT record FROM ${this.schema.tables.entries} WHERE session_id = $1 AND conversation_id = ? AND head IS NOT NULL ORDER BY id DESC LIMIT 1`,
							conversation.id,
						)
					: await this.db.get<JsonRow>(
							`SELECT record FROM ${this.schema.tables.entries} WHERE session_id = $1 AND conversation_id = ? AND head IS NOT NULL AND id <= ? ORDER BY id DESC LIMIT 1`,
							conversation.id,
							upper,
						);
			if (row !== undefined) return parseJson<EntryRecord & { readonly head: EntryId }>(row.record);
		}
	}

	/**
	 * A conversation's record and up to `limit` of its own entries (not its fork parent's) matching `where`, at or below
	 * `upper`, in one statement: no round trip to the database for the conversation alone. `ownOnly` reads no entries of
	 * a fork, whose entries an ascending scan reads from its root forward.
	 */
	private async conversationEntries(
		conversationId: ConversationId,
		where: string,
		upper: number | undefined,
		order: "ASC" | "DESC",
		limit: number,
		params: unknown[] = [],
		ownOnly = false,
	): Promise<{ conversation: ConversationRecord; entries: EntryRecord[] }> {
		const rows = await this.db.all<{ conversation: string; record: string | null }>(
			`SELECT c.record AS conversation, e.record FROM ${this.schema.tables.conversations} c
				LEFT JOIN LATERAL (SELECT id, record FROM ${this.schema.tables.entries}
					WHERE session_id = c.session_id AND conversation_id = c.id AND ${where}${upper === undefined ? "" : " AND id <= ?"}
					${ownOnly ? "AND (c.record::jsonb -> 'parent') IS NULL" : ""}
					ORDER BY id ${order} LIMIT ?) e ON true
				WHERE c.session_id = $1 AND c.id = ? ORDER BY e.id ${order}`,
			...params,
			...(upper === undefined ? [] : [upper]),
			limit,
			conversationId,
		);
		if (!rows.length) throw new StorageRequestError(`Unknown conversation: ${conversationId}`);
		return {
			conversation: parseJson<ConversationRecord>(rows[0].conversation),
			entries: rows.flatMap(row => row.record === null ? [] : [parseJson<EntryRecord>(row.record)]),
		};
	}

	private async readEntries(
		query: EntryQuery,
		limit: number,
		cursor: Cursor | undefined,
	): Promise<Page<EntryRecord, Cursor>> {
		const { order, after } = scanStart(query.order, cursor, "descending");
		if (order === "ascending") return this.readEntriesAscending(query, limit, after);
		let upper: number | undefined = query.maxEntryId;
		if (after !== undefined) upper = Math.min(upper ?? Number.MAX_SAFE_INTEGER, after - 1);
		const own = await this.conversationEntries(query.conversationId, query.minEntryId === undefined ? "true" : "id >= ?", upper, "DESC", limit + 1,
			query.minEntryId === undefined ? [] : [query.minEntryId]);
		let conversation = own.conversation;
		const values: EntryRecord[] = own.entries;
		while (values.length <= limit && conversation.parent !== undefined) {
			upper = upper === undefined ? conversation.parent.at : Math.min(upper, conversation.parent.at);
			if (query.minEntryId !== undefined && upper < query.minEntryId) break;
			conversation = (await this.readConversation(conversation.parent.conversationId))!;
			const clauses = ["conversation_id = ?"];
			const params: unknown[] = [conversation.id];
			if (query.minEntryId !== undefined) {
				clauses.push("id >= ?");
				params.push(query.minEntryId);
			}
			if (upper !== undefined) {
				clauses.push("id <= ?");
				params.push(upper);
			}
			params.push(limit + 1 - values.length);
			const rows = await this.db.all<JsonRow>(
				`SELECT record FROM ${this.schema.tables.entries} WHERE session_id = $1 AND ${clauses.join(" AND ")} ORDER BY id DESC LIMIT ?`,
				...params,
			);
			values.push(...rows.map((row) => parseJson<EntryRecord>(row.record)));
		}
		return page(values, limit, "descending");
	}

	/** Oldest first: the fork chain's segments from the root conversation forward, each up to its fork point. */
	/** A conversation's own entry IDs from `minId` to `maxId`, in order, without reading their records (`EntryIdLister`). */
	async entryIds(conversationId: ConversationId, minId: number, maxId: number): Promise<number[]> {
		const rows = await this.db.all<{ id: string | number }>(
			`SELECT id FROM ${this.schema.tables.entries} WHERE session_id = $1 AND conversation_id = ? AND id >= ? AND id <= ? ORDER BY id`,
			conversationId, minId, maxId,
		);
		return rows.map(row => Number(row.id));
	}

    /** The fork lineage and its newest visible head marker (`marker`: its ID and head), as Pi derives a context range. */
    private rangeCte() {
        return `WITH RECURSIVE lineage AS (
                    SELECT id, record::jsonb AS value, 9223372036854775807::bigint AS upper_id, 0 AS depth
                    FROM ${this.schema.tables.conversations} WHERE session_id = $1 AND id = ?
                    UNION ALL
                    SELECT c.id, c.record::jsonb, least(l.upper_id, (l.value->'parent'->>'at')::bigint), l.depth + 1
                    FROM lineage l JOIN ${this.schema.tables.conversations} c
                      ON c.session_id = $1 AND c.id = (l.value->'parent'->>'conversationId')::bigint
                ), marker AS (
                    SELECT h.id, h.head FROM lineage l CROSS JOIN LATERAL (
                        SELECT e.id, e.head FROM ${this.schema.tables.entries} e
                        WHERE e.session_id = $1 AND e.conversation_id = l.id AND e.id <= l.upper_id AND e.head IS NOT NULL
                        ORDER BY e.id DESC LIMIT 1
                    ) h ORDER BY l.depth LIMIT 1
                )`;
    }

    /** Pi scans from the newest visible marker's head (not its ID), including fork ancestors up to their fork point. */
    async contextRangeSize(conversationId: ConversationId): Promise<ContextRangeSize> {
        return this.admitRead(async () => {
            const row = await this.db.get<{ entries: string; bytes: string }>(`${this.rangeCte()}
                SELECT count(*) AS entries, coalesce(sum(octet_length(e.record)), 0) AS bytes
                FROM lineage l JOIN ${this.schema.tables.entries} e
                  ON e.session_id = $1 AND e.conversation_id = l.id
                  AND e.id >= coalesce((SELECT head FROM marker), 0) AND e.id <= l.upper_id`, conversationId);
            return { entries: Number(row!.entries), bytes: Number(row!.bytes) };
        });
    }

    /**
     * The system messages of the range `contextRangeSize` measures (`ContextSystemRow`), selected in the database: a
     * record is parsed only when its text names a system message, and only its system messages and omit targets come back.
     * As json, not jsonb: jsonb sorts object keys, and a system message's sections render in their order.
     */
    async contextSystemRows(conversationId: ConversationId): Promise<ContextSystemRow[]> {
        return this.admitRead(async () => {
            const rows = await this.db.slowAll<{ id: string; head: string | null; marker: string | null; system: string; omits: string; replaces: string }>(CONTEXT_SYSTEM_TIMEOUT_MS, `${this.rangeCte()}
                SELECT e.id, e.head, (SELECT id FROM marker) AS marker,
                  (SELECT coalesce(json_agg(m), '[]'::json) FROM json_array_elements(CASE json_typeof(r.v->'model') WHEN 'array' THEN r.v->'model' END) m
                    WHERE m->>'role' = 'system')::text AS system,
                  (SELECT coalesce(json_agg(x->'target'), '[]'::json) FROM json_array_elements(CASE json_typeof(r.v->'edits') WHEN 'array' THEN r.v->'edits' END) x
                    WHERE x->>'action' = 'omit')::text AS omits,
                  (SELECT coalesce(json_agg(x->'target'), '[]'::json) FROM json_array_elements(CASE json_typeof(r.v->'edits') WHEN 'array' THEN r.v->'edits' END) x
                    WHERE x->>'action' = 'replace')::text AS replaces
                FROM lineage l JOIN ${this.schema.tables.entries} e
                  ON e.session_id = $1 AND e.conversation_id = l.id
                  AND e.id >= coalesce((SELECT head FROM marker), 0) AND e.id <= l.upper_id
                CROSS JOIN LATERAL (SELECT CASE WHEN pg_input_is_valid(e.record, 'json') THEN e.record::json END AS v) r
                WHERE strpos(e.record, '"role":"system"') > 0 OR strpos(e.record, '"edits":[') > 0
                ORDER BY e.id`, conversationId);
            return rows.map(row => ({ id: Number(row.id), head: row.head === null ? undefined : Number(row.head), marker: row.marker === null ? undefined : Number(row.marker),
                system: JSON.parse(row.system), omits: (JSON.parse(row.omits) as unknown[]).map(Number), replaces: (JSON.parse(row.replaces) as unknown[]).map(Number) }));
        });
    }

	private async readEntriesAscending(
		query: EntryQuery,
		limit: number,
		after: number | undefined,
	): Promise<Page<EntryRecord, Cursor>> {
		let lower: number | undefined = query.minEntryId;
		if (after !== undefined) lower = Math.max(lower ?? after + 1, after + 1);
		// A conversation that is no fork is its only segment: it and its entries in one statement.
		const own = await this.conversationEntries(query.conversationId, lower === undefined ? "true" : "id >= ?", query.maxEntryId, "ASC", limit + 1,
			lower === undefined ? [] : [lower], true);
		let conversation = own.conversation;
		if (conversation.parent === undefined) return page(own.entries, limit, "ascending");
		const segments: { readonly conversationId: ConversationId; readonly upper: number | undefined }[] = [];
		let upper: number | undefined = query.maxEntryId;
		while (true) {
			segments.push({ conversationId: conversation.id, upper });
			if (conversation.parent === undefined) break;
			upper = upper === undefined ? conversation.parent.at : Math.min(upper, conversation.parent.at);
			if (query.minEntryId !== undefined && upper < query.minEntryId) break;
			conversation = (await this.readConversation(conversation.parent.conversationId))!;
		}
		const values: EntryRecord[] = [];
		for (const segment of segments.reverse()) {
			const clauses = ["conversation_id = ?"];
			const params: unknown[] = [segment.conversationId];
			if (lower !== undefined) {
				clauses.push("id >= ?");
				params.push(lower);
			}
			if (segment.upper !== undefined) {
				clauses.push("id <= ?");
				params.push(segment.upper);
			}
			params.push(limit + 1 - values.length);
			const rows = await this.db.all<JsonRow>(
				`SELECT record FROM ${this.schema.tables.entries} WHERE session_id = $1 AND ${clauses.join(" AND ")} ORDER BY id ASC LIMIT ?`,
				...params,
			);
			values.push(...rows.map((row) => parseJson<EntryRecord>(row.record)));
			if (values.length > limit) break;
		}
		return page(values, limit, "ascending");
	}

	async task(id: TaskId, _context: Context): Promise<StoredTask | undefined> {
		this.assertOpen();
		const row = await this.db.get<JsonRow>(`SELECT record FROM ${this.schema.tables.tasks} WHERE session_id = $1 AND id = ?`, id);
		return row === undefined ? undefined : parseJson<StoredTask>(row.record);
	}

	async scanTasks(
		query: TaskQuery,
		limit: number,
		cursor: Cursor | undefined,
		_context: Context,
	): Promise<Page<StoredTask, Cursor>> {
		this.assertOpen();
		const start = scanStart(query.order, cursor, "ascending");
		const scan = scanSql(start);
		const clauses = [scan.clause];
		const params: unknown[] = [scan.param];
		if (query.conversationId !== undefined) {
			clauses.push("conversation_id = ?");
			params.push(query.conversationId);
		}
		if (query.kind !== undefined) {
			clauses.push("kind = ?");
			params.push(encodeIndexedString(query.kind));
		}
		if (query.status !== undefined) {
			clauses.push("status = ?");
			params.push(query.status);
		}
		if (query.abortRequested !== undefined) {
			clauses.push("abort_requested = ?");
			params.push(query.abortRequested ? 1 : 0);
		}
		if (query.background !== undefined) {
			clauses.push("background = ?");
			params.push(query.background ? 1 : 0);
		}
		params.push(limit + 1);
		const rows = await this.db.all<JsonRow>(
			`SELECT record FROM ${this.schema.tables.tasks} WHERE session_id = $1 AND ${clauses.join(" AND ")} ORDER BY id ${scan.direction} LIMIT ?`,
			...params,
		);
		return page(
			rows.map((row) => parseJson<StoredTask>(row.record)),
			limit,
			start.order,
		);
	}

	async submission(id: SubmissionId, _context: Context): Promise<SubmissionRecord | undefined> {
		this.assertOpen();
		const row = await this.db.get<JsonRow>(`SELECT record FROM ${this.schema.tables.submissions} WHERE session_id = $1 AND id = ?`, id);
		return row === undefined ? undefined : parseJson<SubmissionRecord>(row.record);
	}

	async scanSubmissions(
		query: SubmissionQuery,
		limit: number,
		cursor: Cursor | undefined,
		_context: Context,
	): Promise<Page<SubmissionRecord, Cursor>> {
		this.assertOpen();
		const start = scanStart(query.order, cursor, "ascending");
		const scan = scanSql(start);
		const clauses = [scan.clause];
		const params: unknown[] = [scan.param];
		if (query.conversationId !== undefined) {
			clauses.push("conversation_id = ?");
			params.push(query.conversationId);
		}
		if (query.status !== undefined) {
			clauses.push("status = ?");
			params.push(query.status);
		}
		params.push(limit + 1);
		const rows = await this.db.all<JsonRow>(
			`SELECT record FROM ${this.schema.tables.submissions} WHERE session_id = $1 AND ${clauses.join(" AND ")} ORDER BY id ${scan.direction} LIMIT ?`,
			...params,
		);
		return page(
			rows.map((row) => parseJson<SubmissionRecord>(row.record)),
			limit,
			start.order,
		);
	}

	async submissionByRequest(
		conversationId: ConversationId,
		requestId: string,
		_context: Context,
	): Promise<SubmissionRecord | undefined> {
		this.assertOpen();
		const row = await this.db.get<JsonRow>(
			`SELECT record FROM ${this.schema.tables.submissions} WHERE session_id = $1 AND conversation_id = ? AND request_id = ?`,
			conversationId,
			encodeIndexedString(requestId),
		);
		return row === undefined ? undefined : parseJson<SubmissionRecord>(row.record);
	}

	async findDocument(
		address: DocumentAddress,
		at: DocumentPoint,
		_context: Context,
	): Promise<DocumentRecord | undefined> {
		this.assertOpen();
		const parts = addressParts(address);
		const sql =
			at === "current"
				? `SELECT record FROM ${this.schema.tables.documents}
					WHERE session_id = $1 AND kind = ? AND scope_kind = ? AND owner_id = ? AND family = ? AND key_value = ?
					AND retired_at IS NULL ORDER BY created_at DESC LIMIT 1`
				: `SELECT record FROM ${this.schema.tables.documents}
					WHERE session_id = $1 AND kind = ? AND scope_kind = ? AND owner_id = ? AND family = ? AND key_value = ?
					AND created_at <= ? AND (retired_at IS NULL OR retired_at > ?)
					ORDER BY created_at DESC LIMIT 1`;
		const params: unknown[] = [parts.kind, parts.scopeKind, parts.ownerId, parts.family, parts.keyValue];
		if (at !== "current") params.push(at, at);
		const row = await this.db.get<JsonRow>(sql, ...params);
		return row === undefined ? undefined : parseJson<DocumentRecord>(row.record);
	}

	async document(id: DocumentId, at: DocumentPoint, _context: Context): Promise<StoredDocument | undefined> {
		this.assertOpen();
		return this.materializeDocument(this.db, id, at);
	}

	async scanDocuments(
		query: DocumentQuery,
		limit: number,
		cursor: Cursor | undefined,
		_context: Context,
	): Promise<Page<DocumentRecord, Cursor>> {
		this.assertOpen();
		const scope = scopeColumns(query.scope);
		const clauses = ["scope_kind = ?", "owner_id = ?", "id > ?"];
		const params: unknown[] = [scope.scopeKind, scope.ownerId, cursorId(cursor) ?? -1];
		if (query.kind !== undefined) {
			clauses.push("kind = ?");
			params.push(encodeIndexedString(query.kind));
		}
		if (query.at === "current") {
			clauses.push("retired_at IS NULL");
		} else {
			clauses.push("created_at <= ?", "(retired_at IS NULL OR retired_at > ?)");
			params.push(query.at, query.at);
		}
		params.push(limit + 1);
		const rows = await this.db.all<JsonRow>(
			`SELECT record FROM ${this.schema.tables.documents} WHERE session_id = $1 AND ${clauses.join(" AND ")} ORDER BY id LIMIT ?`,
			...params,
		);
		return page(
			rows.map((row) => parseJson<DocumentRecord>(row.record)),
			limit,
		);
	}

	close(_context: Context): Promise<void> {
		if (this.closing === undefined) {
			this.closed = true;
			this.closing = this.closeDatabase();
		}
		return this.closing;
	}

	private async closeDatabase(): Promise<void> {
		if (this.admittedReads > 0) {
			await new Promise<void>((resolve) => {
				this.readsDrained = resolve;
			});
		}
		await this.db.close();
	}

	/**
	 * Run a read that issues several queries. Close waits for admitted reads, so their later queries never reach a
	 * closed database. Single-query reads and transactions are already ordered before close by the database.
	 */
	private async admitRead<T>(read: () => Promise<T>): Promise<T> {
		this.assertOpen();
		this.admittedReads++;
		try {
			return await read();
		} finally {
			if (--this.admittedReads === 0) this.readsDrained?.();
		}
	}

	private async readConversation(id: ConversationId): Promise<ConversationRecord | undefined> {
		const row = await this.db.get<JsonRow>(`SELECT record FROM ${this.schema.tables.conversations} WHERE session_id = $1 AND id = ?`, id);
		return row === undefined ? undefined : parseJson<ConversationRecord>(row.record);
	}

	/**
	 * A document's record, its latest base at `at` and the deltas after it, in one statement: one committed state, so a
	 * commit cannot replace the base between them, and no transaction or metadata lock for a read.
	 */
	private async materializeDocument(
		executor: PgExecutor,
		id: DocumentId,
		at: DocumentPoint,
	): Promise<StoredDocument | undefined> {
		const upper = at === "current" ? Number.MAX_SAFE_INTEGER : at;
		const rows = await executor.all<JsonRow & Partial<RevisionRow>>(
			`SELECT d.record, r.seq, r.kind, r.version, r.content FROM ${this.schema.tables.documents} d
				LEFT JOIN LATERAL (SELECT seq FROM ${this.schema.tables.documentRevisions}
					WHERE session_id = d.session_id AND document_id = d.id AND kind = 'base' AND seq <= ? ORDER BY seq DESC LIMIT 1) b ON true
				LEFT JOIN ${this.schema.tables.documentRevisions} r ON r.session_id = d.session_id AND r.document_id = d.id AND r.seq >= b.seq AND r.seq <= ?
				WHERE d.session_id = $1 AND d.id = ? ORDER BY r.seq`,
			upper,
			upper,
			id,
		);
		if (!rows.length) return undefined;
		const record = parseJson<DocumentRecord>(rows[0].record);
		if (at !== "current" && isCurrentOnly(record)) {
			throw new StorageRequestError(`Document ${id} does not retain historical content`);
		}
		if (!isAliveAt(record, at)) return undefined;
		const [base, ...tail] = rows as (JsonRow & RevisionRow)[];
		if (base.seq === null || base.kind !== "base") throw new Error(`Document ${id} is missing a required base`);
		let value = parseJson<JsonObject>(base.content);
		for (const revision of tail) {
			if (revision.kind !== "delta" || revision.version !== base.version) {
				throw new Error(`Document ${id} crosses a stored version boundary without a base`);
			}
			value = apply(value, parseJson<readonly Op[]>(revision.content)) as JsonObject;
		}
		return { record, version: base.version, value, deltasSinceBase: tail.length };
	}

	private candidateNextId(writes: readonly StorageWrite[]): number {
		let nextId = this.nextId;
		for (const write of writes) {
			const id = writeId(write);
			if (id !== undefined) nextId = Math.max(nextId, id + 1);
		}
		return nextId;
	}

	/**
	 * What a commit checks its batch against, in one read: the record types its IDs already have, and the records and
	 * latest revision versions of the documents it acts on.
	 */
	private async readCommitState(
		executor: PgExecutor,
		writes: readonly StorageWrite[],
		actions: ReadonlyMap<DocumentId, DocumentAction>,
	): Promise<{ ids: Map<number, TableName>; documents: (JsonRow & { readonly id: number; readonly version: number | null })[] }> {
		const ids = writes.flatMap(write => { const id = writeId(write); return id === undefined ? [] : [id]; });
		if (!ids.length && !actions.size) return { ids: new Map(), documents: [] };
		const rows = await executor.all<{ source: "id" | "document"; id: number; record_type: TableName | null; record: string | null; version: number | null }>(
			`SELECT 'id' AS source, id, record_type, NULL AS record, NULL::integer AS version FROM ${this.schema.tables.recordIds}
				WHERE session_id = $1 AND id = ANY(?::bigint[])
			UNION ALL
			SELECT 'document', d.id, NULL, d.record, r.version FROM ${this.schema.tables.documents} d
				LEFT JOIN LATERAL (SELECT version FROM ${this.schema.tables.documentRevisions}
					WHERE session_id = d.session_id AND document_id = d.id ORDER BY seq DESC LIMIT 1) r ON true
				WHERE d.session_id = $1 AND d.id = ANY(?::bigint[])`,
			ids,
			[...actions.keys()],
		);
		return {
			ids: new Map(rows.flatMap(row => row.source === "id" ? [[Number(row.id), row.record_type!] as const] : [])),
			documents: rows.flatMap(row => row.source === "document" ? [{ id: row.id, record: row.record!, version: row.version }] : []),
		};
	}

	private checkGlobalIds(writes: readonly StorageWrite[], existingById: ReadonlyMap<number, TableName>): void {
		const claimed = new Map<Id<string>, TableName>();
		for (const write of writes) {
			if (write.type === "document.change" || write.type === "document.retire") continue;
			const document = write.type === "document.create" || write.type === "document.copy";
			const table: TableName = document ? "document" : write.type;
			const id = document ? write.record.id : write.value.id;
			const existing = existingById.get(id);
			const earlier = claimed.get(id);
			if (table === "conversation" || table === "entry" || table === "document") {
				if (existing !== undefined) throw new Error(`ID ${id} already belongs to ${existing}`);
				if (earlier !== undefined) throw new Error(`ID ${id} is written more than once`);
			} else {
				if (existing !== undefined && existing !== table)
					throw new Error(`ID ${id} already belongs to ${existing}`);
				if (earlier !== undefined && earlier !== table) throw new Error(`ID ${id} is written as two record types`);
			}
			claimed.set(id, table);
		}
	}

	private prepareDocumentActions(writes: readonly StorageWrite[]): Map<DocumentId, DocumentAction> {
		const actions = new Map<DocumentId, DocumentAction>();
		for (const write of writes) {
			if (
				write.type !== "document.create" &&
				write.type !== "document.copy" &&
				write.type !== "document.change" &&
				write.type !== "document.retire"
			) {
				continue;
			}
			const id = write.type === "document.create" || write.type === "document.copy" ? write.record.id : write.id;
			let action = actions.get(id);
			if (action === undefined) {
				action = { retire: false };
				actions.set(id, action);
			}
			switch (write.type) {
				case "document.create":
					if (action.create !== undefined || action.content !== undefined || action.copy !== undefined) {
						throw new Error(`Document ${id} has more than one content command`);
					}
					action.create = write.record;
					action.content = write.content;
					break;
				case "document.copy":
					if (action.create !== undefined || action.content !== undefined || action.copy !== undefined) {
						throw new Error(`Document ${id} has more than one content command`);
					}
					action.create = write.record;
					action.copy = write.source;
					break;
				case "document.change":
					if (action.content !== undefined || action.copy !== undefined) {
						throw new Error(`Document ${id} has more than one content command`);
					}
					action.content = write.content;
					break;
				case "document.retire":
					if (action.retire) throw new Error(`Document ${id} is retired more than once`);
					action.retire = true;
					break;
			}
		}
		return actions;
	}

	/** Checks a batch's document actions against their records and latest revisions (`readCommitState`); returns the records. */
	private async checkDocumentActions(
		executor: PgExecutor,
		actions: ReadonlyMap<DocumentId, DocumentAction>,
		rows: readonly (JsonRow & { readonly id: number; readonly version: number | null })[],
	): Promise<Map<DocumentId, DocumentRecord>> {
		const existing = new Map<DocumentId, DocumentRecord>();
		const versions = new Map<DocumentId, number>();
		for (const row of rows) {
			const id = idFromNumber<DocumentId>(Number(row.id));
			existing.set(id, parseJson<DocumentRecord>(row.record));
			if (row.version !== null) versions.set(id, row.version);
		}
		const liveCounts = new Map<string, number>();
		for (const [id, action] of actions) {
			if (action.copy !== undefined && actions.has(action.copy.id)) {
				throw new Error(`Document copy ${id} source is changed in the copy batch`);
			}
			const current = existing.get(id);
			if (action.create === undefined && current === undefined) throw new Error(`Unknown document: ${id}`);
			if (action.create !== undefined && current !== undefined) throw new Error(`Document ${id} already exists`);
			if (current?.retiredAt !== undefined) throw new Error(`Document ${id} is retired`);
			if (action.content?.kind === "delta") {
				const previous = versions.get(id);
				if (previous === undefined) throw new Error(`Document ${id} delta has no base`);
				if (previous !== action.content.version) {
					throw new Error(`Document ${id} version transition requires a base`);
				}
			}
			const record = action.create ?? current!;
			const key = addressKey(record);
			let live = liveCounts.get(key);
			// A live existing document is its address's one current incarnation; only a new one needs the address looked up.
			if (live === undefined) live = current !== undefined ? 1 : (await this.currentDocumentId(executor, record)) === undefined ? 0 : 1;
			if (action.retire && current !== undefined) live--;
			if (action.create !== undefined && !action.retire) live++;
			liveCounts.set(key, live);
		}
		for (const live of liveCounts.values()) {
			if (live > 1) throw new Error("Document address already has a current incarnation");
		}
		return existing;
	}

	private async currentDocumentId(
		executor: PgExecutor,
		address: DocumentAddress | DocumentCreate | DocumentRecord,
	): Promise<DocumentId | undefined> {
		const parts = addressParts(address);
		const id = (
			await executor.get<IdRow>(
				`SELECT id FROM ${this.schema.tables.documents}
				WHERE session_id = $1 AND kind = ? AND scope_kind = ? AND owner_id = ? AND family = ? AND key_value = ? AND retired_at IS NULL
				LIMIT 1`,
				parts.kind,
				parts.scopeKind,
				parts.ownerId,
				parts.family,
				parts.keyValue,
			)
		)?.id;
		return id === undefined ? undefined : idFromNumber<DocumentId>(id);
	}

    private async applyTableWrites(statements: Statements, writes: readonly StorageWrite[], seq: Seq, placements?: Map<number, Placement>): Promise<void> {
        const conversations = new Map<number, ConversationRecord>();
        const entries = new Map<number, EntryRecord>();
        const tasks = new Map<number, StoredTask>();
        const submissions = new Map<number, SubmissionRecord>();
        const claims = new Map<number, TableName>();
        for (const write of writes) {
            switch (write.type) {
                case "conversation": conversations.set(write.value.id, write.value); claims.set(write.value.id, "conversation"); break;
                case "entry": entries.set(write.value.id, write.value); claims.set(write.value.id, "entry"); break;
                case "task": tasks.set(write.value.id, write.value); claims.set(write.value.id, "task"); break;
                case "submission": submissions.set(write.value.id, write.value); claims.set(write.value.id, "submission"); break;
                case "document.create": case "document.copy": claims.set(write.record.id, "document"); break;
            }
        }
        if (claims.size) await statements.add(
            `INSERT INTO ${this.schema.tables.recordIds} (session_id, id, record_type)
             SELECT $1, r.id, r.record_type FROM unnest(?::bigint[], ?::text[]) AS r(id, record_type)
             ON CONFLICT(session_id, id) DO NOTHING`, [[...claims.keys()], [...claims.values()]]);
        if (conversations.size) {
            const values = [...conversations.values()];
            await statements.add(`INSERT INTO ${this.schema.tables.conversations} (session_id, id, owner_conversation_id, owner_task_id, record)
                SELECT $1, r.* FROM unnest(?::bigint[], ?::bigint[], ?::bigint[], ?::text[]) AS r(id, owner_conversation_id, owner_task_id, record)`,
                [values.map(value => value.id), values.map(value => value.owner?.conversationId ?? null),
                values.map(value => value.owner?.taskId ?? null), values.map(encodeJson)]);
        }
        // Keep PostgreSQL's text-array encoding buffers bounded for one-time archive imports: each insert carries at
        // most 32 entries or about 4 MB of them (`Statements` sends at most about 4 MB at once).
        let batch: EntryRecord[] = [], records: string[] = [], bytes = 0;
        const flush = async () => {
            if (!batch.length) return;
            const places = batch.map(value => placements?.get(value.id));
            await statements.add(`INSERT INTO ${this.schema.tables.entries} (session_id, id, conversation_id, head, commit_seq, record, msg_from, msg_count, msg_skip, turn_start)
                SELECT $1, r.id, r.conversation_id, r.head, ?::bigint, r.record, r.msg_from, r.msg_count, r.msg_skip, r.turn_start
                FROM unnest(?::bigint[], ?::bigint[], ?::bigint[], ?::text[], ?::integer[], ?::integer[], ?::integer[], ?::boolean[]) AS r(id, conversation_id, head, record, msg_from, msg_count, msg_skip, turn_start)`,
                [seq, batch.map(value => value.id), batch.map(value => value.conversationId), batch.map(value => value.head ?? null), records,
                places.map(place => place?.from ?? null), places.map(place => place?.count ?? null), places.map(place => place?.skip ?? 0), places.map(place => place?.turn ?? false)], bytes);
            batch = []; records = []; bytes = 0;
        };
        for (const value of entries.values()) {
            const record = encodeJson(value);
            batch.push(value); records.push(record); bytes += record.length;
            if (batch.length >= 32 || bytes >= 4 * 1024 * 1024) await flush();
        }
        await flush();
        if (tasks.size) {
            const values = [...tasks.values()], records = values.map(encodeJson);
            await statements.add(`INSERT INTO ${this.schema.tables.tasks} (session_id, id, conversation_id, kind, status, abort_requested, background, record)
                SELECT $1, r.* FROM unnest(?::bigint[], ?::bigint[], ?::text[], ?::text[], ?::integer[], ?::integer[], ?::text[]) AS r(id, conversation_id, kind, status, abort_requested, background, record)
                ON CONFLICT(session_id, id) DO UPDATE SET conversation_id = excluded.conversation_id, kind = excluded.kind,
                status = excluded.status, abort_requested = excluded.abort_requested, background = excluded.background, record = excluded.record`,
                [values.map(value => value.id), values.map(value => value.conversationId), values.map(value => encodeIndexedString(value.kind)),
                values.map(value => value.state.status), values.map(value => value.abortRequested ? 1 : 0), values.map(value => value.background ? 1 : 0), records], records.reduce((sum, record) => sum + record.length, 0));
        }
        const allSubmissions = [...submissions.values()];
        for (let offset = 0; offset < allSubmissions.length; offset += 256) {
            const values = allSubmissions.slice(offset, offset + 256), records = values.map(encodeJson);
            await statements.add(`INSERT INTO ${this.schema.tables.submissions} (session_id, id, conversation_id, request_id, status, record)
                SELECT $1, r.* FROM unnest(?::bigint[], ?::bigint[], ?::text[], ?::text[], ?::text[]) AS r(id, conversation_id, request_id, status, record)
                ON CONFLICT(session_id, id) DO UPDATE SET conversation_id = excluded.conversation_id, request_id = excluded.request_id, status = excluded.status, record = excluded.record`,
                [values.map(value => value.id), values.map(value => value.conversationId), values.map(value => value.requestId === undefined ? null : encodeIndexedString(value.requestId)),
                values.map(value => value.status), records], records.reduce((sum, record) => sum + record.length, 0));
        }
    }

	/**
	 * Adds the batch's document writes to `statements` (their IDs are claimed with the table writes'). Returns the
	 * current-only documents it retires, whose revisions are deleted after the statements, new revision included.
	 */
	private async applyDocumentActions(
		executor: PgExecutor,
		statements: Statements,
		actions: ReadonlyMap<DocumentId, DocumentAction>,
		seq: Seq,
		existing: ReadonlyMap<DocumentId, DocumentRecord>,
	): Promise<DocumentId[]> {
		const retired: DocumentId[] = [];
		for (const [id, action] of actions) {
			let content = action.content;
			if (action.copy !== undefined) {
				const checks = { failed: false };
				try {
					const stored = await this.materializeDocument(watchedExecutor(executor, checks), action.copy.id, action.copy.at);
					if (stored === undefined) throw new Error(`Fork source document ${action.copy.id} cannot be read`);
					const create = action.create!;
					if (
						stored.record.scope.kind !== "conversation" ||
						create.scope.kind !== "conversation" ||
						stored.record.kind !== create.kind ||
						stored.record.key !== create.key ||
						stored.record.history !== create.history ||
						stored.record.fork !== create.fork
					) {
						throw new Error(`Fork source document ${action.copy.id} does not match the copied record`);
					}
					content = { kind: "base", version: stored.version, value: stored.value };
				} catch (error) {
					if (checks.failed) throw error;
					throw new Refused(new Error(`Document copy ${id} was rejected`, { cause: error }));
				}
			}
			let record: DocumentRecord;
			if (action.create !== undefined) {
				record = {
					...action.create,
					createdAt: seq,
					...(action.retire ? { retiredAt: seq } : {}),
				};
				const parts = addressParts(record);
				await statements.add(
					`INSERT INTO ${this.schema.tables.documents}
						(session_id, id, kind, family, key_value, scope_kind, owner_id, created_at, retired_at, record)
						VALUES ($1, ?::bigint, ?, ?::integer, ?, ?, ?::bigint, ?::bigint, ?::bigint, ?)`,
					[id, parts.kind, parts.family, parts.keyValue, parts.scopeKind, parts.ownerId, seq, action.retire ? seq : null, encodeJson(record)],
				);
			} else record = existing.get(id)!;

			if (content !== undefined) {
				// One statement: the delete sees only the revisions before it, never the one it inserts.
				if (content.kind === "base" && isCurrentOnly(record)) {
					await statements.add(`DELETE FROM ${this.schema.tables.documentRevisions} WHERE session_id = $1 AND document_id = ?::bigint`, [id]);
				}
				const encodedContent = content.kind === "base" ? encodeJson(content.value) : encodeJson(content.ops);
				await statements.add(
					`INSERT INTO ${this.schema.tables.documentRevisions} (session_id, document_id, seq, kind, version, content) VALUES ($1, ?::bigint, ?::bigint, ?, ?::integer, ?)`,
					[id, seq, content.kind, content.version, encodedContent],
					encodedContent.length,
				);
			}

			if (action.retire) {
				if (action.create === undefined) {
					record = { ...record, retiredAt: seq };
					await statements.add(
						`UPDATE ${this.schema.tables.documents} SET retired_at = ?::bigint, record = ? WHERE session_id = $1 AND id = ?::bigint`,
						[seq, encodeJson(record), id],
					);
				}
				if (isCurrentOnly(record)) retired.push(id);
			}
		}
		return retired;
	}

	private assertOpen(): void {
		if (this.closed) throw new Error("PostgresPiStorage is closed");
	}
}
