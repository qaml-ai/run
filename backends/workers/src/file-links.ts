import { FileLinks, declaredType, type LinkGrant } from "./file-policy.ts";
import { FileError } from "./volume.ts";
import {
  normalizePath,
  VOLUME_LIMITS,
  validVolumeId,
} from "./volume-policy.ts";
import type { FileBindings } from "./files.ts";
function signer(env: FileBindings, base: string) {
  if (!env.FILE_SIGNING_SECRET || env.FILE_SIGNING_SECRET.length < 32)
    throw new FileError("File signing secret is not configured", 503);
  return new FileLinks(env.FILE_SIGNING_SECRET, (env as FileBindings & { AGENT_PUBLIC_URL?: string }).AGENT_PUBLIC_URL || env.PUBLIC_BASE_URL || base);
}
export function signVolumeLink(
  env: FileBindings,
  base: string,
  tenant: string,
  id: string,
  input: {
    path: string;
    method?: "GET" | "PUT";
    expiresIn?: number;
    maxBytes?: number;
    contentType?: string;
  },
) {
  if (
    input.method !== undefined &&
    input.method !== "GET" &&
    input.method !== "PUT"
  )
    throw new FileError("method must be GET or PUT");
  if (
    input.maxBytes !== undefined &&
    (!Number.isSafeInteger(input.maxBytes) ||
      input.maxBytes < 0 ||
      input.maxBytes > VOLUME_LIMITS.fileBytes)
  )
    throw new FileError("Invalid maxBytes");
  const contentType =
    input.contentType === undefined
      ? undefined
      : declaredType(input.contentType);
  if (input.contentType !== undefined && !contentType)
    throw new FileError("contentType must be a specific content type");
  return signer(env, base).sign({
    tenant,
    volume: id,
    path: normalizePath(input.path),
    method: input.method ?? "GET",
    expiresIn: input.expiresIn,
    ...(input.maxBytes !== undefined ? { maxBytes: input.maxBytes } : {}),
    ...(contentType ? { contentType } : {}),
  });
}
export function verifyVolumeLink(
  request: Request,
  env: FileBindings,
): LinkGrant | null {
  const url = new URL(request.url),
    match = /^\/v1\/links\/([^/]+)\/[^/]+$/.exec(url.pathname);
  if (!match) return null;
  const grant = signer(env, url.origin).verify(match[1]);
  if (
    !validVolumeId(grant.volume) ||
    !grant.tenant ||
    normalizePath(grant.path) !== grant.path
  )
    throw new FileError("Invalid link", 403);
  if (request.method !== grant.method)
    throw new FileError("Method not allowed", 405);
  if (
    grant.method === "PUT" &&
    grant.contentType &&
    declaredType(request.headers.get("content-type")) !== undefined &&
    declaredType(request.headers.get("content-type")) !== grant.contentType
  )
    throw new FileError("Content-Type differs from link", 415);
  return grant;
}
