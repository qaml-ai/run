export type Mode = "100644" | "100755" | "120000";
export type Entry = { path: string; blob: string; mode: Mode; size: number };
export type Version = { version: string; tree: string; parents: string[]; author: string; message: string; trailers: Record<string, string>; at: number };
export type Ref = { name: string; version: string; tree: string; root: string | null; owner: string | null; expiresAt: number | null; holder: string | null; leaseEpoch: number; leaseDeadline: number | null; updatedAt: number };
export type Fence = { holder: string; epoch: number };
export class RepoError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail?: Record<string, unknown>;
  constructor(message: string, status: number, code: string, detail?: Record<string, unknown>) {
    super(`repo:${status}:${code}:${JSON.stringify(detail ?? {})}`);
    this.name = "RepoError";
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}
export function repoErrorFrom(e: unknown): RepoError | null {
  if (e instanceof RepoError) return e;
  const message = e && typeof e === "object" && "message" in e ? String(e.message) : String(e);
  const match = /repo:(\d{3}):([a-z-]+):(\{.*\})$/.exec(message);
  if (!match) return null;
  try { const detail = JSON.parse(match[3]); return new RepoError(match[2], Number(match[1]), match[2], detail); } catch { return null; }
}
export function check(ok: unknown, code = "bad-input"): asserts ok { if (!ok) throw new RepoError(code, 400, code); }
const bytes = (s: string) => new TextEncoder().encode(s).length;
export function normalizeRepoPath(input: string): string {
  check(typeof input === "string", "bad-path");
  const path = input.replace(/^\/+/, "");
  check(bytes(path) <= 4096 && !path.includes("\0") && path.split("/").every(s => s && s !== "." && s !== ".." && s !== ".git" && bytes(s) <= 255), "bad-path");
  return path;
}
export function refName(name: string) {
  check(typeof name === "string" && name.length <= 200 && /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(name) && name.split("/").every(s => s !== "." && s !== ".." && !s.endsWith(".lock")), "bad-ref");
}
export function sha1(value: string) { check(typeof value === "string" && /^[0-9a-f]{40}$/.test(value), "bad-sha1"); }
export function entry(row: Entry): Entry {
  check(row && typeof row === "object"); sha1(row.blob);
  check(Number.isSafeInteger(row.size) && row.size >= 0, "bad-size"); check(["100644", "100755", "120000"].includes(row.mode), "bad-mode");
  return { ...row, path: normalizeRepoPath(row.path) };
}
export function version(row: Version) {
  check(row && typeof row === "object"); sha1(row.version); sha1(row.tree);
  check(Array.isArray(row.parents)); row.parents.forEach(sha1);
  check(typeof row.author === "string" && Number.isSafeInteger(row.at));
  check(typeof row.message === "string" && bytes(row.message) <= 4096 && !row.message.includes("\0"), "bad-message");
  check(row.trailers && typeof row.trailers === "object" && !Array.isArray(row.trailers) && Object.keys(row.trailers).length <= 16, "bad-trailers");
  for (const [key, value] of Object.entries(row.trailers)) check(/^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(key) && typeof value === "string" && value.length <= 256 && !/[\r\n]/.test(value), "bad-trailers");
}
export function ownership(owner?: string | null, expiresAt?: number | null) {
  check(owner == null || (typeof owner === "string" && /^(agent|workflow|job|user|api):[A-Za-z0-9._:-]{1,200}$/.test(owner)), "bad-owner");
  check(expiresAt == null || Number.isSafeInteger(expiresAt), "bad-expiry");
}
export function page(limit: number | undefined, fallback: number, max: number) {
  check(limit === undefined || (Number.isSafeInteger(limit) && limit > 0), "bad-limit"); return Math.min(limit ?? fallback, max);
}
