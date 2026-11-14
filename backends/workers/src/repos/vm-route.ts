import type { VmFiles, VmFilesScope } from "../camelfs/vm-files.ts";
import { FileError } from "../file-errors.ts";
import { HttpError } from "../errors.ts";
import { sniffContentType } from "../file-policy.ts";
import { globMatch, insideRepo } from "./agent-store.ts";
import { normalizeRepoPath, repoErrorFrom } from "./repo-policy.ts";
import type { RepoEnv } from "./registry.ts";

export type VmFilesProvider = (scope: VmFilesScope) => Promise<VmFiles | undefined>;

export async function resolveVmFiles(_env: RepoEnv, scope: VmFilesScope, vmFiles?: VmFilesProvider) {
  return vmFiles?.(scope);
}

// Model-facing text (reviewed by the lead, 2026-11-14): the model knows the VM as "your machine" (the bash tool).
export const vmHeld = (branch = "This branch") =>
  `${branch} is in use by your running machine, so this can't run now. Retry after the machine goes to sleep (about 10 seconds with no command running).`;
export const VM_TOO_LARGE = "File is too large for file tools while your machine is running; use bash to work with it.";
export const STALE_FILE = "File changed since you last read it; read it again, then retry against its current content";
export const lastSaved = (branch: string) => `Showing ${branch} as last saved; a command still running on your machine may change it.`;

export class VmRouteError extends HttpError {
  constructor(status: number, message: string, code?: string, cause?: unknown) {
    super(status, message);
    if (code !== undefined) this.code = code;
    this.cause = cause;
  }

  declare readonly code: string;
}

export function heldFileError(error: unknown, branch?: string) {
  const code = repoErrorFrom(error)?.code;
  return code === "held" || code === "fenced" ? new VmRouteError(409, vmHeld(branch), code) : undefined;
}

export async function vmOperation<T>(ref: string, run: () => Promise<T>, path?: string): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code : undefined;
    if (code === "stale_path") throw new FileError(STALE_FILE, 412);
    // The machine answered: these are about the file, not a stopped machine (K5b2's codes).
    if (code === "no_file") throw new FileError(path === undefined ? "File not found" : `File not found: ${path}`, 404);
    if (code === "too_large") throw new FileError(VM_TOO_LARGE, 413);
    if (code === "bad_path") throw new FileError(path === undefined ? "Invalid path" : `Invalid path: ${path}`, 400);
    throw new VmRouteError(409, `The machine for ${ref} stopped during this operation, so it may not have completed. Check the file, then retry.`, code, error);
  }
}

export function vmRepoPath(path: string) {
  return normalizeRepoPath(insideRepo(path));
}

export function vmEntry(path: string, file: { size: number; sha256: string }, bytes: Uint8Array = new Uint8Array()) {
  return { path, size: file.size, blob: file.sha256, version: file.sha256, contentType: sniffContentType(bytes.subarray(0, 512), path) };
}

export async function vmStat(vm: VmFiles, ref: string, path: string) {
  if (path === "/") throw new FileError(`File not found: ${path}`, 404);
  const p = vmRepoPath(path);
  const file = (await vmOperation(ref, () => vm.stat([p]), path))[p];
  if (!file) throw new FileError(`File not found: ${path}`, 404);
  return file;
}

export async function readVmToolFile(vm: VmFiles, ref: string, path: string, maxBytes?: number) {
  const stat = await vmStat(vm, ref, path), p = vmRepoPath(path);
  if (maxBytes !== undefined && stat.size > maxBytes) throw new FileError("Tool file exceeds 1 MiB", 413);
  const read = await vmOperation(ref, () => vm.read(p, maxBytes === undefined ? undefined : { length: maxBytes }), path);
  if (maxBytes !== undefined && read.size > maxBytes) throw new FileError("Tool file exceeds 1 MiB", 413);
  if (read.sha256 !== stat.sha256) throw new FileError(STALE_FILE, 412);
  return { file: vmEntry(path, stat, read.bytes), bytes: read.bytes };
}

export async function* vmList(vm: VmFiles, ref: string, path: string, pattern?: string) {
  const prefix = insideRepo(path) ? vmRepoPath(path) : undefined;
  let after: string | undefined;
  do {
    const page = await vmOperation(ref, () => vm.list({ prefix, after, limit: 10000, recursive: true }));
    for (const entry of page.entries) {
      if ((!prefix || entry.path.startsWith(prefix + "/")) &&
          (!pattern || globMatch(entry.path.slice(prefix ? prefix.length + 1 : 0), pattern))) {
        yield { path: "/" + entry.path, size: entry.size, contentType: sniffContentType(new Uint8Array(), entry.path) };
      }
    }
    after = page.next;
  } while (after);
}
