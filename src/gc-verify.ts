import type { Storage } from "../shared/storage.ts";
import type { Db } from "./db.ts";
import { agentChunks } from "./pin-backfill.ts";

/** What the check found for one tenant's collection candidates (gc_candidates). */
export type TenantCheck = {
  tenant: string; candidates: number; due: number;
  /** Due candidates a live agent's FileRef refers to with no pin: collection would delete bytes an agent still holds. */
  unpinnedAgentRefs: string[];
  /** Of the hashes a dry run said it would remove (`logged`), those anything refers to: the collector's mark was wrong. */
  loggedReferenced: string[];
  /** Due candidates a live volume refers to again: the next pass's mark keeps them, as it should. */
  dueInVolumes: number;
  /** Candidates referred to again (pinned, or in a volume): the next pass drops them, as it should. */
  referencedAgain: number;
  /** Of `sample`, how many are already gone from storage. */
  missing: number;
  /** A few due hashes, for a spot check by hand. */
  sample: string[];
  unreadable: number;
};

/**
 * Check storage collection's candidates (storage-gc.ts) against everything that can refer to a chunk, read
 * independently of the collector: pins, live volumes' current files and snapshots, and every FileRef each live
 * agent holds (header, transcript, journal, history pages). Read-only. Collection's mark sees pins and volumes on each
 * pass, but not a FileRef without a pin: a due candidate one refers to would be deleted while needed. With `logged`
 * (the hashes storage_gc_dry_run lines named, by tenant), any of those referred to at all means the mark was wrong.
 * There should be neither before AGENT_GC_DRY_RUN is turned off.
 */
export async function verifyGcCandidates(options: { db: Db; storage: Storage; graceMs?: number; tenant?: string; sample?: number; now?: number; journalPrefix?: string; logged?: Map<string, string[]>; onError?: (what: string, error: unknown) => void }) {
  const { db, storage } = options;
  const graceMs = options.graceMs ?? 24 * 60 * 60_000;
  const now = options.now ?? Date.now();
  const { rows: found } = await db.query("select distinct tenant from gc_candidates where ($1::text is null or tenant = $1)", [options.tenant ?? null]);
  const tenantRows = [...new Set([...found.map(row => row.tenant as string), ...(options.logged?.keys() ?? [])])].filter(tenant => !options.tenant || tenant === options.tenant).sort().map(tenant => ({ tenant }));
  const results: TenantCheck[] = [];
  for (const { tenant } of tenantRows as { tenant: string }[]) {
    const check: TenantCheck = { tenant, candidates: 0, due: 0, unpinnedAgentRefs: [], loggedReferenced: [], dueInVolumes: 0, referencedAgain: 0, missing: 0, sample: [], unreadable: 0 };
    const report = (what: string) => (error: unknown) => { check.unreadable++; options.onError?.(`${tenant} ${what}`, error); };
    const { rows: candidates } = await db.query("select hash, first_seen from gc_candidates where tenant = $1", [tenant]);
    check.candidates = candidates.length;
    const due = new Set((candidates as { hash: string; first_seen: string }[]).filter(row => Number(row.first_seen) <= now - graceMs).map(row => row.hash));
    check.due = due.size;
    const pins = new Set((await db.query("select hash from chunk_pins where tenant = $1", [tenant])).rows.map(row => row.hash as string));

    // Live volumes' current files, folded from their trees, and their snapshots' file maps.
    const inVolumes = new Set<string>();
    const { rows: volumes } = await db.query("select id from volumes where tenant = $1 and deleted_at is null", [tenant]);
    for (const { id } of volumes as { id: string }[]) {
      try {
        const log = storage.log<{ t: string; path?: string; entry?: { chunks: string[] } }>(`volumes/${id}/tree`);
        const files = new Map<string, string[]>();
        try {
          for (const record of await log.read()) {
            if (record.t === "put" && record.path && record.entry) files.set(record.path, record.entry.chunks);
            else if (record.t === "del" && record.path) files.delete(record.path);
          }
        } finally { await log.close(); }
        for (const chunks of files.values()) for (const hash of chunks) inVolumes.add(hash);
      } catch (error) { report(`volume ${id}`)(error); }
    }
    const { rows: snapshots } = await db.query("select s.id, s.volume from volume_snapshots s join volumes v on v.id = s.volume where v.tenant = $1 and v.deleted_at is null", [tenant]);
    for (const { id, volume } of snapshots as { id: string; volume: string }[]) {
      try {
        const stored = await storage.readBlob(`volumes/${volume}/snapshots/${id}`);
        if (!stored) continue;
        for (const entry of Object.values(JSON.parse(Buffer.from(stored).toString("utf8")) as Record<string, { chunks: string[] }>)) for (const hash of entry.chunks) inVolumes.add(hash);
      } catch (error) { report(`snapshot ${volume}/${id}`)(error); }
    }

    // Every FileRef every live agent of the tenant holds.
    const inAgents = new Set<string>();
    const { rows: agents } = await db.query("select id, header from agents where tenant = $1 and purged_at is null", [tenant]);
    for (const agent of agents as { id: string; header: unknown }[]) {
      const found = await agentChunks({ db, storage, journalPrefix: options.journalPrefix, onError: (what, error) => report(`agent ${agent.id} ${what}`)(error) }, agent);
      for (const hash of found.hashes) inAgents.add(hash);
    }

    for (const { hash } of candidates as { hash: string }[]) {
      const referenced = pins.has(hash) || inVolumes.has(hash);
      if (referenced) check.referencedAgain++;
      if (!due.has(hash)) continue;
      if (inVolumes.has(hash)) check.dueInVolumes++;
      if (inAgents.has(hash) && !pins.has(hash)) check.unpinnedAgentRefs.push(hash);
    }
    for (const hash of options.logged?.get(tenant) ?? []) if (pins.has(hash) || inVolumes.has(hash) || inAgents.has(hash)) check.loggedReferenced.push(hash);
    const sample = [...due].filter(hash => !inVolumes.has(hash) && !inAgents.has(hash) && !pins.has(hash)).slice(0, options.sample ?? 5);
    for (const hash of sample) if (!await storage.readBlob(`chunks/${tenant}/${hash.slice(0, 2)}/${hash}`)) check.missing++;
    check.sample = sample;
    results.push(check);
  }
  return results;
}
