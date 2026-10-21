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
import { underClaim, type Claim } from "../ownership.ts";
import type { Db, Sql } from "../db.ts";

import type { Context, JsonValue } from "@earendil-works/chord";
import { apply, type Op } from "@earendil-works/chord/delta";
import { StorageRequestError } from "@earendil-works/pi-durable";

import type {
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

const TABLES = {
    durableMetadata: "pi_durable_metadata", recordIds: "pi_durable_record_ids",
    conversations: "pi_durable_conversations", entries: "pi_durable_entries",
    tasks: "pi_durable_tasks", submissions: "pi_durable_submissions",
    documents: "pi_durable_documents", documentRevisions: "pi_durable_document_revisions",
} as const;
type PgSchema = { tables: typeof TABLES };
export type PiCommitEffect = (entry: EntryRecord, sql?: Sql) => Promise<void>;

type PgExecutor = {
    sql: Sql;
    get<T>(query: string, ...params: unknown[]): Promise<T | undefined>;
    all<T>(query: string, ...params: unknown[]): Promise<T[]>;
    run(query: string, ...params: unknown[]): Promise<void>;
};
type PgDatabase = PgExecutor & { transaction<T>(work: (sql: PgExecutor) => Promise<T>): Promise<T>; close(): Promise<void> };
function postgresDatabase(db: Db, sessionId: string, claim?: Claim): PgDatabase {
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
    return {
        ...executor(db),
        transaction: work => underClaim(db, claim, async sql => {
            // Serializes mutations by session, including separate handles on this node. Takeovers
            // wait on underClaim's ownership lock before another owner can update this metadata.
            await sql.query("select session_id from pi_durable_metadata where session_id = $1 for update", [sessionId]);
            await sql.query("set local synchronous_commit = on");
            return work(executor(sql));
        }),
        async close() {}, // The supervisor, not an individual Pi session, owns the pool.
    };
}
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
export async function openPiStorage(options: { sessionId: string; directory: string; db?: Db; claim?: Claim; committing?: PiCommitEffect }): Promise<Storage> {
    validKey(options.sessionId);
    if (options.db) return PostgresPiStorage.open(options.db, options.sessionId, options.claim, options.committing);
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
        if (!options.committing) return storage;
        const commit = storage.commit.bind(storage);
        storage.commit = async (writes, context) => {
            for (const write of writes) if (write.type === "entry") await options.committing!(write.value);
            return commit(writes, context);
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

const STORAGE_METHODS = ["commit", "mintId", "mintIds", "conversation", "scanConversations", "entry", "findLatestHeadMarker", "scanEntries", "task", "scanTasks", "submission", "scanSubmissions", "submissionByRequest", "findDocument", "document", "scanDocuments", "close"] as const;
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
    const method = storage[request.method] as (...args: unknown[]) => Promise<unknown>;
    const args = [...request.args];
    for (const index of request.undefinedArgs ?? []) {
        if (!Number.isSafeInteger(index) || index < 0 || index >= args.length) throw new Error("Invalid Pi storage argument");
        args[index] = undefined;
    }
    return method.apply(storage, request.method === "mintId" ? [] : [...args, BACKGROUND_CONTEXT]);
}
/** Contexts are process-local; the owner attaches its background context to each dispatched operation. */
export function remotePiStorage(request: (request: PiStorageRequest) => Promise<unknown>): Storage {
    return Object.fromEntries(STORAGE_METHODS.map(method => [method, (...args: unknown[]) => {
        if (method !== "mintId" && method !== "mintIds") args.pop();
        const undefinedArgs = args.flatMap((value, index) => value === undefined ? [index] : []);
        return request({ method, args, ...(undefinedArgs.length ? { undefinedArgs } : {}) });
    }])) as unknown as Storage;
}

type StoredTask = TaskRecord<JsonValue, JsonValue, JsonValue>;
type TableName = "conversation" | "entry" | "task" | "submission" | "document";
type RecordIdRow = { readonly record_type: TableName };
type JsonRow = { readonly record: string };
type EntryJsonRow = { readonly record: string; readonly commit_seq: number };
type RevisionRow = {
	readonly seq: number;
	readonly kind: DocumentContent["kind"];
	readonly version: number;
	readonly content: string;
};
type IdRow = { readonly id: number };
type MetadataRow = { readonly next_id: string; readonly next_seq: number };
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

	static async open(db: Db, sessionId: string, claim?: Claim, committing?: PiCommitEffect): Promise<PostgresPiStorage> {
        const database = postgresDatabase(db, sessionId, claim);
        await database.transaction(async sql => {
            await sql.run(`INSERT INTO ${TABLES.durableMetadata} (session_id, singleton, next_id, next_seq) VALUES ($1, 1, '2', 1) ON CONFLICT(session_id) DO NOTHING`);
        });
        const metadata = await database.get<MetadataRow>(`SELECT next_id, next_seq FROM ${TABLES.durableMetadata} WHERE session_id = $1 AND singleton = 1`);
        if (!metadata) throw new Error("Durable Postgres metadata is missing");
        return new PostgresPiStorage(database, { tables: TABLES }, Number(metadata.next_id), committing);
    }

	async commit(writes: readonly StorageWrite[], _context: Context): Promise<Seq> {
		this.assertOpen();
		const documentActions = this.prepareDocumentActions(writes);
		const candidateNextId = this.candidateNextId(writes);
		const seq = await this.db.transaction(async (transaction) => {
			const metadata = await transaction.get<MetadataRow>(
				`SELECT next_id, next_seq FROM ${this.schema.tables.durableMetadata} WHERE session_id = $1 AND singleton = 1`,
			);
			if (metadata === undefined) throw new Error("Durable SQLite metadata is missing");
			const committedSeq = seqFromNumber(metadata.next_seq);
			await this.checkGlobalIds(transaction, writes);
			await this.checkDocumentActions(transaction, documentActions);
			await this.applyTableWrites(transaction, writes, committedSeq);
			await this.applyDocumentActions(transaction, documentActions, committedSeq);
            for (const write of writes) if (write.type === "entry") await this.committing?.(write.value, transaction.sql);
			await transaction.run(
				`UPDATE ${this.schema.tables.durableMetadata} SET next_id = ?, next_seq = ? WHERE session_id = $1 AND singleton = 1`,
				String(Math.max(Number(metadata.next_id), candidateNextId)),
				committedSeq + 1,
			);
			return committedSeq;
		});
		this.nextId = Math.max(this.nextId, candidateNextId);
		return seq;
	}

	async mintId<I extends Id<string>>(): Promise<I> {
        return (await this.mintIds(1))[0] as I;
    }

    /** Optional Camel import extension: reserve a namespace-safe range with one durable fenced update. */
    async mintIds(count: number): Promise<number[]> {
        this.assertOpen();
        validateReservationCount(count);
        const first = await this.db.transaction(async sql => {
            const value = await sql.get<{ id: number }>(`UPDATE ${this.schema.tables.durableMetadata} SET next_id = (next_id::bigint + ?)::text WHERE session_id = $1 AND singleton = 1 RETURNING (next_id::bigint - ?) as id`, count, count);
            if (!value || !Number.isSafeInteger(value.id) || !Number.isSafeInteger(value.id + count - 1)) throw new Error("ID space is exhausted");
            return value.id;
        });
        this.nextId = Math.max(this.nextId, first + count);
        return Array.from({ length: count }, (_, index) => first + index);
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
		if (context !== undefined) {
			const conversationId = idFromNumber<ConversationId>(idOrConversationId);
			conversation = await this.readConversation(conversationId);
			if (conversation === undefined) throw new StorageRequestError(`Unknown conversation: ${conversationId}`);
		}
		const row = await this.db.get<EntryJsonRow>(
			`SELECT record, commit_seq FROM ${this.schema.tables.entries} WHERE session_id = $1 AND id = ?`,
			id,
		);
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
		let conversation = await this.readConversation(conversationId);
		if (conversation === undefined) throw new StorageRequestError(`Unknown conversation: ${conversationId}`);
		let upper: number | undefined = atOrBeforeEntryId;
		while (true) {
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
			if (conversation.parent === undefined) return undefined;
			upper = upper === undefined ? conversation.parent.at : Math.min(upper, conversation.parent.at);
			conversation = (await this.readConversation(conversation.parent.conversationId))!;
		}
	}

	private async readEntries(
		query: EntryQuery,
		limit: number,
		cursor: Cursor | undefined,
	): Promise<Page<EntryRecord, Cursor>> {
		const { order, after } = scanStart(query.order, cursor, "descending");
		if (order === "ascending") return this.readEntriesAscending(query, limit, after);
		let conversation = await this.readConversation(query.conversationId);
		if (conversation === undefined) throw new StorageRequestError(`Unknown conversation: ${query.conversationId}`);
		let upper: number | undefined = query.maxEntryId;
		if (after !== undefined) upper = Math.min(upper ?? Number.MAX_SAFE_INTEGER, after - 1);
		const values: EntryRecord[] = [];
		while (true) {
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
			if (values.length > limit || conversation.parent === undefined) break;
			upper = upper === undefined ? conversation.parent.at : Math.min(upper, conversation.parent.at);
			if (query.minEntryId !== undefined && upper < query.minEntryId) break;
			conversation = (await this.readConversation(conversation.parent.conversationId))!;
		}
		return page(values, limit, "descending");
	}

	/** Oldest first: the fork chain's segments from the root conversation forward, each up to its fork point. */
	private async readEntriesAscending(
		query: EntryQuery,
		limit: number,
		after: number | undefined,
	): Promise<Page<EntryRecord, Cursor>> {
		const segments: { readonly conversationId: ConversationId; readonly upper: number | undefined }[] = [];
		let conversation = await this.readConversation(query.conversationId);
		if (conversation === undefined) throw new StorageRequestError(`Unknown conversation: ${query.conversationId}`);
		let upper: number | undefined = query.maxEntryId;
		while (true) {
			segments.push({ conversationId: conversation.id, upper });
			if (conversation.parent === undefined) break;
			upper = upper === undefined ? conversation.parent.at : Math.min(upper, conversation.parent.at);
			if (query.minEntryId !== undefined && upper < query.minEntryId) break;
			conversation = (await this.readConversation(conversation.parent.conversationId))!;
		}
		let lower: number | undefined = query.minEntryId;
		if (after !== undefined) lower = Math.max(lower ?? after + 1, after + 1);
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
		// The record and revision queries must observe one committed state; a commit between them can replace the base.
		return this.db.transaction((transaction) => this.materializeDocument(transaction, id, at));
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

	private async materializeDocument(
		executor: PgExecutor,
		id: DocumentId,
		at: DocumentPoint,
	): Promise<StoredDocument | undefined> {
		const row = await executor.get<JsonRow>(`SELECT record FROM ${this.schema.tables.documents} WHERE session_id = $1 AND id = ?`, id);
		if (row === undefined) return undefined;
		const record = parseJson<DocumentRecord>(row.record);
		if (at !== "current" && isCurrentOnly(record)) {
			throw new StorageRequestError(`Document ${id} does not retain historical content`);
		}
		if (!isAliveAt(record, at)) return undefined;
		const upper = at === "current" ? Number.MAX_SAFE_INTEGER : at;
		const base = await executor.get<RevisionRow>(
			`SELECT seq, kind, version, content FROM ${this.schema.tables.documentRevisions}
				WHERE session_id = $1 AND document_id = ? AND kind = 'base' AND seq <= ? ORDER BY seq DESC LIMIT 1`,
			id,
			upper,
		);
		if (base === undefined) throw new Error(`Document ${id} is missing a required base`);
		let value = parseJson<JsonObject>(base.content);
		const tail = await executor.all<RevisionRow>(
			`SELECT seq, kind, version, content FROM ${this.schema.tables.documentRevisions}
				WHERE session_id = $1 AND document_id = ? AND seq > ? AND seq <= ? ORDER BY seq`,
			id,
			base.seq,
			upper,
		);
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

	private async checkGlobalIds(executor: PgExecutor, writes: readonly StorageWrite[]): Promise<void> {
		const claimed = new Map<Id<string>, TableName>();
        const ids = writes.flatMap(write => { const id = writeId(write); return id === undefined ? [] : [id]; });
        const existingRows = ids.length ? await executor.all<RecordIdRow & { id: number }>(`SELECT id, record_type FROM ${this.schema.tables.recordIds} WHERE session_id = $1 AND id = ANY(?::bigint[])`, ids) : [];
        const existingById = new Map(existingRows.map(row => [row.id, row.record_type]));
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

	private async checkDocumentActions(
		executor: PgExecutor,
		actions: ReadonlyMap<DocumentId, DocumentAction>,
	): Promise<void> {
		const liveCounts = new Map<string, number>();
		for (const [id, action] of actions) {
			if (action.copy !== undefined && actions.has(action.copy.id)) {
				throw new Error(`Document copy ${id} source is changed in the copy batch`);
			}
			const row = await executor.get<JsonRow>(`SELECT record FROM ${this.schema.tables.documents} WHERE session_id = $1 AND id = ?`, id);
			const existing = row === undefined ? undefined : parseJson<DocumentRecord>(row.record);
			if (action.create === undefined && existing === undefined) throw new Error(`Unknown document: ${id}`);
			if (action.create !== undefined && existing !== undefined) throw new Error(`Document ${id} already exists`);
			if (existing?.retiredAt !== undefined) throw new Error(`Document ${id} is retired`);
			if (action.content?.kind === "delta") {
				const previous = await executor.get<{ readonly version: number }>(
					`SELECT version FROM ${this.schema.tables.documentRevisions} WHERE session_id = $1 AND document_id = ? ORDER BY seq DESC LIMIT 1`,
					id,
				);
				if (previous === undefined) throw new Error(`Document ${id} delta has no base`);
				if (previous.version !== action.content.version) {
					throw new Error(`Document ${id} version transition requires a base`);
				}
			}
			const record = action.create ?? existing!;
			const key = addressKey(record);
			let live = liveCounts.get(key);
			if (live === undefined) live = (await this.currentDocumentId(executor, record)) === undefined ? 0 : 1;
			if (action.retire && existing !== undefined) live--;
			if (action.create !== undefined && !action.retire) live++;
			liveCounts.set(key, live);
		}
		for (const live of liveCounts.values()) {
			if (live > 1) throw new Error("Document address already has a current incarnation");
		}
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

    private async applyTableWrites(executor: PgExecutor, writes: readonly StorageWrite[], seq: Seq): Promise<void> {
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
        if (claims.size) await executor.run(
            `INSERT INTO ${this.schema.tables.recordIds} (session_id, id, record_type)
             SELECT $1, r.id, r.record_type FROM unnest(?::bigint[], ?::text[]) AS r(id, record_type)
             ON CONFLICT(session_id, id) DO NOTHING`, [...claims.keys()], [...claims.values()]);
        if (conversations.size) {
            const values = [...conversations.values()];
            await executor.run(`INSERT INTO ${this.schema.tables.conversations} (session_id, id, owner_conversation_id, owner_task_id, record)
                SELECT $1, r.* FROM unnest(?::bigint[], ?::bigint[], ?::bigint[], ?::text[]) AS r(id, owner_conversation_id, owner_task_id, record)`,
                values.map(value => value.id), values.map(value => value.owner?.conversationId ?? null),
                values.map(value => value.owner?.taskId ?? null), values.map(encodeJson));
        }
        // Keep PostgreSQL's text-array encoding buffers bounded for one-time archive imports.
        const allEntries = [...entries.values()];
        for (let offset = 0; offset < allEntries.length; offset += 32) {
            const values = allEntries.slice(offset, offset + 32);
            await executor.run(`INSERT INTO ${this.schema.tables.entries} (session_id, id, conversation_id, head, commit_seq, record)
                SELECT $1, r.id, r.conversation_id, r.head, ?, r.record FROM unnest(?::bigint[], ?::bigint[], ?::bigint[], ?::text[]) AS r(id, conversation_id, head, record)`,
                seq, values.map(value => value.id), values.map(value => value.conversationId), values.map(value => value.head ?? null), values.map(encodeJson));
        }
        if (tasks.size) {
            const values = [...tasks.values()];
            await executor.run(`INSERT INTO ${this.schema.tables.tasks} (session_id, id, conversation_id, kind, status, abort_requested, background, record)
                SELECT $1, r.* FROM unnest(?::bigint[], ?::bigint[], ?::text[], ?::text[], ?::integer[], ?::integer[], ?::text[]) AS r(id, conversation_id, kind, status, abort_requested, background, record)
                ON CONFLICT(session_id, id) DO UPDATE SET conversation_id = excluded.conversation_id, kind = excluded.kind,
                status = excluded.status, abort_requested = excluded.abort_requested, background = excluded.background, record = excluded.record`,
                values.map(value => value.id), values.map(value => value.conversationId), values.map(value => encodeIndexedString(value.kind)),
                values.map(value => value.state.status), values.map(value => value.abortRequested ? 1 : 0), values.map(value => value.background ? 1 : 0), values.map(encodeJson));
        }
        const allSubmissions = [...submissions.values()];
        for (let offset = 0; offset < allSubmissions.length; offset += 256) {
            const values = allSubmissions.slice(offset, offset + 256);
            await executor.run(`INSERT INTO ${this.schema.tables.submissions} (session_id, id, conversation_id, request_id, status, record)
                SELECT $1, r.* FROM unnest(?::bigint[], ?::bigint[], ?::text[], ?::text[], ?::text[]) AS r(id, conversation_id, request_id, status, record)
                ON CONFLICT(session_id, id) DO UPDATE SET conversation_id = excluded.conversation_id, request_id = excluded.request_id, status = excluded.status, record = excluded.record`,
                values.map(value => value.id), values.map(value => value.conversationId), values.map(value => value.requestId === undefined ? null : encodeIndexedString(value.requestId)),
                values.map(value => value.status), values.map(encodeJson));
        }
    }

	private async claimId(executor: PgExecutor, id: Id<string>, table: TableName): Promise<void> {
		await executor.run(
			`INSERT INTO ${this.schema.tables.recordIds} (session_id, id, record_type) VALUES ($1, ?, ?) ON CONFLICT(session_id, id) DO NOTHING`,
			id,
			table,
		);
	}

	private async applyDocumentActions(
		executor: PgExecutor,
		actions: ReadonlyMap<DocumentId, DocumentAction>,
		seq: Seq,
	): Promise<void> {
		for (const [id, action] of actions) {
			let content = action.content;
			if (action.copy !== undefined) {
				try {
					const stored = await this.materializeDocument(executor, action.copy.id, action.copy.at);
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
					throw new Error(`Document copy ${id} was rejected`, { cause: error });
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
				await this.claimId(executor, id, "document");
				await executor.run(
					`INSERT INTO ${this.schema.tables.documents}
						(session_id, id, kind, family, key_value, scope_kind, owner_id, created_at, retired_at, record)
						VALUES ($1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					id,
					parts.kind,
					parts.family,
					parts.keyValue,
					parts.scopeKind,
					parts.ownerId,
					seq,
					action.retire ? seq : null,
					encodeJson(record),
				);
			} else {
				const row = (await executor.get<JsonRow>(
					`SELECT record FROM ${this.schema.tables.documents} WHERE session_id = $1 AND id = ?`,
					id,
				))!;
				record = parseJson<DocumentRecord>(row.record);
			}

			if (content !== undefined) {
				if (content.kind === "base" && isCurrentOnly(record)) {
					await executor.run(`DELETE FROM ${this.schema.tables.documentRevisions} WHERE session_id = $1 AND document_id = ?`, id);
				}
				const encodedContent = content.kind === "base" ? encodeJson(content.value) : encodeJson(content.ops);
				await executor.run(
					`INSERT INTO ${this.schema.tables.documentRevisions} (session_id, document_id, seq, kind, version, content) VALUES ($1, ?, ?, ?, ?, ?)`,
					id,
					seq,
					content.kind,
					content.version,
					encodedContent,
				);
			}

			if (action.retire) {
				if (action.create === undefined) {
					record = { ...record, retiredAt: seq };
					await executor.run(
						`UPDATE ${this.schema.tables.documents} SET retired_at = ?, record = ? WHERE session_id = $1 AND id = ?`,
						seq,
						encodeJson(record),
						id,
					);
				}
				if (isCurrentOnly(record)) {
					await executor.run(`DELETE FROM ${this.schema.tables.documentRevisions} WHERE session_id = $1 AND document_id = ?`, id);
				}
			}
		}
	}

	private assertOpen(): void {
		if (this.closed) throw new Error("PostgresPiStorage is closed");
	}
}
