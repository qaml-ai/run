import { ApiError, type AgentConfiguration } from "./api-contract.ts";
import { workspaceId } from "./file-mounts.ts";
import type { FileBindings } from "./files.ts";
import type { FileEntry } from "./volume.ts";

export type ForkClaim = {
  sourceId: string;
  targetId: string;
  key: string;
  fingerprint: string;
  atMessage: number | null;
  copyPrivate: boolean;
  config: AgentConfiguration & { ttlSeconds?: unknown };
  model?: unknown[];
  origin: string;
  expiresAt: number;
  expired?: boolean;
};
const claimKey = (tenant: string, targetId: string) => `fork-claims/${encodeURIComponent(tenant)}/${targetId}.json`;
export async function readForkClaim(env: FileBindings, tenant: string, targetId: string) {
  const object = await env.BUCKET.get(claimKey(tenant, targetId));
  return object ? await object.json<ForkClaim>() : undefined;
}
/** R2's conditional create selects the first plan before any agent is created. */
export async function claimFork(env: FileBindings, tenant: string, candidate: ForkClaim) {
  const written = await env.BUCKET.put(claimKey(tenant, candidate.targetId), JSON.stringify(candidate), { onlyIf: { etagDoesNotMatch: "*" } });
  const claim = written ? candidate : await readForkClaim(env, tenant, candidate.targetId);
  if (!claim) throw new ApiError(409, "Fork completion raced this request; retry", "FORK_IN_PROGRESS");
  if (claim.sourceId !== candidate.sourceId) throw new ApiError(409, "Key belongs to another agent");
  if (claim.fingerprint !== candidate.fingerprint) throw new ApiError(409, "Fork key was claimed with different configuration or history", "FORK_CONFLICT");
  return claim;
}
export async function claimAgentWorkspace(env: FileBindings, tenant: string, sourceId: string, targetId: string, expiresAt: number) {
  const id = await workspaceId(sourceId), source = env.VOLUMES.getByName(`${tenant}:${id}`);
  await source.initialize(tenant, id, "workspace");
  return source.claimReadSet(`fork:${targetId}`, expiresAt);
}
export async function releaseForkClaim(env: FileBindings, tenant: string, claim: ForkClaim, expired = false) {
  if (claim.copyPrivate) {
    const id = await workspaceId(claim.sourceId);
    await env.VOLUMES.getByName(`${tenant}:${id}`).releaseReadSet(`fork:${claim.targetId}`);
  }
  if (expired) await env.BUCKET.put(claimKey(tenant, claim.targetId), JSON.stringify({ sourceId: claim.sourceId, targetId: claim.targetId, expiresAt: claim.expiresAt, expired: true }));
  else await env.BUCKET.delete(claimKey(tenant, claim.targetId));
}

/** Resolved mounts retain their paths and permissions, with a new private volume. */
export async function forkWorkspaceMounts(
  mounts: AgentConfiguration["mounts"],
  sourceId: string,
  targetId: string,
) {
  const source = await workspaceId(sourceId), target = await workspaceId(targetId);
  const given = mounts ?? [{ volumeId: source, path: "/workspace", mode: "rw" as const }];
  const privateMounts = given.filter(mount => mount.volumeId === source);
  const copied = given.map(mount => {
    if (mount.volumeId !== source) return { ...mount };
    // Reuse the marker where it describes the exact mount. It also avoids an
    // extra marker taking a slot when the source already has sixteen mounts.
    if (privateMounts.length === 1 && mount.mode === "rw" && !mount.subpath && !mount.notify)
      return { workspace: true, path: mount.path };
    return { ...mount, volumeId: target };
  });
  // A source may have no workspace, or have it mounted somewhere else. Do not
  // let mount preparation silently add a default /workspace to the fork.
  if (!copied.some(mount => mount.path === "/workspace" || mount.workspace !== undefined)) copied.push({ workspace: false });
  return { mounts: copied, copyPrivate: privateMounts.length > 0 };
}

/** Fork the private workspace from an immutable read set. Shared mounts stay shared. */
export async function copyAgentWorkspace(
  env: FileBindings,
  tenant: string,
  sourceId: string,
  targetId: string,
  captured?: { files: FileEntry[]; seq: number },
  failAfter?: number,
) {
  const sourceVolume = await workspaceId(sourceId), targetVolume = await workspaceId(targetId);
  const source = env.VOLUMES.getByName(`${tenant}:${sourceVolume}`);
  const target = env.VOLUMES.getByName(`${tenant}:${targetVolume}`);
  await source.initialize(tenant, sourceVolume, "workspace");
  await target.initialize(tenant, targetVolume, "workspace");
  const snapshot = captured ?? await source.claimReadSet(`fork:${targetId}`);
  // The destination serializes copies and remembers completion, so concurrent
  // HTTP retries cannot write another version after the fork was returned.
  await target.copyReadSet(`fork:${targetId}`, snapshot.files, failAfter);
}
