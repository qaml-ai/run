import { HttpError } from "./errors.ts";
import type { SecurityEnv } from "./security-services.ts";
import { FileError } from "./file-errors.ts";
import { withSql } from "./postgres.ts";
import type { Volume } from "./volume.ts";
import {
  boundedBytes,
  imageInputs,
  storeImage,
  type ImageBindings,
  type ImageRef,
} from "./images.ts";
export interface FileBindings extends ImageBindings, SecurityEnv {
  TENANTS: DurableObjectNamespace<import("./tenant.ts").TenantAdmission>;
  // TEMPORARY(job-surface): deleted with the Volume DO after claude/delete-job-surface lands
  VOLUMES: DurableObjectNamespace<Volume>;
  REPOS: DurableObjectNamespace<import("./repos/repo-do.ts").RepoDO>;
  HYPERDRIVE: {
    connectionString: string;
  };
}
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "cache-control": "no-store" } });
async function input(request: Request, limit = 64 * 1024) {
  const bytes = await boundedBytes(request.body, limit);
  try {
    const value: unknown = bytes.length
      ? JSON.parse(new TextDecoder().decode(bytes))
      : {};
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("object required");
    return value;
  } catch {
    throw new FileError("Expected a JSON object");
  }
}
// TEMPORARY(job-surface): deleted with the Volume DO after claude/delete-job-surface lands
const stub = (env: FileBindings, tenant: string, id: string) =>
  env.VOLUMES.getByName(`${tenant}:${id}`);
export async function volume(
  env: FileBindings,
  tenant: string,
  id: string,
) {
  const row = await withSql(
    env,
    async (sql) =>
      (
        await sql.query<{
          name: string;
          created_at: number;
        }>(
          "SELECT name,created_at FROM volumes WHERE id=$1 AND tenant=$2 AND deleted_at IS NULL",
          [id, tenant],
        )
      ).rows[0],
  );
  if (!row) throw new FileError("Unknown volume", 404);
  const v = stub(env, tenant, id);
  await v.initialize(tenant, id, row.name, row.created_at);
  return v;
}
const fileFailure = (error: unknown) => {
  const message =
      error instanceof Error ? error.message : "File operation failed",
    coded = /FILE_(\d{3}):([^]*)/.exec(message);
  return json(
    {
      error:
        coded?.[2] ??
        (error instanceof HttpError ? error.message : "File operation failed"),
      ...(error instanceof HttpError ? { code: error.code, ...error.details } : {}),
    },
    coded ? Number(coded[1]) : error instanceof HttpError ? error.status : 500,
  );
};
export const VOLUMES_GONE = "Volumes are replaced by repos: use /v1/repos";
export function isVolumePath(path: string): boolean {
  return path === "/v1/volumes" || path.startsWith("/v1/volumes/");
}

export function retiredVolumes(path: string): Response | undefined {
  if (isVolumePath(path)) return json({ error: VOLUMES_GONE, code: "gone" }, 410);
}

export async function handleFileRequest(
  request: Request,
  env: FileBindings,
  principal: {
    tenantId: string;
  },
  path = new URL(request.url).pathname,
): Promise<Response | null> {
  const tenant = principal.tenantId,
    url = new URL(request.url);
  if (!path.startsWith("/v1/images"))
    return null;
  try {
    if (path === "/v1/images" && request.method === "POST")
      return json(
        await storeImage(
          env,
          tenant,
          await boundedBytes(request.body, 32 * 1024 * 1024),
        ),
        201,
      );
    if (path === "/v1/images/prepare" && request.method === "POST") {
      const body = (await input(request)) as {
        images: ImageRef[];
        urlSupport?: boolean;
      };
      if (!Array.isArray(body.images))
        throw new FileError("images must be references");
      return json({
        content: await imageInputs(
          env,
          tenant,
          body.images,
          url.origin,
          body.urlSupport === true,
        ),
      });
    }
    throw new FileError("Unknown file route", 404);
  } catch (error) {
    return fileFailure(error);
  }
}
export type { Mount } from "./repos/mounts.ts";
export { handleAgentFileRequest, handleAgentFilesRoute } from "./repos/agent-files.ts";
export type { PresentedRepoFile, WrittenRepoFile } from "./repos/agent-files.ts";
