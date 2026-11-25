import { DurableObject } from "cloudflare:workers";
import { randomId, sha256Hex } from "../crypto.ts";
import { ApiError, type Env, type RpcStub } from "../types.ts";
import type {
  CamelFsCommitInfo,
  CamelFsGrepResponse,
  CamelFsLsResponse,
  CamelFsReadResponse,
  CamelFsRefInfo,
  CamelFsVmExecRequest,
  CamelFsVmExecResult,
  CamelFsVmInfo,
  CamelFsWriteRequest,
  CamelFsWriteResponse,
} from "../camelfs.ts";
import { callContainerDaemon, destroyContainerInstance } from "./container-do.ts";
import {
  base64ToBytes,
  buildReadResponse,
  bytesToBase64,
  DEFAULT_FILE_MODE,
  DEFAULT_REF,
  encodeCommitBytes,
  encodeTreeBytes,
  encodeVmId,
  filterListEntries,
  getCommit,
  getObject,
  getTree,
  grepTextLines,
  hashObject,
  normalizeRelPath,
  putCommit,
  putObject,
  putObjectsParallel,
  putTree,
  type CommitObject,
  type GrepMatch,
  type ObjectKind,
  type TreeEntry,
  type WriteDurabilityMode,
} from "./objects.ts";

interface LineageRow {
  lineage: string;
  tenant_id: string;
  default_ref: string;
  created_at: number;
}

interface RefRow {
  name: string;
  commit_hash: string;
  tree_hash: string;
  updated_at: number;
  lease_holder: string | null;
  lease_epoch: number;
  lease_expires_at: number;
}

interface VmRow {
  vm_id: string;
  ref: string;
  holder: string;
  lease_epoch: number;
  state: "running" | "stopped" | "lost";
  head_commit: string;
  vcpus: number;
  memory_mib: number;
  idle_timeout_s: number;
  created_at: number;
  last_active_at: number;
  lease_expires_at: number;
  total_duration_ms: number;
  billed_ms: number;
}

interface ContainerDeltaResponse {
  puts: Array<{ path: string; mode: number; base64?: string; linkTarget?: string }>;
  deletes: string[];
}

interface ContainerExecResponse {
  exitCode: number;
  stdout: string;
  stderr: string;
  cwd: string;
  timedOut: boolean;
}

interface WorkspaceFileOp {
  kind: "put" | "delete" | "move";
  path: string;
  from?: string;
  mode?: number;
  base64?: string;
}

export interface BootVmInput {
  lineage: string;
  ref?: string;
  holder?: string;
  vcpus?: number;
  memoryMiB?: number;
  idleTimeoutS?: number;
  leaseS?: number;
  env?: Record<string, string>;
}

const encoder = new TextEncoder();
const HOT_BLOB_MAX_BYTES = 256 * 1024;

function toBytes(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  return new Uint8Array(0);
}

export function getCamelfsLineageStub(env: Env, lineage: string): RpcStub<CamelfsLineageDO> {
  if (!env.CAMELFS_LINEAGE_DO) {
    throw new ApiError(503, "camelfs_not_configured", "CAMELFS_LINEAGE_DO binding is not configured");
  }
  return env.CAMELFS_LINEAGE_DO.get(
    env.CAMELFS_LINEAGE_DO.idFromName(lineage),
  ) as unknown as RpcStub<CamelfsLineageDO>;
}

export async function deriveCamelfsInternalToken(env: Pick<Env, "CAMELFS_INTERNAL_SECRET" | "VAULT_SECRET">): Promise<string> {
  if (env.CAMELFS_INTERNAL_SECRET?.trim()) {
    return env.CAMELFS_INTERNAL_SECRET.trim();
  }
  return sha256Hex(`camelfs-internal:${env.VAULT_SECRET || "dev"}`);
}

/**
 * CamelfsLineageDO is a per-lineage Cloudflare SQLite Durable Object implementing the full
 * camelFS repository + session VM control plane with:
 *   - Atomic SQLite transactions for refs, leases, CAS, and CompleteExec idempotency receipts
 *   - Hot DO SQLite write-through cache (trees, commits, and blobs <= 256 KiB) for ~40-75ms edge ops
 *   - Non-blocking R2 archival via `ctx.waitUntil` + DO `alarm()` retry safety net
 *   - Deterministic SHA-256 parallel R2 uploads for large files, forks, and container checkpoints
 */
export class CamelfsLineageDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private flushInFlight: Promise<number> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.initSchema();
  }

  private get bucket(): R2Bucket {
    if (!this.env.CAMELFS_BUCKET) {
      throw new ApiError(503, "camelfs_not_configured", "CAMELFS_BUCKET R2 binding is not configured");
    }
    return this.env.CAMELFS_BUCKET;
  }

  private initSchema(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS lineage_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        lineage TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        default_ref TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS refs (
        name TEXT PRIMARY KEY,
        commit_hash TEXT NOT NULL,
        tree_hash TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        lease_holder TEXT,
        lease_epoch INTEGER NOT NULL DEFAULT 0,
        lease_expires_at INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS vms (
        vm_id TEXT PRIMARY KEY,
        ref TEXT NOT NULL,
        holder TEXT NOT NULL,
        lease_epoch INTEGER NOT NULL,
        state TEXT NOT NULL,
        head_commit TEXT NOT NULL,
        vcpus INTEGER NOT NULL,
        memory_mib INTEGER NOT NULL,
        idle_timeout_s INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        last_active_at INTEGER NOT NULL,
        lease_expires_at INTEGER NOT NULL,
        total_duration_ms INTEGER NOT NULL DEFAULT 0,
        billed_ms INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS exec_receipts (
        vm_id TEXT NOT NULL,
        exec_id TEXT NOT NULL,
        response_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (vm_id, exec_id)
      );

      CREATE TABLE IF NOT EXISTS meta_objects (
        hash TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        json_body TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS hot_blobs (
        hash TEXT PRIMARY KEY,
        data BLOB NOT NULL,
        size INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS r2_outbox (
        hash TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        data BLOB NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
  }

  private getHotBlob(hash: string): Uint8Array | null {
    const rows = this.sql
      .exec(`SELECT data FROM hot_blobs WHERE hash = ?`, hash)
      .toArray() as unknown as Array<{ data: unknown }>;
    return rows[0] ? toBytes(rows[0].data) : null;
  }

  private async getBlobFast(hash: string, bypassCache = false): Promise<Uint8Array> {
    if (!bypassCache) {
      const cached = this.getHotBlob(hash);
      if (cached) return cached;
    }
    const { data } = await getObject(this.bucket, hash, "blob");
    if (!bypassCache && data.byteLength <= HOT_BLOB_MAX_BYTES) {
      this.sql.exec(
        `INSERT OR IGNORE INTO hot_blobs (hash, data, size, updated_at) VALUES (?, ?, ?, ?)`,
        hash,
        data,
        data.byteLength,
        Date.now(),
      );
    }
    return data;
  }

  private countOutbox(): number {
    const rows = this.sql.exec(`SELECT COUNT(*) AS n FROM r2_outbox`).toArray() as unknown as Array<{ n: number }>;
    return Number(rows[0]?.n ?? 0);
  }

  async outboxStatus(opts?: { flush?: boolean }): Promise<{ pending: number; flushed: number }> {
    let flushed = 0;
    if (opts?.flush) {
      flushed = await this.flushOutboxToR2();
    }
    return { pending: this.countOutbox(), flushed };
  }

  async flushOutboxToR2(): Promise<number> {
    if (this.flushInFlight) {
      return this.flushInFlight;
    }
    const run = (async () => {
      let totalFlushed = 0;
      for (;;) {
        const rows = this.sql
          .exec(`SELECT hash, kind, data FROM r2_outbox ORDER BY created_at ASC LIMIT 18`)
          .toArray() as unknown as Array<{ hash: string; kind: ObjectKind; data: unknown }>;
        if (rows.length === 0) break;
        const items = rows.map((r) => ({
          kind: r.kind,
          hash: r.hash,
          data: toBytes(r.data),
        }));
        await putObjectsParallel(this.bucket, items, 6);
        this.ctx.storage.transactionSync(() => {
          for (const it of items) {
            this.sql.exec(`DELETE FROM r2_outbox WHERE hash = ?`, it.hash);
          }
        });
        totalFlushed += items.length;
      }
      return totalFlushed;
    })();
    this.flushInFlight = run;
    try {
      return await run;
    } finally {
      if (this.flushInFlight === run) {
        this.flushInFlight = null;
      }
    }
  }

  private triggerAsyncOutboxFlush(): void {
    this.ctx.waitUntil(
      this.flushOutboxToR2().catch(async () => {
        await this.ctx.storage.setAlarm(Date.now() + 5_000).catch(() => {});
      }),
    );
  }

  private async getCommitFast(hash: string): Promise<CommitObject> {
    const cached = this.sql
      .exec(`SELECT json_body FROM meta_objects WHERE hash = ? AND kind = 'commit'`, hash)
      .toArray() as unknown as Array<{ json_body: string }>;
    if (cached[0]) {
      return JSON.parse(cached[0].json_body) as CommitObject;
    }
    const c = await getCommit(this.bucket, hash);
    this.sql.exec(
      `INSERT OR IGNORE INTO meta_objects (hash, kind, json_body) VALUES (?, 'commit', ?)`,
      hash,
      JSON.stringify(c),
    );
    return c;
  }

  private async getTreeFast(hash: string): Promise<TreeEntry[]> {
    if (!hash) return [];
    const cached = this.sql
      .exec(`SELECT json_body FROM meta_objects WHERE hash = ? AND kind = 'tree'`, hash)
      .toArray() as unknown as Array<{ json_body: string }>;
    if (cached[0]) {
      return JSON.parse(cached[0].json_body) as TreeEntry[];
    }
    const entries = await getTree(this.bucket, hash);
    this.sql.exec(
      `INSERT OR IGNORE INTO meta_objects (hash, kind, json_body) VALUES (?, 'tree', ?)`,
      hash,
      JSON.stringify(entries),
    );
    return entries;
  }

  private async putTreeFast(entries: TreeEntry[]): Promise<string> {
    const hash = await putTree(this.bucket, entries);
    this.sql.exec(
      `INSERT OR IGNORE INTO meta_objects (hash, kind, json_body) VALUES (?, 'tree', ?)`,
      hash,
      JSON.stringify(entries),
    );
    return hash;
  }

  private async putCommitFast(commit: CommitObject): Promise<string> {
    const hash = await putCommit(this.bucket, commit);
    this.sql.exec(
      `INSERT OR IGNORE INTO meta_objects (hash, kind, json_body) VALUES (?, 'commit', ?)`,
      hash,
      JSON.stringify(commit),
    );
    return hash;
  }

  private getLineageMeta(): LineageRow | null {
    const rows = this.sql
      .exec(`SELECT lineage, tenant_id, default_ref, created_at FROM lineage_meta WHERE id = 1`)
      .toArray() as unknown as LineageRow[];
    return rows[0] ?? null;
  }

  private requireLineage(): LineageRow {
    const meta = this.getLineageMeta();
    if (!meta) {
      throw new ApiError(404, "not_found", "lineage not found");
    }
    return meta;
  }

  private rowToRefInfo(r: RefRow, now: number): CamelFsRefInfo {
    const info: CamelFsRefInfo = {
      name: r.name,
      commit: r.commit_hash,
      tree: r.tree_hash,
      updatedAt: r.updated_at,
    };
    if (r.lease_holder && r.lease_expires_at > now) {
      info.lease = {
        holder: r.lease_holder,
        epoch: r.lease_epoch,
        expiresAt: r.lease_expires_at,
      };
    }
    return info;
  }

  private getRefRow(name: string): RefRow | null {
    const rows = this.sql
      .exec(
        `SELECT name, commit_hash, tree_hash, updated_at, lease_holder, lease_epoch, lease_expires_at
         FROM refs WHERE name = ?`,
        name,
      )
      .toArray() as unknown as RefRow[];
    return rows[0] ?? null;
  }

  private getRunningVmByRef(refName: string): VmRow | null {
    const rows = this.sql
      .exec(`SELECT * FROM vms WHERE ref = ? AND state = 'running' LIMIT 1`, refName)
      .toArray() as unknown as VmRow[];
    return rows[0] ?? null;
  }

  private getVmRow(vmId: string): VmRow | null {
    const rows = this.sql
      .exec(`SELECT * FROM vms WHERE vm_id = ?`, vmId)
      .toArray() as unknown as VmRow[];
    return rows[0] ?? null;
  }

  private resolveRefName(at?: string): string | null {
    const target = (at ?? "").trim() || DEFAULT_REF;
    if (this.getRefRow(target)) return target;
    if (!target.startsWith("refs/") && target.length !== 64) {
      const qualified = `refs/heads/${target}`;
      if (this.getRefRow(qualified)) return qualified;
    }
    return null;
  }

  private async resolveCommit(refOrCommit?: string): Promise<{ hash: string; commit: CommitObject }> {
    const target = (refOrCommit ?? "").trim() || DEFAULT_REF;
    const candidates = target.startsWith("refs/") ? [target] : [target, `refs/heads/${target}`];
    for (const c of candidates) {
      const row = this.getRefRow(c);
      if (row) {
        const commit = await this.getCommitFast(row.commit_hash);
        return { hash: row.commit_hash, commit };
      }
    }
    if (target.length === 64) {
      const commit = await this.resolveLineageCommit(target);
      return { hash: target, commit };
    }
    throw new ApiError(404, "not_found", `ref or commit "${target}" not found`);
  }

  private async resolveLineageCommit(targetHash: string): Promise<CommitObject> {
    const refs = this.sql.exec(`SELECT commit_hash FROM refs`).toArray() as unknown as Array<{
      commit_hash: string;
    }>;
    const queue = refs.map((r) => r.commit_hash);
    const seen = new Set<string>();
    while (queue.length > 0) {
      const h = queue.shift()!;
      if (!h || seen.has(h)) continue;
      seen.add(h);
      const c = await this.getCommitFast(h);
      if (h === targetHash) return c;
      for (const p of c.parents) {
        if (!seen.has(p)) queue.push(p);
      }
    }
    throw new ApiError(404, "not_found", `commit "${targetHash}" not found in lineage`);
  }

  // ---- Repository / Lineage RPC methods ----

  async createLineage(req: {
    lineage: string;
    tenantId?: string;
    initialCommit?: string;
    initialTree?: string;
    initialCommitObj?: CommitObject;
    initialTreeEntries?: TreeEntry[];
    defaultRef?: string;
    failIfExists?: boolean;
  }): Promise<{ lineage: string; defaultRef: string; commit: string; tree: string }> {
    const existing = this.getLineageMeta();
    if (existing) {
      if (req.failIfExists) {
        throw new ApiError(409, "cas_conflict", `target lineage "${req.lineage}" already exists`);
      }
      const defRef = this.getRefRow(existing.default_ref);
      if (!defRef) throw new ApiError(500, "internal", "lineage missing default ref");
      return {
        lineage: existing.lineage,
        defaultRef: existing.default_ref,
        commit: defRef.commit_hash,
        tree: defRef.tree_hash,
      };
    }

    const now = Date.now();
    const defaultRef = (req.defaultRef ?? "").trim() || DEFAULT_REF;
    const tenantId = (req.tenantId ?? "").trim() || "default";

    let treeHash = req.initialTree ?? "";
    let commitHash = req.initialCommit ?? "";
    let initTreeBytes: Uint8Array | null = null;
    let initCommitBytes: Uint8Array | null = null;
    let initCommitObj: CommitObject | null = req.initialCommitObj ?? null;
    let initTreeEntries: TreeEntry[] | null = req.initialTreeEntries ?? null;

    if (!commitHash) {
      initTreeEntries = [];
      initTreeBytes = encodeTreeBytes(initTreeEntries);
      treeHash = await hashObject("tree", initTreeBytes);
      initCommitObj = {
        tree: treeHash,
        parents: [],
        author: "system",
        message: "initial commit",
        createdAt: now,
      };
      initCommitBytes = encodeCommitBytes(initCommitObj);
      commitHash = await hashObject("commit", initCommitBytes);
    }

    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        `INSERT INTO lineage_meta (id, lineage, tenant_id, default_ref, created_at)
         VALUES (1, ?, ?, ?, ?)`,
        req.lineage,
        tenantId,
        defaultRef,
        now,
      );
      this.sql.exec(
        `INSERT INTO refs (name, commit_hash, tree_hash, updated_at, lease_holder, lease_epoch, lease_expires_at)
         VALUES (?, ?, ?, ?, NULL, 0, 0)`,
        defaultRef,
        commitHash,
        treeHash,
        now,
      );
      if (initTreeEntries) {
        this.sql.exec(
          `INSERT OR IGNORE INTO meta_objects (hash, kind, json_body) VALUES (?, 'tree', ?)`,
          treeHash,
          JSON.stringify(initTreeEntries),
        );
      }
      if (initCommitObj) {
        this.sql.exec(
          `INSERT OR IGNORE INTO meta_objects (hash, kind, json_body) VALUES (?, 'commit', ?)`,
          commitHash,
          JSON.stringify(initCommitObj),
        );
      }
      if (initTreeBytes && initCommitBytes) {
        this.sql.exec(
          `INSERT OR IGNORE INTO r2_outbox (hash, kind, data, created_at) VALUES (?, 'tree', ?, ?)`,
          treeHash,
          initTreeBytes,
          now,
        );
        this.sql.exec(
          `INSERT OR IGNORE INTO r2_outbox (hash, kind, data, created_at) VALUES (?, 'commit', ?, ?)`,
          commitHash,
          initCommitBytes,
          now,
        );
      }
    });

    if (initTreeBytes && initCommitBytes) {
      this.triggerAsyncOutboxFlush();
    }

    return { lineage: req.lineage, defaultRef, commit: commitHash, tree: treeHash };
  }

  /**
   * Idempotently imports an existing lineage + refs migrated from AWS DynamoDB.
   * Never overwrites a ref that already has a strictly newer updatedAt timestamp in Cloudflare,
   * making re-runs and post-cutover delta sync passes completely safe.
   */
  async importLineage(req: {
    lineage: string;
    tenantId: string;
    defaultRef: string;
    createdAt: number;
    refs: Array<{
      name: string;
      commit: string;
      tree: string;
      updatedAt: number;
    }>;
  }): Promise<{ lineage: string; importedRefs: number; skippedNewerRefs: number }> {
    const defaultRef = (req.defaultRef ?? "").trim() || DEFAULT_REF;
    const tenantId = (req.tenantId ?? "").trim() || "default";
    const createdAt = req.createdAt || Date.now();
    let importedRefs = 0;
    let skippedNewerRefs = 0;

    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        `INSERT OR IGNORE INTO lineage_meta (id, lineage, tenant_id, default_ref, created_at)
         VALUES (1, ?, ?, ?, ?)`,
        req.lineage,
        tenantId,
        defaultRef,
        createdAt,
      );
      for (const r of req.refs) {
        const refName = (r.name ?? "").trim();
        if (!refName || !r.commit) continue;
        const existing = this.getRefRow(refName);
        if (existing && existing.updated_at >= r.updatedAt) {
          skippedNewerRefs++;
          continue;
        }
        this.sql.exec(
          `INSERT INTO refs (name, commit_hash, tree_hash, updated_at, lease_holder, lease_epoch, lease_expires_at)
           VALUES (?, ?, ?, ?, NULL, 0, 0)
           ON CONFLICT(name) DO UPDATE SET
             commit_hash = excluded.commit_hash,
             tree_hash = excluded.tree_hash,
             updated_at = excluded.updated_at`,
          refName,
          r.commit,
          r.tree ?? "",
          r.updatedAt || createdAt,
        );
        importedRefs++;
      }
    });

    return { lineage: req.lineage, importedRefs, skippedNewerRefs };
  }

  async deleteLineage(): Promise<{ deleted: boolean }> {
    this.requireLineage();
    const runningVms = this.sql
      .exec(`SELECT vm_id FROM vms WHERE state = 'running'`)
      .toArray() as unknown as Array<{ vm_id: string }>;
    for (const vm of runningVms) {
      await callContainerDaemon(this.env, vm.vm_id, "/unmount", "POST", { vmId: vm.vm_id }).catch(() => {});
      await destroyContainerInstance(this.env, vm.vm_id).catch(() => {});
    }
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(`DELETE FROM exec_receipts`);
      this.sql.exec(`DELETE FROM vms`);
      this.sql.exec(`DELETE FROM refs`);
      this.sql.exec(`DELETE FROM lineage_meta`);
      this.sql.exec(`DELETE FROM r2_outbox`);
      this.sql.exec(`DELETE FROM hot_blobs`);
      this.sql.exec(`DELETE FROM meta_objects`);
    });
    return { deleted: true };
  }

  async forkLineage(req: {
    targetLineage?: string;
    sourceRef?: string;
    targetRef?: string;
    atCommit?: string;
    tenantId?: string;
  }): Promise<{ lineage: string; ref: string; commit: string; tree: string }> {
    const meta = this.requireLineage();
    const targetLineage = (req.targetLineage ?? "").trim() || randomId("lin");
    if (targetLineage.includes("/")) {
      throw new ApiError(400, "invalid_request", "targetLineage must not contain '/'");
    }
    const targetRef = (req.targetRef ?? "").trim() || DEFAULT_REF;
    const resolved = await this.resolveCommit(req.atCommit?.trim() || req.sourceRef?.trim() || DEFAULT_REF);
    const treeEntries = await this.getTreeFast(resolved.commit.tree);

    // Ensure all blobs referenced by this lineage are durable in R2 before returning the fork handle.
    if (this.countOutbox() > 0) {
      await this.flushOutboxToR2();
    }

    const targetStub = getCamelfsLineageStub(this.env, targetLineage);
    await targetStub.createLineage({
      lineage: targetLineage,
      tenantId: req.tenantId || meta.tenant_id,
      defaultRef: targetRef,
      initialCommit: resolved.hash,
      initialTree: resolved.commit.tree,
      initialCommitObj: resolved.commit,
      initialTreeEntries: treeEntries,
      failIfExists: true,
    });

    return {
      lineage: targetLineage,
      ref: targetRef,
      commit: resolved.hash,
      tree: resolved.commit.tree,
    };
  }

  async listRefs(prefix?: string): Promise<{ refs: CamelFsRefInfo[] }> {
    this.requireLineage();
    const now = Date.now();
    const rows = this.sql
      .exec(
        `SELECT name, commit_hash, tree_hash, updated_at, lease_holder, lease_epoch, lease_expires_at
         FROM refs ORDER BY name ASC`,
      )
      .toArray() as unknown as RefRow[];
    const pfx = (prefix ?? "").trim();
    const refs = rows
      .filter((r) => !pfx || r.name.startsWith(pfx))
      .map((r) => this.rowToRefInfo(r, now));
    return { refs };
  }

  async setRef(req: {
    ref: string;
    commit?: string;
    expectedCommit?: string;
    holder?: string;
    delete?: boolean;
  }): Promise<{ ref: string; commit: string; tree: string }> {
    this.requireLineage();
    const refName = (req.ref ?? "").trim();
    if (!refName) throw new ApiError(400, "invalid_request", "ref is required");

    let treeHash = "";
    if (!req.delete) {
      if (!req.commit?.trim()) {
        throw new ApiError(400, "invalid_request", "commit is required when not deleting ref");
      }
      const c = await this.resolveLineageCommit(req.commit.trim());
      treeHash = c.tree;
    }

    const now = Date.now();
    const runningVm = this.getRunningVmByRef(refName);
    if (runningVm && runningVm.lease_expires_at > now && runningVm.holder !== (req.holder ?? "")) {
      throw new ApiError(409, "ref_leased", `ref "${refName}" has an active VM leased by "${runningVm.holder}"`);
    }

    const existing = this.getRefRow(refName);
    if (existing && existing.lease_holder && existing.lease_expires_at > now && existing.lease_holder !== (req.holder ?? "")) {
      throw new ApiError(409, "ref_leased", `ref "${refName}" is leased by "${existing.lease_holder}"`);
    }
    if (req.expectedCommit && (!existing || existing.commit_hash !== req.expectedCommit)) {
      throw new ApiError(
        409,
        "cas_conflict",
        `expected commit "${req.expectedCommit}" on ref "${refName}", got "${existing?.commit_hash ?? ""}"`,
      );
    }

    if (req.delete) {
      if (!existing) throw new ApiError(404, "not_found", `ref "${refName}" not found`);
      this.sql.exec(`DELETE FROM refs WHERE name = ?`, refName);
      return { ref: refName, commit: "", tree: "" };
    }

    const commitHash = req.commit!.trim();
    this.sql.exec(
      `INSERT INTO refs (name, commit_hash, tree_hash, updated_at, lease_holder, lease_epoch, lease_expires_at)
       VALUES (?, ?, ?, ?, NULL, 0, 0)
       ON CONFLICT(name) DO UPDATE SET
         commit_hash = excluded.commit_hash,
         tree_hash = excluded.tree_hash,
         updated_at = excluded.updated_at`,
      refName,
      commitHash,
      treeHash,
      now,
    );

    if (runningVm) {
      await this.stopVmInternal(runningVm.vm_id, false);
    }

    return { ref: refName, commit: commitHash, tree: treeHash };
  }

  async leaseRef(req: {
    ref?: string;
    holder: string;
    ttlMs?: number;
    release?: boolean;
    expectedEpoch?: number;
  }): Promise<{
    ref: string;
    commit: string;
    tree: string;
    holder: string;
    epoch: number;
    expiresAt: number;
  }> {
    this.requireLineage();
    const refName = (req.ref ?? "").trim() || DEFAULT_REF;
    const holder = (req.holder ?? "").trim();
    if (!holder) throw new ApiError(400, "invalid_request", "holder is required");
    const ttlMs = req.ttlMs && req.ttlMs > 0 ? req.ttlMs : 600_000;
    const now = Date.now();

    const row = this.getRefRow(refName);
    if (!row) throw new ApiError(404, "not_found", `ref "${refName}" not found`);

    const activeLease = row.lease_holder && row.lease_expires_at > now;
    if (req.release) {
      if (activeLease && row.lease_holder !== holder) {
        throw new ApiError(409, "ref_leased", `ref "${refName}" is leased by "${row.lease_holder}"`);
      }
      if (!req.expectedEpoch || row.lease_epoch === req.expectedEpoch) {
        this.sql.exec(`UPDATE refs SET lease_holder = NULL, lease_expires_at = 0 WHERE name = ?`, refName);
      }
      return {
        ref: refName,
        commit: row.commit_hash,
        tree: row.tree_hash,
        holder,
        epoch: row.lease_epoch,
        expiresAt: 0,
      };
    }

    if (activeLease && row.lease_holder !== holder) {
      throw new ApiError(409, "ref_leased", `ref "${refName}" is leased by "${row.lease_holder}"`);
    }

    const nextEpoch = row.lease_epoch + 1;
    const expiresAt = now + ttlMs;
    this.sql.exec(
      `UPDATE refs SET lease_holder = ?, lease_epoch = ?, lease_expires_at = ? WHERE name = ?`,
      holder,
      nextEpoch,
      expiresAt,
      refName,
    );
    return {
      ref: refName,
      commit: row.commit_hash,
      tree: row.tree_hash,
      holder,
      epoch: nextEpoch,
      expiresAt,
    };
  }

  async write(req: CamelFsWriteRequest & { durability?: WriteDurabilityMode }): Promise<CamelFsWriteResponse> {
    this.requireLineage();
    const refName = (req.ref ?? "").trim() || DEFAULT_REF;
    const holder = (req.holder ?? "").trim();
    const author = (req.author ?? "").trim() || (holder ? `agent:${holder}` : "system");
    const message = (req.message ?? "").trim() || "write";
    const now = Date.now();

    const curRef = this.getRefRow(refName);
    if (!curRef) throw new ApiError(404, "not_found", `ref "${refName}" not found`);
    if (curRef.lease_holder && curRef.lease_expires_at > now && curRef.lease_holder !== holder) {
      throw new ApiError(409, "ref_leased", `ref "${refName}" is leased by "${curRef.lease_holder}"`);
    }
    if (req.expectedCommit && curRef.commit_hash !== req.expectedCommit) {
      throw new ApiError(
        409,
        "cas_conflict",
        `expected commit "${req.expectedCommit}" on ref "${refName}", got "${curRef.commit_hash}"`,
      );
    }

    const runningVm = this.getRunningVmByRef(refName);
    if (runningVm && runningVm.holder !== holder) {
      if (runningVm.lease_expires_at <= now) {
        await this.stopVmInternal(runningVm.vm_id, true);
      } else {
        throw new ApiError(
          409,
          "ref_leased",
          `ref "${refName}" has an active VM (${runningVm.vm_id}) leased by "${runningVm.holder}"`,
        );
      }
    }

    const latestRef = this.getRefRow(refName)!;
    const entries = await this.getTreeFast(latestRef.tree_hash);
    const treeMap = new Map<string, TreeEntry>(entries.map((e) => [e.path, e]));

    const vmOps: WorkspaceFileOp[] = [];
    const changedSet = new Set<string>();
    let totalBytes = 0;

    for (const mv of req.moves ?? []) {
      const from = normalizeRelPath(mv.from, false);
      const to = normalizeRelPath(mv.to, false);
      const src = treeMap.get(from);
      if (!src) throw new ApiError(404, "not_found", `move source "${from}" does not exist`);
      treeMap.delete(from);
      treeMap.set(to, { ...src, path: to });
      changedSet.add(from);
      changedSet.add(to);
      vmOps.push({ kind: "move", from, path: to });
    }

    for (const d of req.deletes ?? []) {
      const norm = normalizeRelPath(d, false);
      treeMap.delete(norm);
      changedSet.add(norm);
      vmOps.push({ kind: "delete", path: norm });
    }

    const durability: WriteDurabilityMode = req.durability ?? "sqlite_async_r2";

    const preparedPuts = (req.puts ?? []).map((p) => {
      const norm = normalizeRelPath(p.path, false);
      const data = p.base64 ? base64ToBytes(p.base64) : encoder.encode(p.content ?? "");
      const mode = p.mode || DEFAULT_FILE_MODE;
      return { norm, data, mode, b64: p.base64 };
    });

    const blobHashes = await Promise.all(preparedPuts.map((item) => hashObject("blob", item.data)));
    preparedPuts.forEach((item, idx) => {
      treeMap.set(item.norm, {
        path: item.norm,
        type: "file",
        size: item.data.byteLength,
        mode: item.mode,
        hash: blobHashes[idx],
      });
      totalBytes += item.data.byteLength;
      changedSet.add(item.norm);
      vmOps.push({
        kind: "put",
        path: item.norm,
        mode: item.mode,
        base64: item.b64 ?? bytesToBase64(item.data),
      });
    });

    const newTreeEntries = [...treeMap.values()];
    const newTreeBytes = encodeTreeBytes(newTreeEntries);
    const newTreeHash = await hashObject("tree", newTreeBytes);
    const newCommitObj: CommitObject = {
      tree: newTreeHash,
      parents: [latestRef.commit_hash],
      author,
      message,
      createdAt: now,
    };
    const newCommitBytes = encodeCommitBytes(newCommitObj);
    const newCommitHash = await hashObject("commit", newCommitBytes);

    const outboxToEnqueue: Array<{ kind: ObjectKind; hash: string; data: Uint8Array }> = [];

    if (durability === "serial_r2") {
      for (let i = 0; i < preparedPuts.length; i += 5) {
        const batch = preparedPuts.slice(i, i + 5);
        await Promise.all(batch.map((item) => putObject(this.bucket, "blob", item.data)));
      }
      await this.putTreeFast(newTreeEntries);
      await this.putCommitFast(newCommitObj);
    } else if (durability === "parallel_r2") {
      const allObjects: Array<{ kind: ObjectKind; hash: string; data: Uint8Array }> = [
        ...preparedPuts.map((item, idx) => ({
          kind: "blob" as const,
          hash: blobHashes[idx],
          data: item.data,
        })),
        { kind: "tree", hash: newTreeHash, data: newTreeBytes },
        { kind: "commit", hash: newCommitHash, data: newCommitBytes },
      ];
      await putObjectsParallel(this.bucket, allObjects, 6);
    } else {
      const largeBlobs: Array<{ kind: ObjectKind; hash: string; data: Uint8Array }> = [];
      preparedPuts.forEach((item, idx) => {
        if (item.data.byteLength > HOT_BLOB_MAX_BYTES) {
          largeBlobs.push({ kind: "blob", hash: blobHashes[idx], data: item.data });
        } else {
          outboxToEnqueue.push({ kind: "blob", hash: blobHashes[idx], data: item.data });
        }
      });
      if (largeBlobs.length > 0) {
        await putObjectsParallel(this.bucket, largeBlobs, 6);
      }
      outboxToEnqueue.push(
        { kind: "tree", hash: newTreeHash, data: newTreeBytes },
        { kind: "commit", hash: newCommitHash, data: newCommitBytes },
      );
    }

    const liveVm = this.getRunningVmByRef(refName);
    if (liveVm && liveVm.holder === holder && vmOps.length > 0) {
      await callContainerDaemon(this.env, liveVm.vm_id, "/apply_ops", "POST", {
        vmId: liveVm.vm_id,
        ops: vmOps,
      });
    }

    this.ctx.storage.transactionSync(() => {
      const current = this.getRefRow(refName);
      if (!current || current.commit_hash !== latestRef.commit_hash) {
        throw new ApiError(409, "cas_conflict", `concurrent write on ref "${refName}"`);
      }
      this.sql.exec(
        `UPDATE refs SET commit_hash = ?, tree_hash = ?, updated_at = ? WHERE name = ?`,
        newCommitHash,
        newTreeHash,
        now,
        refName,
      );
      if (durability !== "serial_r2") {
        this.sql.exec(
          `INSERT OR IGNORE INTO meta_objects (hash, kind, json_body) VALUES (?, 'tree', ?)`,
          newTreeHash,
          JSON.stringify(newTreeEntries),
        );
        this.sql.exec(
          `INSERT OR IGNORE INTO meta_objects (hash, kind, json_body) VALUES (?, 'commit', ?)`,
          newCommitHash,
          JSON.stringify(newCommitObj),
        );
        preparedPuts.forEach((item, idx) => {
          if (item.data.byteLength <= HOT_BLOB_MAX_BYTES) {
            this.sql.exec(
              `INSERT OR IGNORE INTO hot_blobs (hash, data, size, updated_at) VALUES (?, ?, ?, ?)`,
              blobHashes[idx],
              item.data,
              item.data.byteLength,
              now,
            );
          }
        });
      }
      for (const ob of outboxToEnqueue) {
        this.sql.exec(
          `INSERT OR IGNORE INTO r2_outbox (hash, kind, data, created_at) VALUES (?, ?, ?, ?)`,
          ob.hash,
          ob.kind,
          ob.data,
          now,
        );
      }
      if (liveVm && liveVm.holder === holder) {
        this.sql.exec(
          `UPDATE vms SET head_commit = ?, last_active_at = ? WHERE vm_id = ?`,
          newCommitHash,
          now,
          liveVm.vm_id,
        );
      }
    });

    if (outboxToEnqueue.length > 0) {
      this.triggerAsyncOutboxFlush();
    }

    return {
      commit: newCommitHash,
      tree: newTreeHash,
      changed: [...changedSet],
      totalBytes,
    };
  }

  async read(params: {
    at?: string;
    path: string;
    offset?: number;
    limit?: number;
    bypassCache?: boolean;
  }): Promise<CamelFsReadResponse> {
    this.requireLineage();
    const normPath = normalizeRelPath(params.path, false);
    const offset = params.offset ?? 0;
    const limit = params.limit ?? 0;
    if (offset < 0) throw new ApiError(400, "invalid_request", "offset must be >= 0");

    const refName = this.resolveRefName(params.at);
    if (refName) {
      const vm = this.getRunningVmByRef(refName);
      if (vm) {
        const live = await callContainerDaemon<CamelFsReadResponse>(this.env, vm.vm_id, "/read_file", "POST", {
          vmId: vm.vm_id,
          path: normPath,
          offset,
          limit,
        });
        return { ...live, commit: vm.head_commit };
      }
    }

    const { hash: commitHash, commit } = await this.resolveCommit(params.at);
    const entries = await this.getTreeFast(commit.tree);
    const ent = entries.find((e) => e.path === normPath);
    if (!ent) {
      throw new ApiError(404, "not_found", `path "${normPath}" not found at "${commitHash}"`);
    }
    const data = await this.getBlobFast(ent.hash, Boolean(params.bypassCache));
    return buildReadResponse(commitHash, normPath, data, ent.mode, offset, limit);
  }

  async ls(params: {
    at?: string;
    path?: string;
    recursive?: boolean;
    glob?: string;
  }): Promise<CamelFsLsResponse> {
    this.requireLineage();
    const normDir = normalizeRelPath(params.path ?? "", true);
    const recursive = Boolean(params.recursive);

    const refName = this.resolveRefName(params.at);
    if (refName) {
      const vm = this.getRunningVmByRef(refName);
      if (vm) {
        const live = await callContainerDaemon<{ entries: TreeEntry[] }>(
          this.env,
          vm.vm_id,
          "/list_files",
          "POST",
          {
            vmId: vm.vm_id,
            path: normDir,
            recursive,
            glob: params.glob ?? "",
          },
        );
        return { commit: vm.head_commit, entries: live.entries ?? [] };
      }
    }

    const { hash: commitHash, commit } = await this.resolveCommit(params.at);
    const entries = await this.getTreeFast(commit.tree);
    return {
      commit: commitHash,
      entries: filterListEntries(entries, normDir, recursive, params.glob),
    };
  }

  async grep(req: {
    at?: string;
    pattern: string;
    pathPrefix?: string;
    maxMatches?: number;
    bypassCache?: boolean;
  }): Promise<CamelFsGrepResponse> {
    this.requireLineage();
    if (!req.pattern) throw new ApiError(400, "invalid_request", "pattern is required");
    let re: RegExp;
    try {
      re = new RegExp(req.pattern);
    } catch (err) {
      throw new ApiError(400, "invalid_request", `invalid regex pattern: ${String(err)}`);
    }
    const prefix = normalizeRelPath(req.pathPrefix ?? "", true);
    const dirOnly = Boolean(req.pathPrefix?.trim().endsWith("/")) && prefix !== "";
    const maxMatches = req.maxMatches && req.maxMatches > 0 ? req.maxMatches : 100;

    const refName = this.resolveRefName(req.at);
    if (refName) {
      const vm = this.getRunningVmByRef(refName);
      if (vm) {
        const live = await callContainerDaemon<{ matches: GrepMatch[] }>(
          this.env,
          vm.vm_id,
          "/grep_files",
          "POST",
          {
            vmId: vm.vm_id,
            pattern: req.pattern,
            path: req.pathPrefix ?? "",
            maxMatches,
          },
        );
        return { commit: vm.head_commit, matches: live.matches ?? [] };
      }
    }

    const { hash: commitHash, commit } = await this.resolveCommit(req.at);
    const entries = await this.getTreeFast(commit.tree);
    const targets = entries.filter((ent) => {
      if (ent.type !== "file") return false;
      if (!prefix) return true;
      return dirOnly
        ? ent.path.startsWith(`${prefix}/`)
        : ent.path === prefix || ent.path.startsWith(`${prefix}/`) || ent.path.startsWith(prefix);
    });
    const matches: GrepMatch[] = [];
    const bypass = Boolean(req.bypassCache);
    for (let i = 0; i < targets.length && matches.length < maxMatches; i += 6) {
      const batch = targets.slice(i, i + 6);
      const blobs = await Promise.all(batch.map((ent) => this.getBlobFast(ent.hash, bypass)));
      for (let j = 0; j < batch.length; j++) {
        if (grepTextLines(re, batch[j].path, blobs[j], maxMatches, matches)) {
          break;
        }
      }
    }
    return { commit: commitHash, matches };
  }

  async history(params: { ref?: string; limit?: number }): Promise<{ commits: CamelFsCommitInfo[] }> {
    this.requireLineage();
    const limit = Math.min(Math.max(params.limit || 20, 1), 1000);
    const { hash: headHash } = await this.resolveCommit(params.ref);
    const seen = new Set<string>();
    const queue = [headHash];
    const commits: CamelFsCommitInfo[] = [];
    while (queue.length > 0 && commits.length < limit) {
      const h = queue.shift()!;
      if (!h || seen.has(h)) continue;
      seen.add(h);
      const c = await this.getCommitFast(h);
      commits.push({
        commit: h,
        tree: c.tree,
        parents: c.parents,
        author: c.author,
        message: c.message,
        createdAt: c.createdAt,
      });
      for (const p of c.parents) {
        if (!seen.has(p)) queue.push(p);
      }
    }
    return { commits };
  }

  async restore(req: {
    ref?: string;
    targetCommit: string;
    expectedCommit?: string;
    holder?: string;
    author?: string;
    message?: string;
  }): Promise<{ commit: string; tree: string }> {
    this.requireLineage();
    const refName = (req.ref ?? "").trim() || DEFAULT_REF;
    if (!req.targetCommit?.trim()) {
      throw new ApiError(400, "invalid_request", "targetCommit is required");
    }
    const { commit: targetObj } = await this.resolveCommit(req.targetCommit);
    const curRef = this.getRefRow(refName);
    if (!curRef) throw new ApiError(404, "not_found", `ref "${refName}" not found`);
    if (req.expectedCommit && curRef.commit_hash !== req.expectedCommit) {
      throw new ApiError(
        409,
        "cas_conflict",
        `expected commit "${req.expectedCommit}" on ref "${refName}", got "${curRef.commit_hash}"`,
      );
    }
    const now = Date.now();
    const holder = (req.holder ?? "").trim();
    if (curRef.lease_holder && curRef.lease_expires_at > now && curRef.lease_holder !== holder) {
      throw new ApiError(409, "ref_leased", `ref "${refName}" is leased by "${curRef.lease_holder}"`);
    }

    const runningVm = this.getRunningVmByRef(refName);
    if (runningVm) {
      if (runningVm.holder !== holder && runningVm.lease_expires_at > now) {
        throw new ApiError(409, "ref_leased", `ref "${refName}" has an active VM leased by "${runningVm.holder}"`);
      }
      await this.stopVmInternal(runningVm.vm_id, false);
    }

    const newCommitObj: CommitObject = {
      tree: targetObj.tree,
      parents: [curRef.commit_hash],
      author: (req.author ?? "").trim() || "system",
      message: (req.message ?? "").trim() || "restore",
      createdAt: now,
    };
    const newCommitBytes = encodeCommitBytes(newCommitObj);
    const newCommit = await hashObject("commit", newCommitBytes);

    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        `INSERT OR IGNORE INTO meta_objects (hash, kind, json_body) VALUES (?, 'commit', ?)`,
        newCommit,
        JSON.stringify(newCommitObj),
      );
      this.sql.exec(
        `INSERT OR IGNORE INTO r2_outbox (hash, kind, data, created_at) VALUES (?, 'commit', ?, ?)`,
        newCommit,
        newCommitBytes,
        now,
      );
      this.sql.exec(
        `UPDATE refs SET commit_hash = ?, tree_hash = ?, updated_at = ? WHERE name = ?`,
        newCommit,
        targetObj.tree,
        now,
        refName,
      );
    });
    this.triggerAsyncOutboxFlush();
    return { commit: newCommit, tree: targetObj.tree };
  }

  // ---- Session VM Endpoints (Cloudflare Container + RO Lazy FUSE + Kernel OverlayFS) ----

  async bootOrReuseVm(req: BootVmInput): Promise<CamelFsVmInfo> {
    const meta = this.requireLineage();
    const refName = (req.ref ?? "").trim() || DEFAULT_REF;
    const holder = (req.holder ?? "").trim() || "default";
    const vcpus = req.vcpus && req.vcpus > 0 ? req.vcpus : 2;
    const memoryMiB = req.memoryMiB && req.memoryMiB > 0 ? req.memoryMiB : 2048;
    const idleTimeoutS = req.idleTimeoutS && req.idleTimeoutS > 0 ? req.idleTimeoutS : 300;
    const leaseS = req.leaseS && req.leaseS > 0 ? req.leaseS : 600;
    const now = Date.now();

    const existing = this.getRunningVmByRef(refName);
    if (existing) {
      if (existing.holder === holder) {
        const lease = await this.leaseRef({ ref: refName, holder, ttlMs: leaseS * 1000 });
        this.sql.exec(
          `UPDATE vms SET lease_epoch = ?, lease_expires_at = ?, last_active_at = ?, idle_timeout_s = ?
           WHERE vm_id = ?`,
          lease.epoch,
          lease.expiresAt,
          now,
          idleTimeoutS,
          existing.vm_id,
        );
        await this.scheduleReapAlarm();
        return {
          vmId: existing.vm_id,
          lineage: meta.lineage,
          ref: existing.ref,
          holder: existing.holder,
          state: "running",
          headCommit: existing.head_commit,
          reused: true,
          leaseExpiresAt: lease.expiresAt,
        };
      }
      if (existing.lease_expires_at > now) {
        throw new ApiError(
          409,
          "ref_leased",
          `running VM "${existing.vm_id}" on (${meta.lineage}, ${refName}) is leased by "${existing.holder}"`,
        );
      }
      await this.stopVmInternal(existing.vm_id, true);
    }

    // Flush any pending async blobs to R2 so the container's lazy FUSE fetcher finds every object.
    if (this.countOutbox() > 0) {
      await this.flushOutboxToR2();
    }

    const lease = await this.leaseRef({ ref: refName, holder, ttlMs: leaseS * 1000 });
    const tree = await this.getTreeFast(lease.tree);
    const vmId = encodeVmId(meta.lineage);

    const selfBase = (this.env.CAMELFS_SELF_URL || "").replace(/\/+$/, "");
    if (!selfBase) {
      await this.leaseRef({ ref: refName, holder, release: true, expectedEpoch: lease.epoch }).catch(() => {});
      throw new ApiError(
        503,
        "camelfs_not_configured",
        "CAMELFS_SELF_URL must be configured so containers can fetch lazy FUSE blobs",
      );
    }
    const internalToken = await deriveCamelfsInternalToken(this.env);
    const blobBaseUrl = selfBase.endsWith("/v2")
      ? `${selfBase}/internal/camelfs/objects`
      : `${selfBase}/v2/internal/camelfs/objects`;

    try {
      await callContainerDaemon(this.env, vmId, "/mount", "POST", {
        vmId,
        lineage: meta.lineage,
        ref: refName,
        commit: lease.commit,
        tree,
        env: req.env ?? {},
        blobBaseUrl,
        internalToken,
      });
    } catch (err) {
      await this.leaseRef({ ref: refName, holder, release: true, expectedEpoch: lease.epoch }).catch(() => {});
      throw err;
    }

    this.sql.exec(
      `INSERT INTO vms (
         vm_id, ref, holder, lease_epoch, state, head_commit, vcpus, memory_mib,
         idle_timeout_s, created_at, last_active_at, lease_expires_at, total_duration_ms, billed_ms
       ) VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, 0, 0)`,
      vmId,
      refName,
      holder,
      lease.epoch,
      lease.commit,
      vcpus,
      memoryMiB,
      idleTimeoutS,
      now,
      now,
      lease.expiresAt,
    );
    await this.scheduleReapAlarm();

    return {
      vmId,
      lineage: meta.lineage,
      ref: refName,
      holder,
      state: "running",
      headCommit: lease.commit,
      reused: false,
      leaseExpiresAt: lease.expiresAt,
    };
  }

  async execVm(vmId: string, req: CamelFsVmExecRequest): Promise<CamelFsVmExecResult> {
    this.requireLineage();
    const execId = (req.execId ?? "").trim() || randomId("exec");

    const existingReceipt = this.sql
      .exec(`SELECT response_json FROM exec_receipts WHERE vm_id = ? AND exec_id = ?`, vmId, execId)
      .toArray() as unknown as Array<{ response_json: string }>;
    if (existingReceipt[0]) {
      return JSON.parse(existingReceipt[0].response_json) as CamelFsVmExecResult;
    }

    const vm = this.getVmRow(vmId);
    if (!vm) throw new ApiError(404, "not_found", `vm "${vmId}" not found`);
    if (vm.state === "lost") throw new ApiError(410, "vm_lost", `vm "${vmId}" was lost`);
    if (vm.state !== "running") throw new ApiError(410, "vm_stopped", `vm "${vmId}" is stopped`);
    if (!req.command?.trim()) throw new ApiError(400, "invalid_request", "command is required");

    const startedAt = Date.now();
    const execOut = await callContainerDaemon<ContainerExecResponse>(this.env, vmId, "/exec", "POST", {
      vmId,
      execId,
      command: req.command,
      cwd: req.cwd ?? "",
      env: req.env ?? {},
      timeoutS: req.timeoutS ?? 60,
    });
    const durationMs = Math.max(Date.now() - startedAt, 1);

    const baseCommit = vm.head_commit;
    const baseCommitObj = await this.getCommitFast(baseCommit);
    let commitRes = {
      changed: false,
      commit: baseCommit,
      tree: baseCommitObj.tree,
      filesChanged: [] as string[],
    };

    if (!req.commit?.skip) {
      const delta = await callContainerDaemon<ContainerDeltaResponse>(
        this.env,
        vmId,
        "/collect_delta",
        "POST",
        { vmId },
      );
      if ((delta.puts?.length ?? 0) > 0 || (delta.deletes?.length ?? 0) > 0) {
        const author = (req.commit?.author ?? "").trim() || `agent:${vm.holder}`;
        const message =
          (req.commit?.message ?? "").trim() ||
          `bash: ${req.command.replaceAll("\n", "; ").slice(0, 72)}`;
        commitRes = await this.applyWorkspaceDelta(baseCommit, baseCommitObj.tree, author, message, delta);
      }
    }

    const now = Date.now();
    const response: CamelFsVmExecResult = {
      execId,
      exitCode: execOut.exitCode,
      stdout: execOut.stdout,
      stderr: execOut.stderr,
      cwd: execOut.cwd || "/workspace",
      timedOut: execOut.timedOut,
      durationMs,
      billableMs: durationMs,
      commit: commitRes,
    };

    this.ctx.storage.transactionSync(() => {
      const freshVm = this.getVmRow(vmId);
      if (!freshVm || freshVm.state !== "running") {
        throw new ApiError(410, "vm_stopped", `vm "${vmId}" stopped before exec finalized`);
      }
      if (commitRes.changed) {
        const curRef = this.getRefRow(freshVm.ref);
        if (!curRef || curRef.commit_hash !== baseCommit || curRef.lease_epoch !== freshVm.lease_epoch) {
          throw new ApiError(409, "cas_conflict", `ref "${freshVm.ref}" lease or head changed during exec`);
        }
        this.sql.exec(
          `UPDATE refs SET commit_hash = ?, tree_hash = ?, updated_at = ? WHERE name = ?`,
          commitRes.commit,
          commitRes.tree,
          now,
          freshVm.ref,
        );
      }
      this.sql.exec(
        `UPDATE vms
         SET head_commit = ?, last_active_at = ?, total_duration_ms = total_duration_ms + ?, billed_ms = billed_ms + ?
         WHERE vm_id = ?`,
        commitRes.commit,
        now,
        durationMs,
        durationMs,
        vmId,
      );
      this.sql.exec(
        `INSERT INTO exec_receipts (vm_id, exec_id, response_json, created_at) VALUES (?, ?, ?, ?)`,
        vmId,
        execId,
        JSON.stringify(response),
        now,
      );
    });

    await this.scheduleReapAlarm();
    return response;
  }

  private async applyWorkspaceDelta(
    baseCommit: string,
    baseTreeHash: string,
    author: string,
    message: string,
    delta: ContainerDeltaResponse,
  ): Promise<{ changed: boolean; commit: string; tree: string; filesChanged: string[] }> {
    const entries = await this.getTreeFast(baseTreeHash);
    const treeMap = new Map<string, TreeEntry>(entries.map((e) => [e.path, e]));
    const changed = new Set<string>();

    for (const delPath of delta.deletes ?? []) {
      const norm = normalizeRelPath(delPath, false);
      if (treeMap.delete(norm)) {
        changed.add(norm);
      }
    }

    const blobsToUpload: Array<{ kind: ObjectKind; hash: string; data: Uint8Array }> = [];
    for (const put of delta.puts ?? []) {
      const norm = normalizeRelPath(put.path, false);
      if (put.linkTarget) {
        const targetBytes = encoder.encode(put.linkTarget);
        const hash = await hashObject("blob", targetBytes);
        blobsToUpload.push({ kind: "blob", hash, data: targetBytes });
        treeMap.set(norm, {
          path: norm,
          type: "symlink",
          size: targetBytes.byteLength,
          mode: put.mode || 0o777,
          hash,
          linkTarget: put.linkTarget,
        });
        changed.add(norm);
        continue;
      }
      const data = put.base64 ? base64ToBytes(put.base64) : new Uint8Array(0);
      const hash = await hashObject("blob", data);
      const mode = put.mode || DEFAULT_FILE_MODE;
      const prev = treeMap.get(norm);
      if (!prev || prev.hash !== hash || prev.mode !== mode || prev.type !== "file") {
        blobsToUpload.push({ kind: "blob", hash, data });
        treeMap.set(norm, {
          path: norm,
          type: "file",
          size: data.byteLength,
          mode,
          hash,
        });
        changed.add(norm);
      }
    }

    if (changed.size === 0) {
      return { changed: false, commit: baseCommit, tree: baseTreeHash, filesChanged: [] };
    }

    const newTreeEntries = [...treeMap.values()];
    const newTreeBytes = encodeTreeBytes(newTreeEntries);
    const newTreeHash = await hashObject("tree", newTreeBytes);
    const newCommitObj: CommitObject = {
      tree: newTreeHash,
      parents: [baseCommit],
      author,
      message,
      createdAt: Date.now(),
    };
    const newCommitBytes = encodeCommitBytes(newCommitObj);
    const newCommitHash = await hashObject("commit", newCommitBytes);

    // Parallel single-wave R2 upload (blobs + tree + commit) + hot DO SQLite cache!
    await putObjectsParallel(
      this.bucket,
      [
        ...blobsToUpload,
        { kind: "tree", hash: newTreeHash, data: newTreeBytes },
        { kind: "commit", hash: newCommitHash, data: newCommitBytes },
      ],
      6,
    );
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        `INSERT OR IGNORE INTO meta_objects (hash, kind, json_body) VALUES (?, 'tree', ?)`,
        newTreeHash,
        JSON.stringify(newTreeEntries),
      );
      this.sql.exec(
        `INSERT OR IGNORE INTO meta_objects (hash, kind, json_body) VALUES (?, 'commit', ?)`,
        newCommitHash,
        JSON.stringify(newCommitObj),
      );
      for (const b of blobsToUpload) {
        if (b.data.byteLength <= HOT_BLOB_MAX_BYTES) {
          this.sql.exec(
            `INSERT OR IGNORE INTO hot_blobs (hash, data, size, updated_at) VALUES (?, ?, ?, ?)`,
            b.hash,
            b.data,
            b.data.byteLength,
            now,
          );
        }
      }
    });

    return {
      changed: true,
      commit: newCommitHash,
      tree: newTreeHash,
      filesChanged: [...changed].sort(),
    };
  }

  async renewVmLease(vmId: string, leaseS = 600): Promise<{ vmId: string; state: string; leaseExpiresAt: number }> {
    this.requireLineage();
    const vm = this.getVmRow(vmId);
    if (!vm) throw new ApiError(404, "not_found", `vm "${vmId}" not found`);
    if (vm.state !== "running") throw new ApiError(400, "invalid_request", `vm "${vmId}" is not running`);
    const lease = await this.leaseRef({ ref: vm.ref, holder: vm.holder, ttlMs: leaseS * 1000 });
    this.sql.exec(
      `UPDATE vms SET lease_epoch = ?, lease_expires_at = ?, last_active_at = ? WHERE vm_id = ?`,
      lease.epoch,
      lease.expiresAt,
      Date.now(),
      vmId,
    );
    await this.scheduleReapAlarm();
    return { vmId, state: "running", leaseExpiresAt: lease.expiresAt };
  }

  async stopVm(vmId: string): Promise<{ vmId: string; state: string; commit: string; unbilledMs: number }> {
    this.requireLineage();
    return this.stopVmInternal(vmId, true);
  }

  private async stopVmInternal(
    vmId: string,
    commitWorkspace: boolean,
  ): Promise<{ vmId: string; state: string; commit: string; unbilledMs: number }> {
    const vm = this.getVmRow(vmId);
    if (!vm) throw new ApiError(404, "not_found", `vm "${vmId}" not found`);
    if (vm.state !== "running") {
      return { vmId: vm.vm_id, state: vm.state, commit: vm.head_commit, unbilledMs: 0 };
    }

    let headCommit = vm.head_commit;
    if (commitWorkspace) {
      const delta = await callContainerDaemon<ContainerDeltaResponse>(
        this.env,
        vmId,
        "/collect_delta",
        "POST",
        { vmId },
      ).catch(() => ({ puts: [], deletes: [] }));
      if ((delta.puts?.length ?? 0) > 0 || (delta.deletes?.length ?? 0) > 0) {
        const baseObj = await this.getCommitFast(headCommit);
        const cr = await this.applyWorkspaceDelta(
          headCommit,
          baseObj.tree,
          `agent:${vm.holder}`,
          "vm stop: final workspace sync",
          delta,
        );
        if (cr.changed) {
          this.sql.exec(
            `UPDATE refs SET commit_hash = ?, tree_hash = ?, updated_at = ? WHERE name = ? AND commit_hash = ?`,
            cr.commit,
            cr.tree,
            Date.now(),
            vm.ref,
            headCommit,
          );
          headCommit = cr.commit;
        }
      }
    }

    await callContainerDaemon(this.env, vmId, "/unmount", "POST", { vmId }).catch(() => {});
    await destroyContainerInstance(this.env, vmId).catch(() => {});
    await this.leaseRef({
      ref: vm.ref,
      holder: vm.holder,
      release: true,
      expectedEpoch: vm.lease_epoch,
    }).catch(() => {});

    const now = Date.now();
    const aliveMs = Math.max(now - vm.created_at, 0);
    const unbilledMs = Math.max(aliveMs - vm.billed_ms, 0);
    this.sql.exec(
      `UPDATE vms SET state = 'stopped', head_commit = ?, last_active_at = ?, billed_ms = billed_ms + ? WHERE vm_id = ?`,
      headCommit,
      now,
      unbilledMs,
      vmId,
    );
    return { vmId, state: "stopped", commit: headCommit, unbilledMs };
  }

  async getVm(vmId: string): Promise<CamelFsVmInfo> {
    const meta = this.requireLineage();
    const vm = this.getVmRow(vmId);
    if (!vm) throw new ApiError(404, "not_found", `vm "${vmId}" not found`);
    return {
      vmId: vm.vm_id,
      lineage: meta.lineage,
      ref: vm.ref,
      holder: vm.holder,
      state: vm.state,
      headCommit: vm.head_commit,
      leaseExpiresAt: vm.lease_expires_at,
    };
  }

  private async scheduleReapAlarm(): Promise<void> {
    const running = this.sql
      .exec(`SELECT last_active_at, idle_timeout_s, lease_expires_at FROM vms WHERE state = 'running'`)
      .toArray() as unknown as Array<{
      last_active_at: number;
      idle_timeout_s: number;
      lease_expires_at: number;
    }>;
    let nextAt = Number.POSITIVE_INFINITY;
    for (const vm of running) {
      if (vm.lease_expires_at > 0) nextAt = Math.min(nextAt, vm.lease_expires_at);
      if (vm.idle_timeout_s > 0) nextAt = Math.min(nextAt, vm.last_active_at + vm.idle_timeout_s * 1000);
    }
    if (Number.isFinite(nextAt)) {
      await this.ctx.storage.setAlarm(Math.max(nextAt, Date.now() + 1000));
    }
  }

  async alarm(): Promise<void> {
    if (this.countOutbox() > 0) {
      await this.flushOutboxToR2().catch(() => {});
    }
    const now = Date.now();
    const running = this.sql
      .exec(`SELECT vm_id, last_active_at, idle_timeout_s, lease_expires_at FROM vms WHERE state = 'running'`)
      .toArray() as unknown as Array<{
      vm_id: string;
      last_active_at: number;
      idle_timeout_s: number;
      lease_expires_at: number;
    }>;
    for (const vm of running) {
      const leaseExpired = vm.lease_expires_at > 0 && now >= vm.lease_expires_at;
      const idleExpired = vm.idle_timeout_s > 0 && now - vm.last_active_at >= vm.idle_timeout_s * 1000;
      if (leaseExpired || idleExpired) {
        await this.stopVmInternal(vm.vm_id, true).catch(() => {});
      }
    }
    await this.scheduleReapAlarm();
    if (this.countOutbox() > 0) {
      await this.ctx.storage.setAlarm(Date.now() + 5_000);
    }
  }
}
