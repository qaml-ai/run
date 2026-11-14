// The file backend of a running bash VM (compute §6, "File tools and the lease"). While a branch's VM is running it holds
// the branch's ref lease, so the agent's file tools on that branch go into the VM; when it is stopped they use the ref.
// Mode is chosen by state, never by fallback: `vmFiles` returns a backend only while the branch's VM row is `running`,
// and a tool that got one uses only it. A VM that stops mid-operation fails the call loudly ("the VM stopped; retry").
// Paths are repo-relative, as the repo tools normalize them. `sha256` is the version token inside the VM.
// The backend itself is K5b2 (wf-durable); the routing in the repo tools is R6 (wf-repos).
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
};
export type VmFilesScope = { tenant: string; agent: string; repo: string; ref: string };
