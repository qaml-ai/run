import { tierRequest, TierError, type TierEnv } from "../camelfs/tier.ts";
import type { TierClaims, TierFence, TierHolder } from "../camelfs/claims.ts";
import type { RepoClient } from "./client.ts";
import { RepoError, refName, type Ref, type Entry, type Version } from "./repo-policy.ts";
import type { RepoRow } from "./tenant-repos.ts";
import type { CommitInfo, DiffChange } from "./storage.ts";
import type { MoveResult, RepoQuota, RepoWrite, WriteResult } from "./write-input.ts";

type Request = Parameters<typeof tierRequest>[1];
type WireRef = Omit<Ref, "holder"> & { holder?: TierHolder };
type Cas = Omit<Parameters<RepoClient["cas"]>[0], "fence"> & { fence?: TierFence | { holder: string; epoch: number }; quota?: RepoQuota };
type Metadata = Pick<RepoWrite, "author" | "time" | "message" | "trailers" | "quota">;

export const needsK5 = () => new RepoError("repo jobs on the tier arrive with K5", 501, "needs_k5");
const forkNamespace = /^fork\/repo_[a-f0-9]{24}(?:\/|$)/;
const path = (name: string) => encodeURIComponent(name);
const missing = (e: unknown, code: string) => e instanceof RepoError && e.status === 404 && e.code === code;

export class HttpRepoClient implements RepoClient {
  private readonly env: TierEnv;
  private readonly tenant: string;
  private readonly row: RepoRow;
  private readonly sub: string;
  private readonly readRow: () => Promise<RepoRow | null>;

  constructor(env: TierEnv, tenant: string, row: RepoRow, sub: string, readRow = async () => row as RepoRow | null) {
    this.env = env;
    this.tenant = tenant;
    this.row = row;
    this.sub = sub;
    this.readRow = readRow;
  }

  private get prefix() { return this.row.lineage === `${this.tenant}:${this.row.id}` ? "" : `fork/${this.row.id}/`; }
  tierRefName(ref: string) {
    refName(ref);
    if (!this.prefix && forkNamespace.test(ref)) throw new RepoError("Reserved fork ref", 400, "bad_ref");
    return this.prefix + ref;
  }
  private refPath(ref: string) { return "/refs/" + path(this.tierRefName(ref)); }

  private async call<T>(method: string, route: string, acc: TierClaims["acc"], options: {
    refs?: string[]; body?: unknown; query?: Request["query"]; sub?: string; fence?: TierFence; key?: string;
  } = {}): Promise<T> {
    const holder = options.fence?.holder;
    const fence = options.fence && holder && { holder: `${holder.host}:${holder.boot}:${holder.mount}`, epoch: options.fence.epoch };
    try {
      return await tierRequest<T>(this.env, {
        method, path: "/v1/lineages/" + path(this.row.lineage) + route, body: options.body, query: options.query,
        claims: { sub: options.sub ?? this.sub, lin: this.row.lineage, acc, refs: options.refs, fence },
        idempotencyKey: options.key,
      });
    } catch (e) {
      if (e instanceof TierError) throw new RepoError(e.message, e.status, e.code, e.details as Record<string, unknown>);
      throw e;
    }
  }

  private local(ref: WireRef): Ref {
    return { ...ref, name: ref.name.slice(this.prefix.length), root: ref.root ?? null,
      expiresAt: ref.expiresAt ?? null, leaseEpoch: ref.leaseEpoch ?? 0, holder: ref.holder ? JSON.stringify(ref.holder) : null, leaseDeadline: ref.leaseDeadline ?? null };
  }

  async info() {
    const [refs, current] = await Promise.all([this.refs(), this.readRow()]);
    const { id, name, key, lineage, createdAt, deletedAt, bytes, files } = current ?? this.row;
    return { tenant: this.tenant, id, name, key, lineage, createdAt, deleted: deletedAt !== null, refs, bytes, files,
      ...(this.prefix ? { sharesStorageWith: lineage.slice(this.tenant.length + 1) } : {}) };
  }

  async refs() {
    const refs: Ref[] = [];
    let after: string | undefined;
    do {
      const page: { refs: WireRef[]; next?: string } = await this.call("GET", "/refs", "r", { query: { after, prefix: this.prefix || undefined } });
      refs.push(...page.refs.filter(ref => this.prefix || !forkNamespace.test(ref.name)).map(ref => this.local(ref)));
      if (page.next && page.next === after) throw new RepoError("Non-advancing refs cursor", 502, "invalid_response");
      after = page.next;
    } while (after);
    return refs;
  }

  async ref(name: string) {
    try { return this.local(await this.call<WireRef>("GET", this.refPath(name), "r", { refs: [this.tierRefName(name)] })); }
    catch (e) { if (missing(e, "ref_not_found")) return null; throw e; }
  }

  async resolve(refOrVersion: string) {
    if (/^[a-f0-9]{40}$/.test(refOrVersion)) {
      const commit = await this.commit(refOrVersion);
      if (commit) return { version: commit.version, tree: commit.tree, root: null, ref: null };
      throw new RepoError("Commit not found", 404, "not_in_tree");
    }
    const ref = await this.ref(refOrVersion);
    if (!ref) throw new RepoError("Ref not found", 404, "ref_not_found");
    return { version: ref.version, tree: ref.tree, root: ref.root, ref: ref.name };
  }

  async createRef(input: Parameters<RepoClient["createRef"]>[0]) {
    const name = this.tierRefName(input.name);
    const version = typeof input.from === "string" ? (await this.resolve(input.from)).version : input.from.version;
    return this.local(await this.call<WireRef>("POST", "/refs", "w", {
      refs: [name], body: { name, version, owner: input.owner ?? this.sub, expiresAt: input.expiresAt ?? undefined },
    }));
  }

  async deleteRef(name: string, expect?: string) {
    await this.call("DELETE", this.refPath(name), "w", { refs: [this.tierRefName(name)], query: { expect } });
  }

  deleteOwned(owner: string) {
    return this.call<{ deleted: string[]; held: string[] }>("DELETE", "/refs", "w", { query: { owner } });
  }

  async cas(input: Cas) {
    if (input.fence && typeof input.fence.holder === "string") throw needsK5();
    if (!input.expect) throw new RepoError("CAS requires expect", 400, "invalid_request");
    const fence = input.fence as TierFence | undefined;
    const result = await this.call<MoveResult>("POST", this.refPath(input.ref) + "/cas", "w", {
      refs: [this.tierRefName(input.ref)], fence,
      body: { commit: input.commit.version, expect: input.expect, root: input.root ?? undefined, quota: input.quota },
    });
    return { ...result, previous: input.expect, watchers: [] as string[] };
  }

  async commit(id: string): Promise<(Version & { paths: string[] | null }) | null> {
    try {
      const { time, ...commit } = await this.call<CommitInfo>("GET", "/commits/" + path(id), "r");
      return { ...commit, version: id, at: time * 1000, paths: null };
    } catch (e) { if (missing(e, "not_in_tree")) return null; throw e; }
  }

  async prepareLineage() {
    await this.call("PUT", "", "w", { body: { tenant: this.tenant, kind: "workspace", defaultBranch: "main" } });
  }

  async init(input: Parameters<RepoClient["init"]>[0]) {
    await this.prepareLineage();
    if (input.seed && !await this.ref("main")) {
      try { await this.createRef({ name: "main", from: { version: input.seed.version.version }, who: this.sub, why: "create" }); }
      catch (e) { if (!(e instanceof RepoError && e.code === "ref_exists")) throw e; }
    }
    return this.info();
  }

  async write(input: RepoWrite): Promise<WriteResult> {
    const { ref, idempotencyKey, legacy, ...body } = input;
    if (legacy?.fence) throw needsK5();
    const result = await this.call<MoveResult & {
      parents: string[]; time: number; changed: (Omit<DiffChange, "newMode"> & { mode: Entry["mode"] })[];
    }>("POST", this.refPath(ref) + "/write", "w", { refs: [this.tierRefName(ref)], body, key: idempotencyKey });
    const changed = Object.fromEntries(result.changed.map(change => [change.path, change.status === "deleted" ? null : {
      path: change.path, blob: change.newBlob!, size: change.newSize!, mode: change.mode,
    }]));
    const previous = result.parents[0] ?? null;
    return { ...result, changed, previous, watchers: [], moved: result.version !== previous };
  }

  merge(ref: string, input: Metadata & { theirs: string; mode: "merge" | "ff-only" | "squash" }) {
    return this.call<MoveResult & { ff: boolean; merged: string[]; took: { ours: number; theirs: number } }>("POST", this.refPath(ref) + "/merge", "w", { refs: [this.tierRefName(ref)], body: input });
  }

  restore(ref: string, input: Metadata & { version: string }) {
    return this.call<MoveResult>("POST", this.refPath(ref) + "/restore", "w", { refs: [this.tierRefName(ref)], body: input });
  }

  acquire({ ref, holder, ttlMs }: { ref: string; holder: string | TierHolder; ttlMs: number }) {
    if (typeof holder === "string") throw needsK5();
    return this.call<{ epoch: number; deadline: number }>("POST", this.refPath(ref) + "/lease", "w", {
      refs: [this.tierRefName(ref)], sub: "runtime:repo-leases", body: { holder, ttlMs },
    });
  }

  async renew({ ref, holder, epoch }: { ref: string; holder: string | TierHolder; epoch: number }, ttlMs: number) {
    if (typeof holder === "string") throw needsK5();
    const result = await this.call<{ deadline: number }>("POST", this.refPath(ref) + "/lease/renew", "w", {
      refs: [this.tierRefName(ref)], sub: "runtime:repo-leases", fence: { holder, epoch }, body: { ttlMs },
    });
    return { ...result, epoch };
  }

  async release({ ref, holder, epoch }: { ref: string; holder: string | TierHolder; epoch: number }) {
    if (typeof holder === "string") throw needsK5();
    await this.call("DELETE", this.refPath(ref) + "/lease", "w", {
      refs: [this.tierRefName(ref)], sub: "runtime:repo-leases", fence: { holder, epoch },
    });
  }

  private async watcher(method: string, ref: string, watcher: string) {
    const principal = /^(agent|workflow):/.test(watcher) ? watcher : "agent:" + watcher;
    await this.call(method, this.refPath(ref) + "/watchers/" + path(principal), "w", {
      refs: [this.tierRefName(ref)], sub: "runtime:repo-watchers",
    });
  }

  watch(ref: string, watcher: string) { return this.watcher("PUT", ref, watcher); }
  unwatch(ref: string, watcher: string) { return this.watcher("DELETE", ref, watcher); }

  async delete(key?: string) {
    await this.call("DELETE", "", "w", { sub: "runtime:repo-delete", key });
    return { deleted: true as const };
  }

  async blobSize(): Promise<never> { throw new Error("camelFS accounts for blob sizes"); }
  async unseenBytes(): Promise<never> { throw new Error("camelFS accounts for lineage usage"); }
}
