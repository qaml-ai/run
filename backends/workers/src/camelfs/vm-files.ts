// The file backend of a running bash VM (compute §6, "File tools and the lease"). While a branch's VM is running it holds
// the branch's ref lease, so the agent's file tools on that branch go into the VM; when it is stopped they use the ref.
// Mode is chosen by state, never by fallback: `vmFiles` returns a backend only while the branch's VM row is `running`,
// and a tool that got one uses only it. A VM that stops mid-operation fails the call loudly ("the VM stopped; retry").
// Paths are repo-relative, as the repo tools normalize them. `sha256` is the version token inside the VM.
// The backend itself is K5b2 (wf-durable); the routing in the repo tools is R6 (wf-repos).
import { Buffer } from "node:buffer";
import type { Env } from "../agent-types.ts";
import { TOOL_READ_BYTES } from "../repos/agent-store.ts";
import { HttpRepoClient } from "../repos/http-client.ts";
import { repoContext, type RepoEnv } from "../repos/registry.ts";
import { check, normalizeRepoPath, RepoError } from "../repos/repo-policy.ts";
import type { BashSessions } from "./bash.ts";
import type { BashResult } from "./bash-stream.ts";
import { tierConfigured } from "./tier.ts";
import { vmFilesGuest } from "./vm-files-guest.ts";
import type { GrepInput, GrepResult } from "../repos/storage.ts";

export type VmFileStat = { size: number; mode: string; sha256: string };
export type VmFiles = {
  stat(paths: string[]): Promise<Record<string, VmFileStat | null>>;
  read(path: string, options?: { offset?: number; length?: number }): Promise<{ bytes: Uint8Array; size: number; sha256: string }>;
  /** Refuses `stale_path` when `expectSha256` does not hold ("none": the path must not exist). Marks the branch dirty. */
  write(path: string, bytes: Uint8Array, options?: { mode?: string; expectSha256?: string | "none" }): Promise<{ size: number; sha256: string }>;
  delete(paths: string[], options?: { expectSha256?: Record<string, string> }): Promise<void>;
  list(options: { prefix?: string; after?: string; limit: number; recursive: boolean }): Promise<{ entries: { path: string; size: number; mode: string }[]; next?: string }>;
  grep(input: GrepInput): Promise<GrepResult>;
  checkpoint(): Promise<{ version: string; tree: string }>;
};
export type VmFilesScope = { tenant: string; agent: string; repo: string; ref: string };

type VmFilesEnv = Env & { bashSessions: Pick<BashSessions, "runningFiles"> };

export async function vmFiles(env: VmFilesEnv, scope: VmFilesScope): Promise<VmFiles | undefined> {
  if (!tierConfigured(env)) return;
  const { lineage, repo } = await repoContext(env as RepoEnv, scope.tenant, scope.repo, `agent:${scope.agent}`);
  if (repo instanceof HttpRepoClient) return env.bashSessions.runningFiles(lineage, repo.tierRefName(scope.ref));
}

type Exec = (execId: string, command: string, stdin: string, mutation: boolean) => Promise<BashResult>;
const command = "python3 -c '" + vmFilesGuest.replaceAll("'", "'\\''") + "'";
const status = { stale_path: 412, no_file: 404, too_large: 413, bad_path: 400, bad_pattern: 400, bad_input: 400 };
const requestBytes = 16 * 1024 * 1024; // computehost's JSON request body limit
export const VM_FILES_STDOUT_BYTES = 16 * 1024 * 1024;

function path(value: string) {
  check(typeof value === "string" && !value.startsWith("/"), "bad_path");
  return normalizeRepoPath(value);
}
function nonnegative(value: number | undefined, code: string) {
  check(value === undefined || (Number.isSafeInteger(value) && value >= 0), code);
}
function token(value: string | undefined) {
  check(value === undefined || value === "none" || /^[a-f0-9]{64}$/.test(value), "bad_sha256");
  return value;
}

export function guestFiles(exec: Exec, checkpoint: VmFiles["checkpoint"]): VmFiles {
  async function run<T>(op: string, args: object, mutation = false): Promise<T> {
    const stdin = JSON.stringify({ op, ...args });
    // The host re-encodes stdin as a JSON string. Reserve room for the exec envelope and request metadata.
    if (Buffer.byteLength(JSON.stringify({ command, stdin })) + 1024 > requestBytes)
      throw new RepoError("VM exec request exceeds the host's body limit", 413, "too_large");
    const result = await exec("vmfiles-" + crypto.randomUUID(), command, stdin, mutation);
    if (result.error || result.exitCode !== 0 || result.timedOut)
      throw new RepoError("VM file command failed", 502, "vm_file_exec_failed");
    if (result.truncated) throw new RepoError("VM file response exceeded the available exec output", 413, "too_large");
    let reply: { value: T } | { error: keyof typeof status; details?: Record<string, unknown> };
    try { reply = JSON.parse(result.stdout); }
    catch { throw new RepoError("Invalid VM file response", 502, "invalid_response"); }
    if (reply && "value" in reply) return reply.value;
    if (reply && "error" in reply && Object.hasOwn(status, reply.error))
      throw new RepoError(reply.error, status[reply.error], reply.error, reply.details ?? undefined);
    throw new RepoError("Invalid VM file response", 502, "invalid_response");
  }
  return {
    stat: paths => run("stat", { paths: paths.map(path) }),
    async read(file, options = {}) {
      const { offset, length } = options;
      nonnegative(offset, "bad_offset");
      nonnegative(length, "bad_length");
      const { bytes, ...fileInfo } = await run<{ bytes: string; size: number; sha256: string }>("read", {
        path: path(file), offset, length, maxBytes: TOOL_READ_BYTES,
      });
      return { ...fileInfo, bytes: new Uint8Array(Buffer.from(bytes, "base64")) };
    },
    write(file, bytes, { mode, expectSha256 } = {}) {
      check(mode === undefined || ["100644", "100755", "120000"].includes(mode), "bad_mode");
      if (Math.ceil(bytes.length / 3) * 4 > requestBytes) throw new RepoError("VM exec request exceeds the host's body limit", 413, "too_large");
      return run("write", { path: path(file), bytes: Buffer.from(bytes).toString("base64"), mode, expectSha256: token(expectSha256) }, true);
    },
    async delete(paths, { expectSha256 } = {}) {
      const files = [...new Set(paths.map(path))];
      const expected = Object.fromEntries(Object.entries(expectSha256 ?? {}).map(([file, sha]) => [path(file), token(sha)]));
      await run("delete", { paths: files, expectSha256: expected }, true);
    },
    list({ prefix, after, limit, recursive }) {
      check(Number.isSafeInteger(limit) && limit >= 1 && limit <= 10000, "bad_limit");
      return run("list", { prefix: prefix ? path(prefix) : undefined, after: after ? path(after) : undefined, limit, recursive, maxOutput: VM_FILES_STDOUT_BYTES });
    },
    grep({ tree: _tree, limit = 2000, context = 0, ...input }) {
      check(Number.isSafeInteger(limit) && limit >= 1, "bad_limit");
      check(Number.isSafeInteger(context) && context >= 0 && context <= 2000, "bad_context");
      if (input.path) {
        check(!input.path.startsWith("/") && !input.path.includes("\0") && !input.path.split("/").includes(".."), "bad_path");
      }
      return run("grep", { ...input, limit: Math.min(limit, 2000), context, maxOutput: VM_FILES_STDOUT_BYTES });
    },
    checkpoint,
  };
}
