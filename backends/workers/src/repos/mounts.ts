import { repoProvision, planRepo, plannedRow } from './provision.ts';
import { agentRepoId } from "./identity.ts";
export { agentRepoId } from "./identity.ts";
import { mountNotesTooLong } from "../../../../shared/mount-notes.ts";
import { FileError, normalizePath } from "../file-errors.ts";
import { MOUNT_LIMIT } from "../file-policy.ts";
import { withSql } from "../postgres.ts";
import { agentRepo, deleteRepo, repoContext, type RepoEnv } from "./registry.ts";
import { refName, repoErrorFrom } from "./repo-policy.ts";
export type Mount = { repo: string; ref?: string; path: string; mode: "ro" | "rw"; subpath?: string; notify?: boolean; instructions?: string };
export async function prepareMounts(
  env: RepoEnv,
  tenant: string,
  agent: string,
  requested: unknown,
): Promise<Mount[]> {
  if (requested === undefined) requested = [];
  if (!Array.isArray(requested) || requested.length > MOUNT_LIMIT)
    throw new FileError(
      `mounts must be an array of at most ${MOUNT_LIMIT}`,
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
  if (expanded.length > MOUNT_LIMIT) throw new FileError(`mounts must be an array of at most ${MOUNT_LIMIT}`);
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
  for (const mount of mounts) if (mount.notify && !repoProvision.getStore()) await (await repoContext(env, tenant, mount.repo, `agent:${agent}`)).repo.watch(mount.ref ?? "main", agent);
  return mounts;
}

export async function unwatchMount(env:RepoEnv,tenant:string,agent:string,mount:Mount) {
  try { await (await repoContext(env, tenant, mount.repo, `agent:${agent}`)).repo.unwatch(mount.ref??'main',agent); }
  catch(error) {
    const status=repoErrorFrom(error)?.status;
    if(status!==404&&status!==410)throw error;
  }
}

export async function releaseAgentFiles(env: RepoEnv, tenant: string, agent: string, mounts: Mount[]) {
  for (const mount of mounts) if ("repo" in mount && mount.notify)
    await unwatchMount(env,tenant,agent,mount);
  const own = agentRepoId(tenant, agent);
  const row = await env.TENANTS.getByName(tenant).repoRow(own);
  if (row && row.deletedAt === null) await deleteRepo(env, tenant, own);
}

export function refuseVolumeMounts(agent: string, mounts: unknown) {
  const legacy = Array.isArray(mounts) ? mounts.filter(m => m && typeof m === 'object' && 'volumeId' in m) : [];
  if (!legacy.length) return;
  console.error(JSON.stringify({ type: 'legacy_volume_mount_refused', agent, volumes: legacy.length }));
  const m = legacy[0];
  throw Object.assign(new Error(`Mount of volume ${m.volumeId} at ${m.path} is retired: volumes were replaced by repos. Remount it to a repo with PUT /v1/agents/${agent}/mounts with the full mounts array and remount: true.`), { status: 409 });
}

export function workspaceMount(tenant: string, agent: string, mounts: Mount[]) {
  const own = mounts.find(mount => mount.repo === agentRepoId(tenant, agent));
  if (!own) throw new FileError("This agent has no workspace mounted");
  return own;
}
