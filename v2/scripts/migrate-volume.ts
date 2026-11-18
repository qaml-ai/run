import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { AgentRuntime, type VolumeHandle } from "../../clients/node.ts";
import { CamelRun } from "../sdk/src/client.ts";
import type { RepoEntry, RepoPutFile } from "../sdk/src/types.ts";

const IMPORT_AUTHOR = "camelrun-v1-volume-import";
const WRITE_BODY_LIMIT = 64 * 1024 * 1024; // camelfsd's JSON request limit.

type FileContents = { data: Uint8Array; hash: string };
type Version = { snapshot: string } | { seq: number };

function commitMessage(volume: string, version: Version): string {
  return JSON.stringify({ volume, ...version });
}

async function draftSeq(volume: VolumeHandle): Promise<number> {
  const { seq } = await volume.info();
  if (seq === undefined) throw new Error(`Volume ${volume.id} did not report its sequence`);
  return seq;
}

async function readVolume(volume: VolumeHandle, version: Version): Promise<Map<string, FileContents>> {
  const options = "snapshot" in version ? { snapshot: version.snapshot } : {};
  const files = new Map<string, FileContents>();
  for (let after: string | undefined; ;) {
    const page = await volume.list({ ...options, after });
    for (const file of page.files) {
      const path = file.path.slice(1);
      if (file.path !== `/${path}` || path !== path.trim() ||
          path.includes("\\") || path.split("/").some(part => part === "" || part === "." || part === "..")) {
        throw new Error(`Cannot preserve v1 path ${JSON.stringify(file.path)} in v2`);
      }
      if (files.has(path)) throw new Error(`v1 listed ${file.path} twice`);
      const { data, version: fileVersion } = await volume.read(file.path, options);
      if (fileVersion !== file.version || data.byteLength !== file.size) {
        throw new Error(`v1 file ${file.path} changed during the copy`);
      }
      const hash = createHash("sha256").update(`blob ${data.byteLength}\0`).update(data).digest("hex");
      files.set(path, { data, hash });
    }
    if (page.next === undefined) break;
    if (page.next === after) throw new Error("v1 file pagination did not advance");
    after = page.next;
  }
  if ("seq" in version && version.seq !== await draftSeq(volume)) {
    throw new Error("The v1 draft changed during the copy. Run the import again with the latest draft.");
  }
  return files;
}

function fileHashes(entries: RepoEntry[]): Map<string, string> {
  return new Map(entries.filter(entry => entry.type !== "dir").map(entry => {
    if (entry.type !== "file") throw new Error(`Unexpected v2 entry type for ${entry.path}: ${entry.type}`);
    return [entry.path, entry.hash];
  }));
}

function verifyTree(commit: string, source: Map<string, FileContents>, target: Map<string, string>) {
  if (source.size !== target.size || [...source].some(([path, file]) => target.get(path) !== file.hash)) {
    throw new Error(`v2 tree at ${commit} does not match the v1 file paths and checksums`);
  }
}

export async function migrateVolume(volume: VolumeHandle, client: CamelRun, repoId: string, baseCommit: string) {
  const { defaultRef } = await client.repos.get(repoId);
  const current = await client.repos.ls(repoId, { at: defaultRef });
  let head = current.commit;
  let hashes = fileHashes(current.entries);

  // The commit itself records progress, including a write whose HTTP response was lost.
  const versions = new Map<string, string>();
  for (let at = head; ;) {
    const { commits } = await client.repos.history(repoId, { ref: at, limit: 100 });
    if (!commits.length || commits[0]!.commit !== at) throw new Error("v2 history did not reach the requested commit");
    for (const commit of commits) {
      if (commit.commit === baseCommit) {
        const base = await client.repos.ls(repoId, { at: baseCommit });
        if (commit.parents.length || base.entries.length) throw new Error("The import base must be an empty initial commit");
        break;
      }
      if (commit.author !== IMPORT_AUTHOR || commit.parents.length !== 1) {
        throw new Error(`v2 repo contains a commit outside this import: ${commit.commit}`);
      }
      const marker = JSON.parse(commit.message) as { volume?: string; snapshot?: string };
      if (marker.volume !== volume.id) throw new Error("v2 repo belongs to a different import");
      if (marker.snapshot && versions.has(commit.message)) throw new Error("v2 repo has conflicting snapshot commits");
      if (!versions.has(commit.message)) versions.set(commit.message, commit.commit);
    }
    if (commits.some(commit => commit.commit === baseCommit)) break;
    const parent = commits.at(-1)!.parents[0];
    if (!parent || parent === at) throw new Error("v2 import base is not an ancestor of the target head");
    at = parent;
  }

  const snapshots = await volume.snapshots();
  const seq = await draftSeq(volume);
  const snapshotCommits: Record<string, string> = Object.create(null);
  for (const version of [...snapshots.map(snapshot => ({ snapshot: snapshot.id })), { seq }]) {
    const message = commitMessage(volume.id, version);
    const files = await readVolume(volume, version);
    let commit = "snapshot" in version || versions.get(message) === head ? versions.get(message) : undefined;
    if (!commit) {
      const puts: RepoPutFile[] = [];
      for (const [path, file] of files) {
        if (hashes.get(path) !== file.hash) puts.push({ path, base64: Buffer.from(file.data).toString("base64") });
      }
      const input = {
        ref: defaultRef,
        expectedCommit: head,
        author: IMPORT_AUTHOR,
        message,
        puts,
        deletes: [...hashes.keys()].filter(path => !files.has(path)),
      };
      if (Buffer.byteLength(JSON.stringify(input)) >= WRITE_BODY_LIMIT) {
        throw new Error(`v1 volume ${volume.id} exceeds the v2 request limit for one atomic version`);
      }
      ({ commit } = await client.repos.write(repoId, input));
      head = commit;
    }
    const imported = fileHashes((await client.repos.ls(repoId, { at: commit })).entries);
    verifyTree(commit, files, imported);
    if (commit === head) hashes = imported;
    if ("snapshot" in version) snapshotCommits[version.snapshot] = commit;
  }

  if (seq !== await draftSeq(volume) || JSON.stringify(snapshots) !== JSON.stringify(await volume.snapshots())) {
    throw new Error("v1 changed during the import. Run the import again with the latest draft and snapshots.");
  }
  if ((await client.repos.ls(repoId, { at: defaultRef })).commit !== head) {
    throw new Error("The v2 repo changed during the import");
  }
  return { volume: volume.id, repoId, seq, head, snapshotCommits };
}

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}`);
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [volumeId, repoId, baseCommit, ...extra] = process.argv.slice(2);
  if (!volumeId || !repoId || !baseCommit || extra.length) {
    throw new Error("Usage: node --experimental-strip-types v2/scripts/migrate-volume.ts <v1-volume> <v2-repo> <v2-initial-commit>");
  }
  const source = new AgentRuntime({ url: env("V1_URL"), apiKey: env("V1_API_KEY") });
  const target = new CamelRun({ baseUrl: env("V2_URL"), apiKey: env("V2_API_KEY") });
  console.log(JSON.stringify(await migrateVolume(source.volume(volumeId), target, repoId, baseCommit)));
}
