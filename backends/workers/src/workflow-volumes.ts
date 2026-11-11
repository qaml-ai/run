// A workflow's children edit forks of a volume, and the script lands each child's edits on the base with one atomic
// commit (docs/design/swarm-workflows.md, "Layers instead of worktrees", "Commits, branches, merge"). Phase 1 keeps it
// to volumes: a fork is a metadata-only copy whose files share the base's content, pinned for as long as the fork
// lives (Volume.seed, #788), and a commit checks every path's version against the base in one transaction
// (Volume.commit), so a conflicting file stops the whole commit instead of being merged.
import { createVolume } from "./file-mounts.ts";
import { volume, type FileBindings } from "./files.ts";
import { commitFiles } from "./volume-commit.ts";
import { digest, FileError, type FileEntry } from "./volume.ts";
import { COMMIT_LIMITS } from "./volume-policy.ts";

/** How long the base's snapshot a fork was made from is kept: the commit reads the base versions from it. */
export const FORK_SNAPSHOT_TTL_MS = 7 * 86_400_000;

/** A child's fork, as `agent(..., { repo })` answers it in `.fork`: the volume it edits and the volume it came from. */
export type WorkflowFork = { volume: string; base: string; snapshot: string; seq: number };
/** What a commit answers the script: the files it landed, or each path whose base moved since the fork, and nothing written. */
export type ForkCommit =
  | { committed: true; seq: number; files: string[]; removed: string[] }
  | { committed: false; conflicts: { path: string; headVersion: number }[] };

/**
 * The fork a child of `workflow` edits for effect `key:attempt`, made from `repo` (a volume of the workflow's tenant)
 * as it is now. Made again for the same effect (a restart), it is the same fork with its edits: the volume is keyed by
 * the effect, and a fork already seeded is returned as it is.
 */
export async function forkForChild(env: FileBindings, tenant: string, effect: { workflow: string; key: string; attempt: number; repo: string }): Promise<WorkflowFork> {
  if (typeof effect.repo !== "string" || !effect.repo) throw new FileError("repo is a volume id");
  const name = `${effect.workflow} ${(await digest(new TextEncoder().encode(effect.key))).slice(0, 12)}`;
  const created = await createVolume(env, tenant, { name: `fork of ${effect.repo} for ${name}`.slice(0, 120), key: `workflow:${effect.workflow}:${effect.key}:${effect.attempt}` });
  const fork = await volume(env, tenant, created.id);
  const info = await fork.info();
  if (info.origin) {
    if (info.origin.volume !== effect.repo || !info.origin.snapshot) throw new FileError(`Volume ${created.id} is not a fork of ${effect.repo}`, 409);
    return { volume: created.id, base: effect.repo, snapshot: info.origin.snapshot, seq: info.origin.seq };
  }
  const base = await volume(env, tenant, effect.repo);
  // The base as the child sees it, kept so the commit knows which version of each path the child started from.
  const snapshot = await base.snapshot(`workflow ${name}`, { pinned: true, labels: { workflow: effect.workflow }, expiresAt: Date.now() + FORK_SNAPSHOT_TTL_MS });
  const at = await base.readSet("/", snapshot.id);
  await fork.seed(at.files, { volume: effect.repo, snapshot: snapshot.id, seq: at.seq });
  return { volume: created.id, base: effect.repo, snapshot: snapshot.id, seq: at.seq };
}

/** What a fork changed against the base snapshot it was made from: written or new paths, and removed ones. */
export function forkChanges(base: FileEntry[], now: FileEntry[]) {
  const before = new Map(base.map(entry => [entry.path, entry]));
  const after = new Map(now.map(entry => [entry.path, entry]));
  const written = now.filter(entry => before.get(entry.path)?.key !== entry.key);
  const removed = base.filter(entry => !after.has(entry.path));
  return { written, removed, before };
}

/**
 * Land fork `forkId`'s edits on its base, all or nothing: each path changed in the fork is written (its content
 * referred to, not copied, where the base owns it) and each path removed is removed, every one at the version the fork
 * started from. A path the base changed since answers a conflict, with its head version, and nothing is written.
 */
export async function commitFork(env: FileBindings, tenant: string, forkId: string, options: { snapshot?: string } = {}): Promise<ForkCommit> {
  const fork = await volume(env, tenant, forkId);
  const origin = (await fork.info()).origin;
  if (!origin?.snapshot) throw new FileError(`Volume ${forkId} is not a workflow fork`, 400);
  const base = await volume(env, tenant, origin.volume);
  const [at, now] = await Promise.all([base.readSet("/", origin.snapshot), fork.readSet("/")]);
  const { written, removed, before } = forkChanges(at.files, now.files);
  if (!written.length && !removed.length) return { committed: true, seq: (await base.info()).seq, files: [], removed: [] };
  if (written.length + removed.length > COMMIT_LIMITS.files)
    throw new FileError(`The fork changed ${written.length + removed.length} files; one commit lands at most ${COMMIT_LIMITS.files}`, 413);
  const files = [
    ...written.map(entry => ({ path: entry.path, version: before.get(entry.path)?.version ?? 0, from: { volume: forkId, path: entry.path, version: entry.version } })),
    ...removed.map(entry => ({ path: entry.path, version: entry.version, delete: true })),
  ];
  const response = await commitFiles(env, tenant, origin.volume, base, { files, ...(options.snapshot ? { snapshot: { name: options.snapshot } } : {}) },
    async source => source === forkId ? fork : await volume(env, tenant, source));
  const body = await response.json() as { conflicts?: { path: string; headVersion: number }[]; seq?: number; files?: { path: string }[]; removed?: string[]; error?: string };
  if (response.status === 409 && body.conflicts) return { committed: false, conflicts: body.conflicts };
  if (!response.ok) throw new FileError(body.error ?? `The commit failed (${response.status})`, response.status);
  return { committed: true, seq: body.seq!, files: (body.files ?? []).map(file => file.path), removed: body.removed ?? [] };
}
