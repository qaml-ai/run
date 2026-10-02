import type { Storage } from "../shared/storage.ts";
import type { Db } from "./db.ts";
import { agentChunks } from "./pin-backfill.ts";

/** What the check found for one tenant: what refers to chunks, and which referred-to chunks are gone. */
export type TenantIntegrity = {
  tenant: string; agents: number; volumes: number; snapshots: number;
  /** Distinct chunks something live refers to, and how many of them storage has. */
  referenced: number; stored: number;
  /** Referred-to chunks storage does not have, each with one thing that refers to it (agent or volume id). */
  missing: number; missingSample: { hash: string; agent?: string; volume?: string }[];
  unreadable: number;
};

/**
 * Whether every chunk something live refers to is still stored: every FileRef each live agent holds (header,
 * transcript, journal, history pages) and every file in each live volume and its snapshots. Read-only; it lists each
 * tenant's chunks once rather than reading them, and reports ids and hashes, never contents.
 */
export async function checkStorageIntegrity(options: { db: Db; storage: Storage; tenant?: string; sample?: number; journalPrefix?: string; onError?: (what: string, error: unknown) => void }) {
  const { db, storage } = options;
  const limit = options.sample ?? 20;
  let sampled = 0;
  const { rows } = await db.query(`
    select tenant from agents where purged_at is null union select tenant from volumes where deleted_at is null`);
  const tenants = rows.map(row => row.tenant as string).filter(tenant => !options.tenant || tenant === options.tenant).sort();
  const results: TenantIntegrity[] = [];
  for (const tenant of tenants) {
    const result: TenantIntegrity = { tenant, agents: 0, volumes: 0, snapshots: 0, referenced: 0, stored: 0, missing: 0, missingSample: [], unreadable: 0 };
    const report = (what: string) => (error: unknown) => { result.unreadable++; options.onError?.(`${tenant} ${what}`, error); };
    // Each chunk with the first thing found to refer to it.
    const referrers = new Map<string, { agent?: string; volume?: string }>();
    const refer = (hashes: Iterable<string>, by: { agent?: string; volume?: string }) => { for (const hash of hashes) if (!referrers.has(hash)) referrers.set(hash, by); };

    const { rows: agents } = await db.query("select id, header from agents where tenant = $1 and purged_at is null", [tenant]);
    for (const agent of agents as { id: string; header: unknown }[]) {
      result.agents++;
      const found = await agentChunks({ db, storage, journalPrefix: options.journalPrefix, onError: (what, error) => report(`agent ${agent.id} ${what}`)(error) }, agent);
      refer(found.hashes, { agent: agent.id });
    }
    const { rows: volumes } = await db.query("select id from volumes where tenant = $1 and deleted_at is null", [tenant]);
    for (const { id } of volumes as { id: string }[]) {
      result.volumes++;
      try {
        const log = storage.log<{ t: string; path?: string; entry?: { chunks: string[] } }>(`volumes/${id}/tree`);
        const files = new Map<string, string[]>();
        try {
          for (const record of await log.read()) {
            if (record.t === "put" && record.path && record.entry) files.set(record.path, record.entry.chunks);
            else if (record.t === "del" && record.path) files.delete(record.path);
          }
        } finally { await log.close(); }
        for (const chunks of files.values()) refer(chunks, { volume: id });
      } catch (error) { report(`volume ${id}`)(error); }
    }
    const { rows: snapshots } = await db.query("select s.id, s.volume from volume_snapshots s join volumes v on v.id = s.volume where v.tenant = $1 and v.deleted_at is null", [tenant]);
    for (const { id, volume } of snapshots as { id: string; volume: string }[]) {
      result.snapshots++;
      try {
        const stored = await storage.readBlob(`volumes/${volume}/snapshots/${id}`);
        if (!stored) throw new Error("snapshot file map is missing from storage");
        for (const entry of Object.values(JSON.parse(Buffer.from(stored).toString("utf8")) as Record<string, { chunks: string[] }>)) refer(entry.chunks, { volume });
      } catch (error) { report(`snapshot ${volume}/${id}`)(error); }
    }

    result.referenced = referrers.size;
    // What storage holds for the tenant: one listing, else (a Storage that cannot list) a read of each chunk.
    let present: (hash: string) => Promise<boolean>;
    if (storage.objects) {
      const held = new Set<string>();
      for await (const { key } of storage.objects(`chunks/${tenant}/`)) {
        const hash = /([a-f0-9]{64})(?:\.bin)?$/.exec(key)?.[1];
        if (hash) held.add(hash);
      }
      present = async hash => held.has(hash);
    } else present = async hash => !!await storage.readBlob(`chunks/${tenant}/${hash.slice(0, 2)}/${hash}`);
    for (const [hash, by] of referrers) {
      if (await present(hash)) { result.stored++; continue; }
      result.missing++;
      if (sampled < limit) { result.missingSample.push({ hash, ...by }); sampled++; }
    }
    results.push(result);
  }
  return results;
}
