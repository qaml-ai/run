import { applying } from "../../../shared/apply-scope.ts";
import { digest, FileError } from "./volume.ts";
import { withSql } from "./postgres.ts";
import type { FileBindings } from "./files.ts";
/** The id of the volume `createVolume` makes for `key`: the same key, the same volume. */
export const keyedVolumeId = async (tenant: string, key: string) =>
  `vol_${(await digest(new TextEncoder().encode(`volume-key:${tenant}:${key}`))).slice(0, 24)}`;
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
      : await keyedVolumeId(tenant, input.key);
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
