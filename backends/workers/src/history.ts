import type { Conversation } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { BadRequest } from "./validation.ts";
import { attachmentMessage } from "./attachment-markers.ts";

type Row = { ordinal: number; entry: number; message: string; bytes: number; turn: number };
const PAGE_BYTES = 4_000_000;

/** Durable ordinal index: normal reads touch only new journal entries and the requested page. */
export class AgentHistory {
  private line: Promise<void> = Promise.resolve();
  private sql: SqlStorage;
  private readonly atomic: <T>(write: () => T) => T;
  private readonly visible: (message: unknown) => boolean | Promise<boolean>;
  constructor(sql: SqlStorage, atomic: <T>(write: () => T) => T, visible: (message: unknown) => boolean | Promise<boolean> = () => true) {
    this.sql=sql;
    this.atomic=atomic;
    this.visible=visible;
    sql.exec("CREATE TABLE IF NOT EXISTS camel_history (ordinal INTEGER PRIMARY KEY, entry INTEGER NOT NULL, message TEXT NOT NULL, bytes INTEGER NOT NULL, turn INTEGER NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS camel_history_cursor (id INTEGER PRIMARY KEY CHECK(id=1), entry INTEGER NOT NULL)");
  }
  sync(root: Conversation): Promise<void> {
    const next = this.line.then(async () => {
      let last = this.sql.exec<{entry:number}>("SELECT entry FROM camel_history_cursor WHERE id=1").toArray()[0]?.entry ?? 0;
      const minEntryId = (last + 1) as never;
      let cursor;
      do {
        const page = await root.entries({ order: "ascending", minEntryId }, 128, cursor, BACKGROUND_CONTEXT);
        for (const entry of page.items) {
          const visible = await Promise.all((entry.model ?? []).map(message => this.visible(message)));
          this.atomic(() => {
            let ordinal = this.total();
            const data = entry.data as { requestId?: string; metadata?: unknown; from?: unknown } | undefined;
            // Context replacement is not a new public message or a rewrite of the history index.
            const messages = ["pi.reset", "camel.context"].includes(entry.kind) ? [] : (entry.model ?? []).filter((_, index) => visible[index]);
            for (const original of messages) {
              if (original.role === "system") continue;
              const projected = attachmentMessage(original);
              const message = original.role === "user" && data?.requestId
                ? { ...projected, ...data } : projected;
              const serialized = JSON.stringify(message);
              this.sql.exec("INSERT INTO camel_history (ordinal,entry,message,bytes,turn) VALUES (?,?,?,?,?)",
                ordinal++, Number(entry.id), serialized, new TextEncoder().encode(serialized).length,
                original.role === "user" ? 1 : 0);
            }
            this.sql.exec("INSERT INTO camel_history_cursor VALUES (1,?) ON CONFLICT(id) DO UPDATE SET entry=excluded.entry", Number(entry.id));
          });
          last = Number(entry.id);
        }
        cursor = page.next;
      } while (cursor !== undefined);
    });
    this.line = next.catch(() => {});
    return next;
  }
  messageIndex(entry: number) { return this.sql.exec<{ordinal:number}>("SELECT ordinal FROM camel_history WHERE entry=? ORDER BY ordinal LIMIT 1", entry).toArray()[0]?.ordinal; }
  cursorAt(ordinal: number) { return this.sql.exec<{entry:number}>("SELECT entry FROM camel_history WHERE ordinal=?", ordinal).toArray()[0]; }
  total() { return this.sql.exec<{n:number}>("SELECT COALESCE(MAX(ordinal)+1,0) n FROM camel_history").one().n; }
  tail(count: number) {
    if (!Number.isSafeInteger(count) || count < 0) throw new BadRequest("keepMessages must be a nonnegative integer");
    return this.sql.exec<Row>("SELECT * FROM (SELECT * FROM camel_history ORDER BY ordinal DESC LIMIT ?) ORDER BY ordinal", count).toArray().map(row=>JSON.parse(row.message));
  }
  read(url: URL) {
    const params = url.searchParams;
    const paged = ["limit", "before", "after", "maxBytes"].some(k => params.has(k));
    const total = this.total();
    if (!paged) {
      const bytes = this.sql.exec<{n:number}>("SELECT COALESCE(SUM(bytes),0) n FROM camel_history").one().n;
      if (bytes > 64 * 1024 * 1024) throw Object.assign(new Error("History exceeds full-read limit; request a bounded page"), {status:413});
      return { messages: this.sql.exec<Row>("SELECT * FROM camel_history ORDER BY ordinal").toArray().map(r => JSON.parse(r.message)) };
    }
    const number = (name: string, fallback: number) => params.has(name) ? Number(params.get(name)) : fallback;
    const limit = number("limit", 50), before = number("before", total), after = number("after", 0), maxBytes = number("maxBytes", PAGE_BYTES);
    if (params.has("before") && params.has("after")) throw new BadRequest("Ask for after or before, not both");
    if (![limit,before,after,maxBytes].every(Number.isSafeInteger) || limit < 1 || limit > 500 || before < 0 || after < 0 || maxBytes < 16384 || maxBytes > PAGE_BYTES) throw new BadRequest("Invalid history cursor, limit or maxBytes");
    const forward = params.has("after");
    const rows: Row[] = [];
    let bytes = 100, position = forward ? Math.min(after,total) : Math.min(before,total), done = false;
    while (!done) {
      const batch = this.sql.exec<Row>(forward
        ? "SELECT * FROM camel_history WHERE ordinal >= ? ORDER BY ordinal LIMIT 128"
        : "SELECT * FROM camel_history WHERE ordinal < ? ORDER BY ordinal DESC LIMIT 128", position).toArray();
      if (!batch.length) break;
      for (const row of batch) {
        const boundary = forward ? row.turn === 1 : rows.at(-1)?.turn === 1;
        if (rows.length >= limit && boundary) { done = true; break; }
        if (rows.length && bytes + row.bytes + 40 > maxBytes) { done = true; break; }
        rows.push(row); bytes += row.bytes + 40;
        position = forward ? row.ordinal + 1 : row.ordinal;
      }
    }
    rows.sort((a,b) => a.ordinal-b.ordinal);
    const first = rows[0], end = rows.length ? rows.at(-1)!.ordinal+1 : Math.min(forward ? after : before,total);
    const split = first && !first.turn || (end < total && !this.sql.exec<{turn:number}>("SELECT turn FROM camel_history WHERE ordinal=?",end).toArray()[0]?.turn);
    return { entries: rows.map(r => ({index:r.ordinal,message:JSON.parse(r.message)})), next: first?.ordinal || null, total,
      ...(split ? {split:true} : {}), ...(forward ? {nextAfter:end,...(after > total ? {truncated:true} : {})} : {}) };
  }
}
