import { mkdir, open, readFile, rename, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync } from "node:fs";
import type { Sql } from "../src/db.ts";

/**
 * Database work that commits with the record it is appended with (`AppendLog.append`): in the transaction that first
 * writes the record, under the same fence, and never again. A log whose writes are not database transactions (a file)
 * runs it alone, with no `sql`, just before it writes the record.
 */
export type CommitEffect = (sql?: Sql) => Promise<void>;

/**
 * Append-only record log. Writers append records cheaply and choose when a
 * batch must be durable, so streaming never pays for a full-state rewrite.
 * `rewrite` atomically replaces the log with a folded snapshot of itself.
 */
export interface AppendLog<T> {
  /** Every record since the last rewrite. A torn final record from a crash is dropped. */
  read(): Promise<T[]>;
  /** Refuse oversized input before materializing it. Undefined means the bound cannot be met. */
  readBounded?(maxBytes: number): Promise<T[] | undefined>;
  /** Replay records without retaining the whole log. Earlier records may have been applied if reading fails. */
  replay?(apply: (record: T) => void): Promise<void>;
  /** Buffer a record; it is written by the next `flush`, with `effect` (see `CommitEffect`). */
  append(record: T, effect?: CommitEffect): void;
  /** Write buffered records. `durable` waits for them to reach stable storage. */
  flush(durable?: boolean): Promise<void>;
  /**
   * Atomically replace the whole log with `snapshot()`, which runs inside the
   * write sequence. Callers apply records to memory as they append them, so the
   * snapshot already reflects any still-buffered records; those are discarded.
   */
  rewrite(snapshot: () => T[]): Promise<void>;
  /** Records appended since the last rewrite (for deciding when to fold). */
  readonly appendedSinceRewrite: number;
  /** Write what is buffered and stop; `discard`: stop without writing it (a writer whose state is no longer what is stored). */
  close(discard?: boolean): Promise<void>;
}

/**
 * Before a writer appends to a log a crash may have left without a final newline, end that line as `read` sees
 * it: drop it if it is torn, or terminate it if it parses. Appending after it would otherwise glue the next
 * record onto it, and `read` would drop that record as torn (or, once more follow, fail on a corrupt record).
 */
async function endLastLine(path: string) {
  let file: FileHandle;
  try { file = await open(path, "r+"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  try {
    const { size } = await file.stat();
    if (!size) return;
    const last = Buffer.alloc(1);
    await file.read(last, 0, 1, size - 1);
    if (last[0] === 0x0a) return;
    // Find where the final line starts, reading backwards.
    const chunk = Buffer.alloc(64 * 1024);
    let start = size;
    let newline = -1;
    while (start > 0 && newline < 0) {
      const length = Math.min(chunk.length, start);
      start -= length;
      await file.read(chunk, 0, length, start);
      const at = chunk.subarray(0, length).lastIndexOf(0x0a);
      if (at >= 0) newline = start + at;
    }
    const begin = newline + 1;
    const line = Buffer.alloc(size - begin);
    await file.read(line, 0, line.length, begin);
    let parses = true;
    try { JSON.parse(line.toString("utf8")); } catch { parses = false; }
    if (parses) await file.write("\n", size);
    else await file.truncate(begin);
    await file.datasync();
  } finally { await file.close(); }
}

/** JSONL file implementation for a single process that owns `path`. */
export function fileAppendLog<T>(path: string): AppendLog<T> {
  let buffer: string[] = [];
  let effects: CommitEffect[] = [];
  // Before the records they go with: one that fails stays, with the records, for the next write.
  const effected = async () => { while (effects.length) { await effects[0](); effects.shift(); } };
  let handle: FileHandle | undefined;
  let chain: Promise<void> = Promise.resolve();
  let appended = 0;
  let closed = false;
  const serialize = <R>(work: () => Promise<R>): Promise<R> => {
    const next = chain.then(work);
    chain = next.then(() => {}, () => {});
    return next;
  };
  const opened = async () => {
    if (closed) throw new Error("Append log closed");
    if (!handle) {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await endLastLine(path);
      handle = await open(path, "a", 0o600);
    }
    return handle;
  };
  const replay = async (apply: (record: T) => void) => {
    let file: FileHandle;
    try { file = await open(path, "r"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    const stream = file.createReadStream({ encoding: "utf8" });
    let pending = "", line = 0;
    let corrupt: Error | undefined;
    const consume = (text: string) => {
      line++;
      if (!text) return;
      // As with read(), only the last non-empty record may be torn, even if blank lines follow it.
      if (corrupt) throw corrupt;
      let record: T;
      try { record = JSON.parse(text); }
      catch (error) { corrupt = new Error(`Corrupt append log record ${line} in ${path}: ${(error as Error).message}`); return; }
      apply(record);
    };
    try {
      for await (const chunk of stream) {
        pending += chunk;
        let start = 0;
        for (let end = pending.indexOf("\n"); end >= 0; end = pending.indexOf("\n", start)) {
          consume(pending.slice(start, end));
          start = end + 1;
        }
        pending = pending.slice(start);
      }
      if (pending) consume(pending);
    } finally { stream.destroy(); }
  };
  return {
    replay,
    async readBounded(maxBytes) {
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError("Invalid log read bound");
      let file: FileHandle;
      try { file = await open(path, "r"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
      try {
        const { size } = await file.stat();
        if (size > maxBytes) return undefined;
        // Reading one extra byte detects growth without an unbounded readFile allocation.
        const buffer = Buffer.alloc(Math.min(size + 1, maxBytes + 1));
        let used = 0;
        while (used < buffer.length) {
          const { bytesRead } = await file.read(buffer, used, buffer.length - used, used);
          if (!bytesRead) break;
          used += bytesRead;
        }
        if (used > size || used > maxBytes) return undefined;
        const records: T[] = [];
        const lines = buffer.toString("utf8", 0, used).split("\n");
        for (let index = 0; index < lines.length; index++) {
          if (!lines[index]) continue;
          try { records.push(JSON.parse(lines[index])); }
          catch (error) {
            if (lines.slice(index + 1).every(line => !line)) break;
            throw new Error(`Corrupt append log record ${index + 1} in ${path}: ${(error as Error).message}`);
          }
        }
        return records;
      } finally { await file.close(); }
    },
    async read() {
      let text: string;
      try { text = await readFile(path, "utf8"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
      const lines = text.split("\n");
      const records: T[] = [];
      for (let index = 0; index < lines.length; index++) {
        if (!lines[index]) continue;
        try { records.push(JSON.parse(lines[index])); }
        catch (error) {
          // Only the final line can be torn by a crash mid-append.
          if (index === lines.length - 1 || lines.slice(index + 1).every(line => !line)) break;
          throw new Error(`Corrupt append log record ${index + 1} in ${path}: ${(error as Error).message}`);
        }
      }
      return records;
    },
    append(record, effect) {
      if (closed) throw new Error("Append log closed");
      buffer.push(JSON.stringify(record));
      if (effect) effects.push(effect);
      appended++;
    },
    flush(durable = false) {
      return serialize(async () => {
        const file = await opened();
        await effected();
        if (buffer.length) {
          const batch = buffer;
          buffer = [];
          try { await file.appendFile(batch.join("\n") + "\n", "utf8"); }
          catch (error) { buffer = batch.concat(buffer); throw error; }
        }
        if (durable) await file.datasync();
      });
    },
    rewrite(snapshot) {
      return serialize(async () => {
        // The snapshot holds the buffered records: their effects go with it.
        await effected();
        const records = snapshot();
        buffer = [];
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        const temporary = `${path}.${randomUUID()}.tmp`;
        const file = await open(temporary, "wx", 0o600);
        try {
          if (records.length) await file.appendFile(records.map(record => JSON.stringify(record)).join("\n") + "\n", "utf8");
          await file.datasync();
        } finally { await file.close(); }
        await handle?.close();
        handle = undefined;
        await rename(temporary, path);
        const parent = openSync(dirname(path), "r");
        try { fsyncSync(parent); } finally { closeSync(parent); }
        appended = 0;
      });
    },
    get appendedSinceRewrite() { return appended; },
    close() {
      return serialize(async () => {
        closed = true;
        await handle?.close();
        handle = undefined;
      });
    },
  };
}
