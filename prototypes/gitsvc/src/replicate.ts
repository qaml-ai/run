// Continuous backup of every repo to S3/R2 by pack shipping. The one invariant: **a ref never moves on the server
// until every pack it could need and the new ref manifest are in the bucket.** Git gives the hook for it: the
// `reference-transaction` hook runs in state `prepared` after the ref locks are taken and before the update is
// committed, and a non-zero exit aborts the update (the pusher gets `ng`). Receive-pack has already moved the pushed
// pack out of quarantine by then, and every write path in server.ts lands its objects as a pack before its ref
// update (receive.unpackLimit=1, fast-import, pack-objects after merge-tree), so "ship the packs we have not
// shipped, then the manifest" is the whole protocol.
//
// Layout per repo:  repos/<repo>/packs/pack-<sha>.{pack,idx}   immutable, written once
//                   repos/<repo>/refs.json                       { ref: sha } after this transaction, plus HEAD
// RPO is zero for acknowledged writes (the push waits on the bucket); RTO is a parallel download of the packs plus
// nothing else (the .idx files are shipped, so no index-pack).
import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } from "@aws-sdk/client-s3";
import { readFile, readdir, writeFile, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { git, ZERO } from "./gitexec.ts";

export type RefUpdate = { old: string; new: string; ref: string };
type Manifest = Record<string, string>;

export class Replicator {
  private readonly chains = new Map<string, Promise<unknown>>(); // per-repo serialisation (one process per shard)
  readonly s3: S3Client;
  readonly bucket: string;
  constructor(options: { endpoint?: string; region?: string; bucket: string; accessKeyId: string; secretAccessKey: string }) {
    this.s3 = new S3Client({ endpoint: options.endpoint, region: options.region ?? "auto", forcePathStyle: true, credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey } });
    this.bucket = options.bucket;
  }

  private serial<T>(repo: string, fn: () => Promise<T>): Promise<T> {
    const next = (this.chains.get(repo) ?? Promise.resolve()).catch(() => {}).then(fn);
    this.chains.set(repo, next);
    return next;
  }

  /** Called by the hook (state `prepared` / `aborted`) and after gc. Throws => the ref update is aborted. */
  sync(gitDir: string, repo: string, state: "prepared" | "aborted" | "gc", updates: RefUpdate[]): Promise<{ packs: number; bytes: number }> {
    return this.serial(repo, async () => {
      const shipped = await this.shippedPacks(gitDir);
      const local = (await readdir(join(gitDir, "objects/pack")).catch(() => [] as string[])).filter((name) => name.endsWith(".idx")).map((name) => name.slice(0, -4));
      const fresh = local.filter((name) => !shipped.has(name));
      let bytes = 0;
      await Promise.all(fresh.map(async (name) => {
        // .pack before .idx: restore only trusts a pack whose .idx is present.
        const pack = await readFile(join(gitDir, "objects/pack", `${name}.pack`));
        bytes += pack.byteLength;
        await this.put(`repos/${repo}/packs/${name}.pack`, pack);
        await this.put(`repos/${repo}/packs/${name}.idx`, await readFile(join(gitDir, "objects/pack", `${name}.idx`)));
      }));
      if (fresh.length) await writeFile(join(gitDir, "gitsvc-shipped"), [...shipped, ...fresh].join("\n") + "\n");

      const updatesThatCount = updates.filter((u) => !u.ref.startsWith("refs/gitsvc/"));
      if (state === "prepared" && !updatesThatCount.length) return { packs: fresh.length, bytes };
      // The manifest is the last shipped one with this transaction applied, not `for-each-ref`: a concurrent
      // transaction on another ref has its locks but has not committed, and reading refs would drop it.
      let manifest: Manifest;
      if (state === "prepared") {
        manifest = await this.localManifest(gitDir);
        for (const u of updatesThatCount) { if (u.new === ZERO) delete manifest[u.ref]; else manifest[u.ref] = u.new; }
      } else {
        manifest = await refsOf(gitDir); // aborted or gc: the truth is what is committed
      }
      await this.put(`repos/${repo}/refs.json`, Buffer.from(JSON.stringify(manifest)));
      await writeFile(join(gitDir, "gitsvc-refs.json"), JSON.stringify(manifest));
      return { packs: fresh.length, bytes };
    });
  }

  /** After gc: drop bucket packs the repo no longer has, once older than `graceMs` (a restore never needs them). */
  async sweep(gitDir: string, repo: string, graceMs: number): Promise<number> {
    const local = new Set((await readdir(join(gitDir, "objects/pack"))).filter((n) => n.endsWith(".idx")).map((n) => n.slice(0, -4)));
    const dead: string[] = [];
    for (const object of await this.list(`repos/${repo}/packs/`)) {
      const name = object.key.split("/").pop()!.replace(/\.(pack|idx)$/, "");
      if (!local.has(name) && Date.now() - object.modified > graceMs) dead.push(object.key);
    }
    for (let i = 0; i < dead.length; i += 1000) await this.s3.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: dead.slice(i, i + 1000).map((Key) => ({ Key })) } }));
    const shipped = [...await this.shippedPacks(gitDir)].filter((name) => local.has(name));
    await writeFile(join(gitDir, "gitsvc-shipped"), shipped.join("\n") + "\n");
    return dead.length;
  }

  /** Rebuild a bare repo from the bucket: packs + idx in parallel, then the refs. No hooks run. */
  async restore(repo: string, gitDir: string): Promise<{ packs: number; bytes: number; refs: number }> {
    await git(["init", "-q", "--bare", "-b", "main", gitDir]);
    const packDir = join(gitDir, "objects/pack");
    await mkdir(packDir, { recursive: true });
    const objects = await this.list(`repos/${repo}/packs/`);
    const names = new Set(objects.map((o) => o.key.split("/").pop()!.replace(/\.(pack|idx)$/, "")));
    let bytes = 0;
    const complete: string[] = [];
    await Promise.all([...names].map(async (name) => {
      const [pack, idx] = await Promise.all([this.get(`repos/${repo}/packs/${name}.pack`), this.get(`repos/${repo}/packs/${name}.idx`)]);
      if (!pack || !idx) return; // a pack whose upload died before its .idx: never referenced by a shipped manifest
      bytes += pack.byteLength;
      await writeFile(join(packDir, `${name}.pack`), pack);
      await writeFile(join(packDir, `${name}.idx`), idx);
      complete.push(name);
    }));
    const manifest = JSON.parse((await this.get(`repos/${repo}/refs.json`))?.toString() ?? "{}") as Manifest;
    const lines = Object.entries(manifest).map(([ref, sha]) => `update ${ref} ${sha}\n`).join("");
    if (lines) await git(["--git-dir", gitDir, "update-ref", "--stdin"], { input: lines });
    await writeFile(join(gitDir, "gitsvc-shipped"), complete.join("\n") + "\n");
    await writeFile(join(gitDir, "gitsvc-refs.json"), JSON.stringify(manifest));
    await configureRepo(gitDir);
    return { packs: complete.length, bytes, refs: Object.keys(manifest).length };
  }

  private async shippedPacks(gitDir: string): Promise<Set<string>> {
    return new Set((await readFile(join(gitDir, "gitsvc-shipped"), "utf8").catch(() => "")).split("\n").filter(Boolean));
  }
  private async localManifest(gitDir: string): Promise<Manifest> {
    const text = await readFile(join(gitDir, "gitsvc-refs.json"), "utf8").catch(() => null);
    return text ? JSON.parse(text) : refsOf(gitDir);
  }
  private async put(key: string, body: Buffer) { await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body })); }
  private async get(key: string): Promise<Buffer | null> {
    try {
      const response = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      return Buffer.from(await response.Body!.transformToByteArray());
    } catch (error) { if ((error as { name?: string }).name === "NoSuchKey") return null; throw error; }
  }
  private async list(prefix: string): Promise<{ key: string; modified: number }[]> {
    const out: { key: string; modified: number }[] = [];
    let token: string | undefined;
    do {
      const page = await this.s3.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }));
      for (const object of page.Contents ?? []) out.push({ key: object.Key!, modified: object.LastModified?.getTime() ?? 0 });
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return out;
  }
}

export async function refsOf(gitDir: string): Promise<Manifest> {
  const out = await git(["--git-dir", gitDir, "for-each-ref", "--format=%(refname) %(objectname)"]);
  const manifest: Manifest = {};
  for (const line of out.split("\n").filter(Boolean)) { const [ref, sha] = line.split(" "); if (!ref.startsWith("refs/gitsvc/")) manifest[ref] = sha; }
  return manifest;
}

/** Per-repo config every repo gets at create and at restore. */
export async function configureRepo(gitDir: string) {
  const set = (key: string, value: string) => git(["--git-dir", gitDir, "config", key, value]);
  await set("receive.unpackLimit", "1");          // every push stays a pack (replication ships packs only)
  await set("receive.denyNonFastForwards", "false"); // CAS is the client's old-sha; rollback is a new commit anyway
  await set("receive.denyDeletes", "false");
  await set("uploadpack.allowFilter", "true");      // partial clone (blob:none) for jobs that want it
  await set("uploadpack.allowAnySHA1InWant", "true"); // fetch an exact commit
  await set("fastimport.unpackLimit", "0");      // server-side commits land as a pack too (default: loose below 100)
  await set("gc.auto", "0");                        // gc is ours (server.ts /gc), never inline in a push
  await set("core.logAllRefUpdates", "false");
  await set("pack.writeBitmapHashCache", "true");
  await set("repack.writeBitmaps", "true");          // clone/fetch counting from bitmaps after gc
  await stat(gitDir);
}
