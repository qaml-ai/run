import { ApiError, type AgentConfiguration } from "./api-contract.ts";
import { workspaceId } from "./file-mounts.ts";
import { commitChanges } from "./repos/write.ts";
import { agentRepoId } from "./repos/mounts.ts";
import { agentRepo, createRepo, repoContext, type RepoEnv } from "./repos/registry.ts";
import type { FileBindings } from "./files.ts";
import type { FileEntry } from "./volume.ts";

export type ForkClaim = {
  sourceId: string;
  targetId: string;
  key: string;
  fingerprint: string;
  atMessage: number | null;
  copyPrivate: boolean;
  workspace?: WorkspaceSeed;
  config: AgentConfiguration & { ttlSeconds?: unknown };
  model?: unknown[];
  origin: string;
  expiresAt: number;
  expired?: boolean;
};
export type WorkspaceSeed = {repo:string;version?:string} | {legacyVolume:string;files:FileEntry[]};
const claimKey = (tenant: string, targetId: string) => `fork-claims/${encodeURIComponent(tenant)}/${targetId}.json`;
export async function readForkClaim(env: FileBindings, tenant: string, targetId: string) {
  const object = await env.BUCKET.get(claimKey(tenant, targetId));
  return object ? await object.json<ForkClaim>() : undefined;
}
/** R2's conditional create selects the first plan before any agent is created. */
export async function claimFork(env: FileBindings, tenant: string, candidate: ForkClaim) {
  if(candidate.copyPrivate) candidate.workspace=await claimAgentWorkspace(env,tenant,candidate.sourceId,candidate.targetId,candidate.expiresAt);
  const written = await env.BUCKET.put(claimKey(tenant, candidate.targetId), JSON.stringify(candidate), { onlyIf: { etagDoesNotMatch: "*" } });
  const claim = written ? candidate : await readForkClaim(env, tenant, candidate.targetId);
  if (!claim) throw new ApiError(409, "Fork completion raced this request; retry", "FORK_IN_PROGRESS");
  if (claim.sourceId !== candidate.sourceId) throw new ApiError(409, "Key belongs to another agent");
  if (claim.fingerprint !== candidate.fingerprint) throw new ApiError(409, "Fork key was claimed with different configuration or history", "FORK_CONFLICT");
  return claim;
}
export async function claimAgentWorkspace(env: FileBindings, tenant: string, sourceId: string, targetId: string, expiresAt: number) {
  const saved=await readForkClaim(env,tenant,targetId);
  if(saved?.workspace) return saved.workspace;
  // TEMPORARY(volume-fork-mounts): removed by the workflows-on-branches PR
  const {Directory}=await import('./control.ts');
  const stored=(await new Directory(env as import("./control.ts").ControlEnv,tenant).get(sourceId))?.config.mounts;
  // TEMPORARY(volume-fork-mounts): removed by the workflows-on-branches PR
  const privateVolume=await workspaceId(sourceId),legacy=stored?.find(m=>m.volumeId===privateVolume||m.volumeId===`agent:${sourceId}`);
  // TEMPORARY(volume-fork-mounts): removed by the workflows-on-branches PR
  if(legacy?.volumeId) {
    const v=env.VOLUMES.getByName(`${tenant}:${legacy.volumeId}`);await v.initialize(tenant,legacy.volumeId,'workspace');
    return {legacyVolume:legacy.volumeId,files:(await v.claimReadSet(`fork:${targetId}`,expiresAt)).files};
  }
  const source = await agentRepo(env as RepoEnv,tenant,sourceId);
  const ctx=await repoContext(env as RepoEnv,tenant,source.info.id);
  const head=await ctx.stub.ref('main');
  return {repo:source.info.id,version:head?.version};
}

export async function releaseForkClaim(env: FileBindings, tenant: string, claim: ForkClaim, expired = false) {
  // TEMPORARY(volume-fork-mounts): removed by the workflows-on-branches PR
  if(claim.workspace&&'legacyVolume'in claim.workspace)await env.VOLUMES.getByName(`${tenant}:${claim.workspace.legacyVolume}`).releaseReadSet(`fork:${claim.targetId}`);
  if (expired) await env.BUCKET.put(claimKey(tenant, claim.targetId), JSON.stringify({ sourceId: claim.sourceId, targetId: claim.targetId, expiresAt: claim.expiresAt, expired: true }));
  else await env.BUCKET.delete(claimKey(tenant, claim.targetId));
}

/** Resolved mounts retain their paths and permissions, with a new private repo. */
export async function forkWorkspaceMounts(
  mounts: AgentConfiguration["mounts"],
  sourceId: string,
  targetId: string,
  tenant: string,
) {
  const source = agentRepoId(tenant,sourceId), target = agentRepoId(tenant,targetId);
  const given = mounts ?? [{ repo: source, path: "/workspace", mode: "rw" as const }];
  // TEMPORARY(volume-fork-mounts): removed by the workflows-on-branches PR
  const oldPrivate=await workspaceId(sourceId);
  const isPrivate=(m:NonNullable<typeof mounts>[number])=>m.repo===source||m.volumeId===oldPrivate||m.volumeId===`agent:${sourceId}`;
  const privateMounts = given.filter(isPrivate);
  const copied = given.map(mount => {
    if (!isPrivate(mount)) return { ...mount };
    const {volumeId:_legacy,...repoMount}=mount;
    // Reuse the marker where it describes the exact mount. It also avoids an
    // extra marker taking a slot when the source already has sixteen mounts.
    if (privateMounts.length === 1 && mount.mode === "rw" && !mount.subpath && !mount.notify)
      return { workspace: true, path: mount.path };
    return { ...repoMount, repo: target };
  });
  // A source may have no workspace, or have it mounted somewhere else. Do not
  // let mount preparation silently add a default /workspace to the fork.
  if (!copied.some(mount => mount.path === "/workspace" || mount.workspace !== undefined)) copied.push({ workspace: false });
  return { mounts: copied, copyPrivate: privateMounts.length > 0 };
}

/** Seed the child's repo with the parent's immutable version and lineage. */
export async function copyAgentWorkspace(env: FileBindings, tenant: string, sourceId: string, targetId: string,
  captured?: WorkspaceSeed, _failAfter?: number) {
  const seed=captured ?? await claimAgentWorkspace(env,tenant,sourceId,targetId,0);
  // TEMPORARY(volume-fork-mounts): removed by the workflows-on-branches PR
  if('legacyVolume'in seed) {
    const made=await agentRepo(env as RepoEnv,tenant,targetId),ctx=await repoContext(env as RepoEnv,tenant,made.info.id);
    // Every repo is born with an empty main; a main that already holds files means this import already ran.
    const main=await ctx.stub.ref('main');
    if(main&&main.tree!=='4b825dc642cb6eb9a060e54bf8d69288fbee4904')return;
    const changes:import('./repos/write.ts').WriteInput['changes']={};
    for(const file of seed.files){const object=await env.BUCKET.get(file.key);if(!object)throw new ApiError(503,'Legacy fork file missing');changes[file.path.replace(/^\/+/,'')]={bytes:new Uint8Array(await object.arrayBuffer())};}
    if(Object.keys(changes).length)await commitChanges(ctx,{ref:'main',expect:main?.version??null,changes,message:`fork ${sourceId}`,author:`agent:${targetId}`,who:`agent:${targetId}`,why:'fork',trailers:{'Camel-Agent':targetId,'Camel-Checkpoint':'automatic'}});
    return;
  }
  if (!seed.version) { await agentRepo(env as RepoEnv,tenant,targetId); return; }
  await createRepo(env as RepoEnv,tenant,{key:`agent:${targetId}`,name:`agent ${targetId}`,from:{repo:seed.repo,version:seed.version}});
}
