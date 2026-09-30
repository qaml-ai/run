import type { Storage } from "../shared/storage.ts";
import type { Db } from "./db.ts";
import { validFileRef } from "./files.ts";
import { AgentSupervisor } from "./supervisor.ts";

/** What the backfill found for one tenant's agents. */
export type TenantPins = { tenant: string; agents: number; refs: number; chunks: number; missing: number; inserted: number; unreadable: number };

/** Every FileRef anywhere in `value`, however deeply nested. */
function collect(value: unknown, into: Set<string>, refs: { count: number }) {
  if (!value || typeof value !== "object") return;
  if (validFileRef(value)) {
    refs.count++;
    for (const hash of value.chunks) into.add(hash);
    return;
  }
  for (const entry of Array.isArray(value) ? value : Object.values(value)) collect(entry, into, refs);
}

/**
 * Pin (`chunk_pins`) the chunks of every FileRef each live agent holds: in its header (initialMessages), transcript
 * records (every message ever appended, not only the current history), journal (runs' presented files) and history
 * pages. FileRefs made before pins existed (migration 026) have none, and storage collection would take their
 * chunks once nothing else refers to them (storage-gc.ts). Idempotent; with `dryRun` it only counts.
 */
/**
 * The chunks of every FileRef `agent` holds, wherever it keeps them: its header (initialMessages), every transcript
 * record (messages a reset dropped too), its journal (runs' presented files) and its history pages. What cannot be
 * read is passed to `onError` and counted in `unreadable`.
 */
export async function agentChunks(options: { db: Db; storage: Storage; journalPrefix?: string; onError?: (what: string, error: unknown) => void }, agent: { id: string; header: unknown }) {
  const { db, storage } = options;
  const { id, header } = agent;
  const hashes = new Set<string>();
  const refs = { count: 0 };
  let unreadable = 0;
  const readLog = async (key: string) => {
    const log = storage.log<unknown>(key);
    try { return await log.read(); } finally { await log.close(); }
  };
  const read = async (what: string, load: () => Promise<unknown>) => {
    try { collect(await load(), hashes, refs); }
    catch (error) { unreadable++; options.onError?.(what, error); }
  };
  await read("header", async () => typeof header === "string" ? JSON.parse(header) : header);
  await read("transcript", () => readLog(AgentSupervisor.transcriptKey(id)));
  await read("journal", () => readLog(`${options.journalPrefix ?? "client-sessions/"}${id}.journal`));
  const { rows: pages } = await db.query("select start, count, hash from agent_history_chunks where agent = $1", [id]);
  for (const page of pages) {
    await read(`history ${page.start}`, async () => {
      const data = await storage.readBlob(`sessions/${id}/history/${page.start}-${page.count}-${page.hash}`);
      if (!data) throw new Error("history page is missing from storage");
      return JSON.parse(Buffer.from(data).toString("utf8"));
    });
  }
  return { hashes, refs: refs.count, unreadable };
}

export async function backfillPins(options: { db: Db; storage: Storage; journalPrefix?: string; dryRun?: boolean; tenant?: string; concurrency?: number; onError?: (agent: string, what: string, error: unknown) => void }) {
  const { db, storage, dryRun = false } = options;
  const journalPrefix = options.journalPrefix ?? "client-sessions/";
  const { rows: agents } = await db.query(
    "select id, tenant, header from agents where purged_at is null and ($1::text is null or tenant = $1) order by tenant, id", [options.tenant ?? null]);
  const tenants = new Map<string, TenantPins>();
  const one = async ({ id, tenant, header }: { id: string; tenant: string; header: unknown }) => {
    const totals = tenants.get(tenant) ?? { tenant, agents: 0, refs: 0, chunks: 0, missing: 0, inserted: 0, unreadable: 0 };
    tenants.set(tenant, totals);
    totals.agents++;
    const { hashes, refs, unreadable } = await agentChunks({ db, storage, journalPrefix, onError: (what, error) => options.onError?.(id, what, error) }, { id, header });
    totals.unreadable += unreadable;
    totals.refs += refs;
    totals.chunks += hashes.size;
    if (!hashes.size) return;
    const wanted = [...hashes];
    const { rows: held } = await db.query("select hash from chunk_pins where tenant = $1 and agent = $2 and hash = any($3::text[])", [tenant, id, wanted]);
    const missing = wanted.length - held.length;
    totals.missing += missing;
    if (dryRun || !missing) return;
    const { rowCount } = await db.query("insert into chunk_pins (tenant, hash, agent) select $1, hash, $3 from unnest($2::text[]) as hash on conflict do nothing", [tenant, wanted, id]);
    totals.inserted += rowCount ?? 0;
  };
  const queue = [...agents];
  await Promise.all(Array.from({ length: Math.max(1, options.concurrency ?? 8) }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      try { await one(next); }
      catch (error) {
        options.onError?.(next.id, "agent", error);
        const totals = tenants.get(next.tenant);
        if (totals) totals.unreadable++;
      }
    }
  }));
  return [...tenants.values()].sort((a, b) => a.tenant.localeCompare(b.tenant));
}
