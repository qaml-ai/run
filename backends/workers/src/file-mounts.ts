import { applying } from "../../../shared/apply-scope.ts";
import { digest, FileError } from "./volume.ts";
import {
  normalizePath,
  validVolumeId,
  VOLUME_LIMITS,
} from "./volume-policy.ts";
import { withSql } from "./postgres.ts";
import type { FileBindings, Mount } from "./files.ts";
export const workspaceId = async (id: string) =>
  `vol_${(await digest(new TextEncoder().encode(`workspace:${id}`))).slice(0, 24)}`;
export async function createVolume(
  env: FileBindings,
  tenant: string,
  input: { name?: unknown; key?: unknown } = {},
): Promise<{
  id: string;
  name: string;
  createdAt: number;
  seq: number;
  files: number;
  bytes: number;
  existing?: boolean;
}> {
  const name = input.name ?? "volume";
  if (typeof name !== "string" || !name.trim() || name.length > 120)
    throw new FileError("name must be 1–120 characters");
  if (
    input.key !== undefined &&
    (typeof input.key !== "string" ||
      !/^[A-Za-z0-9._:-]{1,200}$/.test(input.key))
  )
    throw new FileError("key is 1–200 letters, digits and ._:-");
  const id =
    input.key === undefined
      ? `vol_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`
      : `vol_${(await digest(new TextEncoder().encode(`volume-key:${tenant}:${input.key}`))).slice(0, 24)}`;
  const result = await withSql(env, async (sql) => {
    const createdAt = Date.now();
    const inserted = await sql.query(
      "INSERT INTO volumes(id,tenant,name,created_at) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING",
      [id, tenant, name.trim(), createdAt],
    );
    const row = (
      await sql.query(
        "SELECT name,created_at,tenant,deleted_at FROM volumes WHERE id=$1",
        [id],
      )
    ).rows[0];
    if (!row || row.tenant !== tenant)
      throw new FileError("Volume already exists", 409);
    if (row.deleted_at !== null)
      throw new FileError(
        `The volume for key ${input.key} was deleted; use another key`,
        409,
      );
    return {
      name: row.name,
      createdAt: row.created_at,
      existing: !inserted.rowCount,
    };
  });
  if (applying()) return { id, name: result.name, createdAt: result.createdAt, seq: 0, files: 0, bytes: 0, ...(result.existing ? { existing: true } : {}) };
  const info = await env.VOLUMES.getByName(`${tenant}:${id}`).initialize(
    tenant,
    id,
    result.name,
    result.createdAt,
  );
  return {
    ...info,
    id: info.id!,
    name: info.name!,
    ...(result.existing ? { existing: true } : {}),
  };
}
/** Resolve and validate caller mounts with the same workspace and overlap rules as src/volumes.ts. */
export async function prepareMounts(
  env: FileBindings,
  tenant: string,
  agent: string,
  requested: unknown,
): Promise<Mount[]> {
  if (requested === undefined) requested = [];
  if (!Array.isArray(requested) || requested.length > VOLUME_LIMITS.mounts)
    throw new FileError(
      `mounts must be an array of at most ${VOLUME_LIMITS.mounts}`,
    );
  const own = await workspaceId(agent),
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
          (k) => k !== "workspace" && (m.workspace !== true || k !== "path"),
        )
      )
        throw new FileError("Invalid workspace mount");
      if (m.workspace)
        expanded.push({
          volumeId: own,
          path: m.path ?? "/workspace",
          mode: "rw",
        });
    } else expanded.push(m);
  }
  if (
    !markers.length &&
    !expanded.some((m) => normalizePath(m.path) === "/workspace")
  )
    expanded.push({ volumeId: own, path: "/workspace", mode: "rw" });
  const mounts: Mount[] = [];
  for (const m of expanded) {
    if (
      Object.keys(m).some(
        (k) => !["volumeId", "path", "mode", "subpath", "notify"].includes(k),
      )
    )
      throw new FileError("Invalid mount");
    const path = normalizePath(m.path),
      subpath = m.subpath === undefined ? "/" : normalizePath(m.subpath);
    if (path === "/" || m.path !== path)
      throw new FileError("Mount path must be absolute and normalized");
    if (m.mode !== "ro" && m.mode !== "rw")
      throw new FileError("mode must be ro or rw");
    if (m.notify !== undefined && typeof m.notify !== "boolean")
      throw new FileError("notify must be a boolean");
    if (!validVolumeId(m.volumeId))
      throw new FileError(`Unknown volume ${String(m.volumeId)}`, 404);
    if (
      mounts.some(
        (o) =>
          o.path === path ||
          o.path.startsWith(path + "/") ||
          path.startsWith(o.path + "/"),
      )
    )
      throw new FileError(`Mount path ${path} overlaps another mount`);
    if (m.volumeId === own) {
      await withSql(env, (sql) =>
        sql.query(
          "INSERT INTO volumes(id,tenant,name,created_at) VALUES($1,$2,'workspace',$3) ON CONFLICT(id) DO NOTHING",
          [own, tenant, Date.now()],
        ),
      );
    }
    const row = await withSql(
      env,
      async (sql) =>
        (
          await sql.query(
            "SELECT id FROM volumes WHERE id=$1 AND tenant=$2 AND deleted_at IS NULL",
            [m.volumeId, tenant],
          )
        ).rows[0],
    );
    if (!row) throw new FileError(`Unknown volume ${m.volumeId}`, 404);
    mounts.push({
      volumeId: m.volumeId,
      path,
      mode: m.mode,
      ...(subpath !== "/" ? { subpath } : {}),
      ...(m.notify ? { notify: true } : {}),
    });
  }
  return mounts;
}
/** Revocation drops the private workspace and the agent's retained file pins. Shared volumes stay. */
export async function releaseAgentFiles(
  env: FileBindings,
  tenant: string,
  agent: string,
  mounts: Mount[],
) {
  const own = await workspaceId(agent);
  for (const id of new Set([
    own,
    `agent:${agent}`,
    ...mounts.map((m) => m.volumeId),
  ]))
    await env.VOLUMES.getByName(`${tenant}:${id}`).unpin(`agent:${agent}`);
  await withSql(env, (sql) =>
    sql.query(
      "UPDATE volumes SET deleted_at=$3 WHERE id=$1 AND tenant=$2 AND deleted_at IS NULL",
      [own, tenant, Date.now()],
    ),
  );
  await env.VOLUMES.getByName(`${tenant}:${own}`).delete();
  await withSql(env, (sql) =>
    sql.query("DELETE FROM volume_watchers WHERE agent=$1 AND tenant=$2", [
      agent,
      tenant,
    ]),
  );
}
