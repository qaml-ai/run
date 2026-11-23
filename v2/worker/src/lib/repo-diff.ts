import {
  type CamelFsClient,
  type CamelFsLsEntry,
  type CamelFsRefInfo,
  normalizeRepoPath,
} from "../camelfs.ts";
import { ApiError } from "../types.ts";

export const DIFF_DEFAULT_MAX_BYTES = 65_536;
export const DIFF_MAX_BYTES_CAP = 524_288;
export const DIFF_DEFAULT_CONTEXT_LINES = 3;
export const DIFF_MAX_CONTEXT_LINES = 20;
const MAX_DIFF_FILE_BYTES = 2 * 1024 * 1024;
const MYERS_MAX_D = 800;

const utf8Encoder = new TextEncoder();

export interface RepoDiffFile {
  path: string;
  status: "added" | "modified" | "deleted";
  oldHash?: string;
  newHash?: string;
  oldSize?: number;
  newSize?: number;
  additions?: number;
  deletions?: number;
  binary?: boolean;
  patch?: string;
  truncated?: boolean;
}

export interface RepoDiffSummary {
  added: number;
  modified: number;
  deleted: number;
  totalFiles: number;
}

export interface RepoDiffResult {
  from: string;
  to: string;
  fromTree?: string;
  toTree?: string;
  identical: boolean;
  summary: RepoDiffSummary;
  files: RepoDiffFile[];
  truncated: boolean;
}

export interface RepoDiffOptions {
  from: string;
  to?: string;
  defaultRef?: string;
  path?: string;
  statOnly?: boolean;
  maxBytes?: number;
  contextLines?: number;
}

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".tiff", ".tif", ".avif",
  ".pdf", ".zip", ".gz", ".tar", ".tgz", ".bz2", ".xz", ".7z", ".rar",
  ".wasm", ".exe", ".dll", ".so", ".dylib", ".bin", ".o", ".a", ".pyc", ".class", ".jar",
  ".mp3", ".mp4", ".wav", ".ogg", ".flac", ".webm", ".mov", ".avi", ".mkv",
  ".ttf", ".otf", ".woff", ".woff2", ".eot",
  ".sqlite", ".sqlite3", ".db", ".psd", ".ai",
]);

export function utf8ByteLength(str: string): number {
  return utf8Encoder.encode(str).byteLength;
}

/**
 * Validates a Git-style ref name for /v2/repos/:repoId/refs and /lease.
 * Must start with "refs/", contain no "..", no control chars, and no whitespace.
 */
export function validateRefName(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new ApiError(400, "invalid_request", "`ref` must be a string starting with 'refs/'");
  }
  const ref = raw.trim();
  if (!ref || ref !== raw) {
    throw new ApiError(400, "invalid_request", "`ref` must not be empty or contain leading/trailing whitespace");
  }
  if (!ref.startsWith("refs/") || ref.length <= "refs/".length || ref.length > 256) {
    throw new ApiError(400, "invalid_request", "`ref` must start with 'refs/' and be 6-256 characters");
  }
  if (
    ref.includes("..") ||
    ref.includes("//") ||
    ref.includes("@{") ||
    ref.endsWith("/") ||
    ref.endsWith(".") ||
    /[\x00-\x1f\x7f\s~^:?*[\]\\]/.test(ref)
  ) {
    throw new ApiError(400, "invalid_request", `Invalid ref name: '${ref}'`);
  }
  return ref;
}

export function isBinaryPath(filePath: string): boolean {
  const dot = filePath.lastIndexOf(".");
  if (dot < 0) return false;
  const slash = filePath.lastIndexOf("/");
  if (dot < slash) return false;
  return BINARY_EXTENSIONS.has(filePath.slice(dot).toLowerCase());
}

export function isBinaryContent(text: string): boolean {
  const checkLen = Math.min(text.length, 8192);
  for (let i = 0; i < checkLen; i++) {
    if (text.charCodeAt(i) === 0) return true;
  }
  return false;
}

function splitLines(text: string): { lines: string[]; endsWithNewline: boolean } {
  if (text.length === 0) {
    return { lines: [], endsWithNewline: true };
  }
  const endsWithNewline = text.endsWith("\n");
  const trimmed = endsWithNewline ? text.slice(0, -1) : text;
  return { lines: trimmed.split("\n"), endsWithNewline };
}

type DiffOp =
  | { kind: "equal"; line: string }
  | { kind: "delete"; line: string }
  | { kind: "insert"; line: string };

function myersDiffLines(a: string[], b: string[]): DiffOp[] {
  const N = a.length;
  const M = b.length;

  let prefix = 0;
  const minLen = Math.min(N, M);
  while (prefix < minLen && a[prefix] === b[prefix]) {
    prefix++;
  }

  let suffix = 0;
  while (
    suffix < minLen - prefix &&
    a[N - 1 - suffix] === b[M - 1 - suffix]
  ) {
    suffix++;
  }

  const ops: DiffOp[] = [];
  for (let i = 0; i < prefix; i++) {
    ops.push({ kind: "equal", line: a[i]! });
  }

  const aMid = a.slice(prefix, N - suffix);
  const bMid = b.slice(prefix, M - suffix);
  const n = aMid.length;
  const m = bMid.length;

  if (n === 0) {
    for (let j = 0; j < m; j++) {
      ops.push({ kind: "insert", line: bMid[j]! });
    }
  } else if (m === 0) {
    for (let i = 0; i < n; i++) {
      ops.push({ kind: "delete", line: aMid[i]! });
    }
  } else {
    const maxD = Math.min(n + m, MYERS_MAX_D);
    const offset = maxD;
    const v = new Int32Array(2 * maxD + 1);
    const trace: Int32Array[] = [];
    let foundD = -1;

    for (let d = 0; d <= maxD; d++) {
      // Save only the active [-d, d] window of v before updating for step d.
      trace.push(v.slice(offset - d, offset + d + 1));

      for (let k = -d; k <= d; k += 2) {
        let x: number;
        if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) {
          x = v[offset + k + 1]!;
        } else {
          x = v[offset + k - 1]! + 1;
        }
        let y = x - k;
        while (x < n && y < m && aMid[x] === bMid[y]) {
          x++;
          y++;
        }
        v[offset + k] = x;
        if (x === n && y === m) {
          foundD = d;
          break;
        }
      }
      if (foundD >= 0) break;
    }

    if (foundD < 0) {
      // Edit distance exceeded MYERS_MAX_D; fall back cleanly to block replace.
      for (let i = 0; i < n; i++) ops.push({ kind: "delete", line: aMid[i]! });
      for (let j = 0; j < m; j++) ops.push({ kind: "insert", line: bMid[j]! });
    } else {
      const midOps: DiffOp[] = [];
      let x = n;
      let y = m;
      for (let d = foundD; d >= 1; d--) {
        const prevWindow = trace[d]!;
        const k = x - y;
        const prevAt = (kk: number) => prevWindow[kk + d]!;
        let prevK: number;
        if (k === -d || (k !== d && prevAt(k - 1) < prevAt(k + 1))) {
          prevK = k + 1;
        } else {
          prevK = k - 1;
        }
        const prevX = prevAt(prevK);
        const prevY = prevX - prevK;

        while (x > prevX && y > prevY) {
          midOps.push({ kind: "equal", line: aMid[x - 1]! });
          x--;
          y--;
        }
        if (x === prevX) {
          midOps.push({ kind: "insert", line: bMid[prevY]! });
        } else {
          midOps.push({ kind: "delete", line: aMid[prevX]! });
        }
        x = prevX;
        y = prevY;
      }
      while (x > 0 && y > 0) {
        midOps.push({ kind: "equal", line: aMid[x - 1]! });
        x--;
        y--;
      }
      for (let i = midOps.length - 1; i >= 0; i--) {
        ops.push(midOps[i]!);
      }
    }
  }

  for (let i = N - suffix; i < N; i++) {
    ops.push({ kind: "equal", line: a[i]! });
  }

  return ops;
}

export function computeUnifiedDiff(
  filePath: string,
  oldText: string | null,
  newText: string | null,
  contextLines = DIFF_DEFAULT_CONTEXT_LINES,
): { patch: string; additions: number; deletions: number } {
  const ctx = Math.max(0, Math.min(DIFF_MAX_CONTEXT_LINES, Math.floor(contextLines)));
  const oldSplit = oldText !== null ? splitLines(oldText) : { lines: [], endsWithNewline: true };
  const newSplit = newText !== null ? splitLines(newText) : { lines: [], endsWithNewline: true };

  let ops = myersDiffLines(oldSplit.lines, newSplit.lines);

  // Handle trailing-newline-only changes on non-empty files.
  const hasEdits = ops.some((op) => op.kind !== "equal");
  if (!hasEdits && oldText !== null && newText !== null && oldText !== newText && oldSplit.lines.length > 0) {
    const lastLine = oldSplit.lines[oldSplit.lines.length - 1]!;
    ops = [
      ...ops.slice(0, -1),
      { kind: "delete", line: lastLine },
      { kind: "insert", line: lastLine },
    ];
  }

  let additions = 0;
  let deletions = 0;
  const oldLineAt: number[] = new Array(ops.length);
  const newLineAt: number[] = new Array(ops.length);
  let oldCursor = 1;
  let newCursor = 1;
  const changeIndices: number[] = [];

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!;
    oldLineAt[i] = oldCursor;
    newLineAt[i] = newCursor;
    if (op.kind === "equal") {
      oldCursor++;
      newCursor++;
    } else if (op.kind === "delete") {
      deletions++;
      oldCursor++;
      changeIndices.push(i);
    } else {
      additions++;
      newCursor++;
      changeIndices.push(i);
    }
  }

  if (changeIndices.length === 0) {
    return { patch: "", additions: 0, deletions: 0 };
  }

  // Group change indices into hunks, merging when context windows overlap or touch.
  const hunks: Array<{ start: number; end: number }> = [];
  let curStart = Math.max(0, changeIndices[0]! - ctx);
  let curEnd = Math.min(ops.length - 1, changeIndices[0]! + ctx);
  for (let i = 1; i < changeIndices.length; i++) {
    const nextStart = Math.max(0, changeIndices[i]! - ctx);
    const nextEnd = Math.min(ops.length - 1, changeIndices[i]! + ctx);
    if (nextStart <= curEnd + 1) {
      curEnd = Math.max(curEnd, nextEnd);
    } else {
      hunks.push({ start: curStart, end: curEnd });
      curStart = nextStart;
      curEnd = nextEnd;
    }
  }
  hunks.push({ start: curStart, end: curEnd });

  const oldHeader = oldText === null ? "--- /dev/null" : `--- a/${filePath}`;
  const newHeader = newText === null ? "+++ /dev/null" : `+++ b/${filePath}`;
  const outLines: string[] = [oldHeader, newHeader];

  for (const hunk of hunks) {
    let oldCount = 0;
    let newCount = 0;
    const body: string[] = [];

    for (let i = hunk.start; i <= hunk.end; i++) {
      const op = ops[i]!;
      if (op.kind === "equal") {
        oldCount++;
        newCount++;
        body.push(` ${op.line}`);
      } else if (op.kind === "delete") {
        oldCount++;
        body.push(`-${op.line}`);
        if (
          oldText !== null &&
          !oldSplit.endsWithNewline &&
          oldLineAt[i] === oldSplit.lines.length
        ) {
          body.push("\\ No newline at end of file");
        }
      } else {
        newCount++;
        body.push(`+${op.line}`);
        if (
          newText !== null &&
          !newSplit.endsWithNewline &&
          newLineAt[i] === newSplit.lines.length
        ) {
          body.push("\\ No newline at end of file");
        }
      }
    }

    const oldStart = oldCount === 0 ? Math.max(0, oldLineAt[hunk.start]! - 1) : oldLineAt[hunk.start]!;
    const newStart = newCount === 0 ? Math.max(0, newLineAt[hunk.start]! - 1) : newLineAt[hunk.start]!;
    outLines.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    outLines.push(...body);
  }

  return {
    patch: outLines.join("\n") + "\n",
    additions,
    deletions,
  };
}

function truncatePatchToBudget(patch: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (utf8ByteLength(patch) <= maxBytes) return patch;
  const lines = patch.split("\n");
  const kept: string[] = [];
  let bytes = 0;
  for (const line of lines) {
    const chunk = kept.length === 0 ? line : `\n${line}`;
    const len = utf8ByteLength(chunk);
    if (bytes + len > maxBytes) break;
    kept.push(line);
    bytes += len;
  }
  return kept.length > 0 ? kept.join("\n") : "";
}

interface ResolvedTarget {
  at: string;
  commit?: string;
  tree?: string;
}

function resolveRefTarget(
  raw: string,
  defaultRef: string,
  refs: CamelFsRefInfo[],
): ResolvedTarget {
  const trimmed = raw.trim();
  const normalized = trimmed === "HEAD" || trimmed === "" ? defaultRef : trimmed;

  const exact = refs.find((r) => r.name === normalized);
  if (exact) {
    return { at: exact.commit, commit: exact.commit, tree: exact.tree };
  }
  if (!normalized.startsWith("refs/")) {
    const asBranch = refs.find((r) => r.name === `refs/heads/${normalized}`);
    if (asBranch) {
      return { at: asBranch.commit, commit: asBranch.commit, tree: asBranch.tree };
    }
  }
  // If raw is a commit SHA that happens to match a ref tip, pick up its tree hash too.
  const byCommit = refs.find((r) => r.commit === normalized);
  if (byCommit) {
    return { at: normalized, commit: normalized, tree: byCommit.tree };
  }
  return { at: normalized };
}

export async function computeRepoDiff(
  cfs: CamelFsClient,
  lineage: string,
  opts: RepoDiffOptions,
): Promise<RepoDiffResult> {
  const fromRaw = typeof opts.from === "string" ? opts.from.trim() : "";
  if (!fromRaw) {
    throw new ApiError(400, "invalid_request", "`from` parameter is required");
  }
  const defaultRef = opts.defaultRef?.trim() || "refs/heads/main";
  const toRaw = typeof opts.to === "string" && opts.to.trim() ? opts.to.trim() : "HEAD";
  const statOnly = Boolean(opts.statOnly);
  const pathFilter = opts.path ? normalizeRepoPath(opts.path) : "";

  let maxBytes = DIFF_DEFAULT_MAX_BYTES;
  if (opts.maxBytes !== undefined) {
    if (!Number.isFinite(opts.maxBytes) || opts.maxBytes < 0) {
      throw new ApiError(400, "invalid_request", "`maxBytes` must be a non-negative number");
    }
    maxBytes = Math.min(DIFF_MAX_BYTES_CAP, Math.floor(opts.maxBytes));
  }

  let contextLines = DIFF_DEFAULT_CONTEXT_LINES;
  if (opts.contextLines !== undefined) {
    if (!Number.isFinite(opts.contextLines) || opts.contextLines < 0) {
      throw new ApiError(400, "invalid_request", "`contextLines` must be between 0 and 20");
    }
    contextLines = Math.min(DIFF_MAX_CONTEXT_LINES, Math.floor(opts.contextLines));
  }

  // Fetch refs once to resolve HEAD / refs/* / short branch names to exact commits & tree hashes.
  let refs: CamelFsRefInfo[] = [];
  try {
    const listedRefs = await cfs.listRefs(lineage);
    refs = listedRefs.refs ?? [];
  } catch {
    refs = [];
  }

  const fromTarget = resolveRefTarget(fromRaw, defaultRef, refs);
  const toTarget = resolveRefTarget(toRaw, defaultRef, refs);

  // Fast O(1) short-circuit when comparing identical commits or trees without a path filter.
  if (
    !pathFilter &&
    fromTarget.commit &&
    toTarget.commit &&
    (fromTarget.commit === toTarget.commit ||
      (fromTarget.tree && toTarget.tree && fromTarget.tree === toTarget.tree))
  ) {
    return {
      from: fromTarget.commit,
      to: toTarget.commit,
      ...(fromTarget.tree ? { fromTree: fromTarget.tree } : {}),
      ...(toTarget.tree ? { toTree: toTarget.tree } : {}),
      identical: true,
      summary: { added: 0, modified: 0, deleted: 0, totalFiles: 0 },
      files: [],
      truncated: false,
    };
  }

  const [fromLs, toLs] = await Promise.all([
    cfs.ls(lineage, { at: fromTarget.at, path: pathFilter, recursive: true }),
    cfs.ls(lineage, { at: toTarget.at, path: pathFilter, recursive: true }),
  ]);

  const fromCommit = fromLs.commit;
  const toCommit = toLs.commit;
  const fromTree = fromTarget.tree ?? refs.find((r) => r.commit === fromCommit)?.tree;
  const toTree = toTarget.tree ?? refs.find((r) => r.commit === toCommit)?.tree;

  if (!pathFilter && fromCommit === toCommit) {
    return {
      from: fromCommit,
      to: toCommit,
      ...(fromTree ? { fromTree } : {}),
      ...(toTree ? { toTree } : {}),
      identical: true,
      summary: { added: 0, modified: 0, deleted: 0, totalFiles: 0 },
      files: [],
      truncated: false,
    };
  }

  const fromMap = new Map<string, CamelFsLsEntry>();
  for (const ent of fromLs.entries) {
    if (ent.type === "file") fromMap.set(ent.path, ent);
  }
  const toMap = new Map<string, CamelFsLsEntry>();
  for (const ent of toLs.entries) {
    if (ent.type === "file") toMap.set(ent.path, ent);
  }

  const allPaths = Array.from(new Set([...fromMap.keys(), ...toMap.keys()])).sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );

  let added = 0;
  let modified = 0;
  let deleted = 0;
  const files: RepoDiffFile[] = [];

  for (const filePath of allPaths) {
    const oldEnt = fromMap.get(filePath);
    const newEnt = toMap.get(filePath);
    if (!oldEnt && newEnt) {
      added++;
      files.push({
        path: filePath,
        status: "added",
        newHash: newEnt.hash || undefined,
        newSize: newEnt.size,
      });
    } else if (oldEnt && !newEnt) {
      deleted++;
      files.push({
        path: filePath,
        status: "deleted",
        oldHash: oldEnt.hash || undefined,
        oldSize: oldEnt.size,
      });
    } else if (oldEnt && newEnt) {
      // Zero blob reads for unchanged SHA-256 hashes!
      if (oldEnt.hash && newEnt.hash && oldEnt.hash === newEnt.hash) {
        continue;
      }
      modified++;
      files.push({
        path: filePath,
        status: "modified",
        oldHash: oldEnt.hash || undefined,
        newHash: newEnt.hash || undefined,
        oldSize: oldEnt.size,
        newSize: newEnt.size,
      });
    }
  }

  let truncated = false;

  if (!statOnly && files.length > 0) {
    let usedBytes = 0;

    for (const file of files) {
      if (isBinaryPath(file.path)) {
        file.binary = true;
        continue;
      }
      if (usedBytes >= maxBytes) {
        file.truncated = true;
        truncated = true;
        continue;
      }
      if (
        (file.oldSize !== undefined && file.oldSize > MAX_DIFF_FILE_BYTES) ||
        (file.newSize !== undefined && file.newSize > MAX_DIFF_FILE_BYTES)
      ) {
        file.truncated = true;
        truncated = true;
        continue;
      }

      let oldText: string | null = null;
      let newText: string | null = null;
      let isBinary = false;

      if (file.status === "added") {
        const res = await cfs.read(lineage, { at: toCommit, path: file.path });
        if (res.binary || res.content === null || isBinaryContent(res.content)) {
          isBinary = true;
        } else {
          newText = res.content;
        }
      } else if (file.status === "deleted") {
        const res = await cfs.read(lineage, { at: fromCommit, path: file.path });
        if (res.binary || res.content === null || isBinaryContent(res.content)) {
          isBinary = true;
        } else {
          oldText = res.content;
        }
      } else {
        const [oldRes, newRes] = await Promise.all([
          cfs.read(lineage, { at: fromCommit, path: file.path }),
          cfs.read(lineage, { at: toCommit, path: file.path }),
        ]);
        if (
          oldRes.binary ||
          oldRes.content === null ||
          isBinaryContent(oldRes.content) ||
          newRes.binary ||
          newRes.content === null ||
          isBinaryContent(newRes.content)
        ) {
          isBinary = true;
        } else {
          oldText = oldRes.content;
          newText = newRes.content;
        }
      }

      if (isBinary) {
        file.binary = true;
        continue;
      }

      const diff = computeUnifiedDiff(file.path, oldText, newText, contextLines);
      file.additions = diff.additions;
      file.deletions = diff.deletions;

      if (!diff.patch) {
        continue;
      }

      const patchBytes = utf8ByteLength(diff.patch);
      if (usedBytes + patchBytes <= maxBytes) {
        file.patch = diff.patch;
        usedBytes += patchBytes;
      } else {
        const remaining = maxBytes - usedBytes;
        const partial = truncatePatchToBudget(diff.patch, remaining);
        if (partial) {
          file.patch = partial;
        }
        file.truncated = true;
        truncated = true;
        usedBytes = maxBytes;
      }
    }
  }

  return {
    from: fromCommit,
    to: toCommit,
    ...(fromTree ? { fromTree } : {}),
    ...(toTree ? { toTree } : {}),
    identical: files.length === 0,
    summary: {
      added,
      modified,
      deleted,
      totalFiles: added + modified + deleted,
    },
    files,
    truncated,
  };
}
