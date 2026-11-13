import { repoProvision, planRepo, plannedRow } from './provision.ts';
import { agentRepoId } from "./identity.ts";
export { agentRepoId } from "./identity.ts";
import { mountNotesTooLong } from "../../../../shared/mount-notes.ts";
import { FileError, normalizePath } from "../volume.ts";
import { VOLUME_LIMITS } from "../volume-policy.ts";
import { withSql } from "../postgres.ts";
import { agentRepo, deleteRepo, type RepoEnv } from "./registry.ts";
import { refName, repoErrorFrom } from "./repo-policy.ts";
export type Mount = { repo: string; ref?: string; path: string; mode: "ro" | "rw"; subpath?: string; notify?: boolean; instructions?: string };
export type LegacyVolumeMount = import("../files.ts").LegacyVolumeMount;
// TEMPORARY(volume-fork-mounts): removed by the workflows-on-branches PR
export type AgentMount = Mount | LegacyVolumeMount;
export async function prepareMounts(
  env: RepoEnv,
  tenant: string,
  agent: string,
  requested: unknown,
): Promise<Mount[]> {
  if (requested === undefined) requested = [];
  if (!Array.isArray(requested) || requested.length > VOLUME_LIMITS.mounts)
    throw new FileError(
      `mounts must be an array of at most ${VOLUME_LIMITS.mounts}`,
    );
  const own = agentRepoId(tenant, agent),
    asked = requested as Record<string, unknown>[];
  const markers = asked.filter(
    (m) => m && typeof m === "object" && "workspace" in m,
  );
  if (markers.length > 1)
    throw new FileError("Give {workspace: true} or {workspace: false} once");
  const expanded: Record<string, unknown>[] = [];
  for (const m of asked) {
    if (!m || typeof m !== "object" || Array.isArray(m))
      throw new FileError("Invalid mount");
    if ("volumeId" in m) throw new FileError("Volumes are replaced by repos: mount { repo }");
    if ("workspace" in m) {
      if (
        typeof m.workspace !== "boolean" ||
        Object.keys(m).some(
          (k) => k !== "workspace" && (m.workspace !== true || !["path", "instructions"].includes(k)),
        )
      )
        throw new FileError("Invalid workspace mount");
      if (m.workspace)
        expanded.push({
          repo: own,
          path: m.path ?? "/workspace",
          mode: "rw",
          ...(m.instructions !== undefined ? { instructions: m.instructions } : {}),
        });
    } else expanded.push(m);
  }
  if (
    !markers.length &&
    !expanded.some((m) => normalizePath(m.path) === "/workspace")
  )
    expanded.push({ repo: own, path: "/workspace", mode: "rw" });
  if (expanded.length > VOLUME_LIMITS.mounts) throw new FileError(`mounts must be an array of at most ${VOLUME_LIMITS.mounts}`);
  if (mountNotesTooLong(expanded)) throw new FileError("Mount instructions total must be at most 8192 characters");
  const mounts: Mount[] = [];
  for (const m of expanded) {
    if (
      Object.keys(m).some(
        (k) => !["repo", "ref", "path", "mode", "subpath", "notify", "instructions"].includes(k),
      )
    )
      throw new FileError("Invalid mount");
    const path = normalizePath(m.path),
      subpath = m.subpath === undefined ? "/" : normalizePath(m.subpath);
    if (path === "/" || m.path !== path)
      throw new FileError("Mount path must be absolute and normalized");
    if (m.mode !== "ro" && m.mode !== "rw")
      throw new FileError("mode must be ro or rw");
    if (m.instructions !== undefined && (typeof m.instructions !== "string" || m.instructions.length > 4096)) throw new FileError("Mount instructions must be at most 4096 characters");
    if (m.notify !== undefined && typeof m.notify !== "boolean")
      throw new FileError("notify must be a boolean");
    if (typeof m.repo !== "string") throw new FileError("Unknown repo", 404);
    const ref = m.ref ?? "main";
    refName(ref as string);
    if (
      mounts.some(
        (o) =>
          o.path === path ||
          o.path.startsWith(path + "/") ||
          path.startsWith(o.path + "/"),
      )
    )
      throw new FileError(`Mount path ${path} overlaps another mount`);
    if (m.repo === own) {
      if(repoProvision.getStore()) await planRepo(env,tenant,`agent:${agent}`,`agent ${agent}`);
      else await agentRepo(env, tenant, agent);
    }
    const row = await plannedRow(env,tenant,m.repo);
    if (!row || row.deletedAt !== null) throw new FileError(`Unknown repo ${m.repo}`, 404);
    // agent_dreaming.volume keeps its SQL name; it now stores a repo id.
    if (m.mode === "rw" && (await withSql(env, sql => sql.query('select agent from agent_dreaming where tenant=$1 and volume=$2', [tenant, m.repo]))).rows.length)
      throw new FileError("Dream memory volumes must be mounted read-only");
    mounts.push({
      ...(m.instructions !== undefined ? { instructions: m.instructions as string } : {}),
      repo: m.repo,
      ref: ref as string,
      path,
      mode: m.mode,
      ...(subpath !== "/" ? { subpath } : {}),
      ...(m.notify ? { notify: true } : {}),
    });
  }
  for (const mount of mounts) if (mount.notify && !repoProvision.getStore()) await env.REPOS.getByName(`${tenant}:${mount.repo}`).watch(mount.ref ?? "main", agent);
  return mounts;
}

export async function unwatchMount(env:Pick<RepoEnv,'REPOS'>,tenant:string,agent:string,mount:Mount) {
  try { await env.REPOS.getByName(`${tenant}:${mount.repo}`).unwatch(mount.ref??'main',agent); }
  catch(error) {
    const status=repoErrorFrom(error)?.status;
    if(status!==404&&status!==410)throw error;
  }
}

export async function releaseAgentFiles(env: RepoEnv, tenant: string, agent: string, mounts: AgentMount[]) {
  for (const mount of mounts) if ("repo" in mount && mount.notify)
    await unwatchMount(env,tenant,agent,mount);
  // TEMPORARY(volume-fork-mounts): removed by the workflows-on-branches PR
  const legacy=mounts.filter((m):m is LegacyVolumeMount=>'volumeId'in m);
  // TEMPORARY(volume-fork-mounts): removed by the workflows-on-branches PR
  if(legacy.length)await (await import('../file-mounts.ts')).releaseAgentFiles(env,tenant,agent,legacy);
  const own = agentRepoId(tenant, agent);
  const row = await env.TENANTS.getByName(tenant).repoRow(own);
  if (row && row.deletedAt === null) await deleteRepo(env, tenant, own);
}
