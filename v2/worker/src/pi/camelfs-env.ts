import { Buffer } from "node:buffer";
import type { Context } from "@earendil-works/chord/context";
import {
  err,
  ExecutionError,
  FileError,
  LineScanner,
  ok,
  type BinaryReader,
  type DirReader,
  type ExecutionEnv,
  type FileChange,
  type FileInfo,
  type FileListEntry,
  type FileListing,
  type FileWatcher,
  type ListFilesOptions,
  type Result,
  type ShellExecOptions,
  type ShellExecResult,
  type TextLine,
  type TextLineReader,
  type WatchTarget,
} from "@earendil-works/pi-durable/env";
import type { ImageLimits, ImageProcessor, PreparedImage } from "@earendil-works/pi-durable/tools";
import {
  CamelFsClient,
  type CamelFsClientEnv,
  type CamelFsLsResponse,
  type CamelFsReadResponse,
  type CamelFsVmExecRequest,
  type CamelFsVmExecResult,
  type CamelFsVmInfo,
  type CamelFsWriteRequest,
  type CamelFsWriteResponse,
} from "../camelfs.ts";
import { randomId } from "../crypto.ts";
import { imageHeader, imageIntact } from "../lib/image-header.ts";
import { getSkillStore, SKILL_SLUG_REGEX, type SkillRecord } from "../skills.ts";
import { extractApiError, type Env } from "../types.ts";

const INLINE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8");

function base64ByteLength(rawByteLength: number): number {
  return Math.ceil(rawByteLength / 3) * 4;
}

/**
 * Lightweight `ImageProcessor` backed by Cloudflare's native `env.IMAGES` binding
 * and our zero-WASM image header parser (avoids pulling 1.8 MiB `photon_rs_bg.wasm`).
 */
export function createCloudflareImageProcessor(images?: ImagesBinding): ImageProcessor {
  return {
    async prepare(
      bytes: Uint8Array,
      mimeType: string,
      limits: ImageLimits,
    ): Promise<PreparedImage | undefined> {
      const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const header = imageHeader(buf);
      const isInline = INLINE_IMAGE_TYPES.has(mimeType);

      if (
        isInline &&
        header &&
        header.width > 0 &&
        header.height > 0 &&
        header.mimeType === mimeType &&
        imageIntact(buf, header.mimeType) &&
        header.width <= limits.maxWidth &&
        header.height <= limits.maxHeight &&
        base64ByteLength(bytes.byteLength) <= limits.maxBytes
      ) {
        return {
          data: buf.toString("base64"),
          mimeType,
        };
      }

      if (!images) return undefined;

      for (const quality of [80, 65, 50]) {
        try {
          const source = new Blob([new Uint8Array(bytes)]).stream();
          const transformed = await images
            .input(source)
            .transform({
              width: limits.maxWidth,
              height: limits.maxHeight,
              fit: "scale-down",
            })
            .output({
              format: "image/jpeg",
              quality,
              anim: false,
            });
          const res = transformed.response();
          if (!res.ok) continue;
          const outBytes = Buffer.from(await res.arrayBuffer());
          if (base64ByteLength(outBytes.byteLength) > limits.maxBytes) continue;
          const outHeader = imageHeader(outBytes);
          if (!outHeader || outHeader.width <= 0 || outHeader.height <= 0) continue;

          const resized =
            header && (header.width !== outHeader.width || header.height !== outHeader.height)
              ? {
                  from: { width: header.width, height: header.height },
                  to: { width: outHeader.width, height: outHeader.height },
                }
              : undefined;

          return {
            data: outBytes.toString("base64"),
            mimeType: outHeader.mimeType,
            ...(resized ? { resized } : {}),
            ...(outHeader.mimeType !== mimeType ? { convertedFrom: mimeType } : {}),
          };
        } catch {
          return undefined;
        }
      }

      return undefined;
    },
  };
}

/** Narrow CamelFS client surface used by `CamelFsExecutionEnv` (injectable for unit tests). */
export interface CamelFsClientLike {
  read(
    lineage: string,
    params: { at?: string; path: string; offset?: number; limit?: number },
  ): Promise<CamelFsReadResponse>;
  write(lineage: string, req: CamelFsWriteRequest): Promise<CamelFsWriteResponse>;
  ls(
    lineage: string,
    params?: { at?: string; path?: string; recursive?: boolean | number; glob?: string },
  ): Promise<CamelFsLsResponse>;
  ensureVm(req: {
    lineage: string;
    ref: string;
    holder: string;
    vcpus?: number;
    memoryMiB?: number;
    idleTimeoutS?: number;
    leaseS?: number;
    env?: Record<string, string>;
  }): Promise<CamelFsVmInfo>;
  execVm(vmId: string, lineage: string, req: CamelFsVmExecRequest): Promise<CamelFsVmExecResult>;
}

export interface TmpScratchEntry {
  kind: "file" | "directory";
  bytes: Uint8Array;
  mtimeMs: number;
}

export interface CamelFsExecutionEnvOptions {
  env: CamelFsClientEnv & Pick<Env, "MEDIA_BUCKET" | "IMAGES">;
  tenantId: string;
  agentId: string;
  /** Optional commit/ref override for read operations. */
  at?: string;
  ensureRepo: () => Promise<{ repoId: string; lineage: string; branch: string }>;
  getResolvedSkills?: () => Promise<SkillRecord[]>;
  /** Optional pre-built or mocked CamelFS client (defaults to `new CamelFsClient(env, tenantId)`). */
  client?: CamelFsClientLike;
  /** Optional shared `/tmp` scratch store persisted across tool invocations within a DO isolate. */
  tmpEntries?: Map<string, TmpScratchEntry>;
  onFilesChanged?: (files: string[]) => void;
  onRepoCommit?: (repoId: string, commit: string) => void | Promise<void>;
  getVmSession?: (branch: string) => { vmId: string; leaseExpiresAt: number } | null;
  saveVmSession?: (branch: string, vmId: string, leaseExpiresAt: number) => void;
  clearVmSession?: (branch: string, vmId: string) => void;
  onVmBillableMs?: (billableMs: number) => void;
}

const WORKSPACE_ROOT = "/workspace";
const SKILLS_ROOT = "/.skills";
const TMP_ROOT = "/tmp";

function posixNormalize(raw: string): string {
  const cleaned = raw.replace(/\\/g, "/");
  const isAbs = cleaned.startsWith("/");
  const segments: string[] = [];
  for (const part of cleaned.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (segments.length > 0) segments.pop();
    } else {
      segments.push(part);
    }
  }
  return (isAbs ? "/" : "") + segments.join("/");
}

/**
 * Resolves any user/tool path against `cwd` into one of three canonical namespaces:
 * - `/.skills` or `/.skills/<slug>/...` (read-only virtual R2 skills)
 * - `/tmp/...` (ephemeral in-memory scratch for codemode/bash output spills)
 * - `/workspace` or `/workspace/<repo-rel-path>` (CamelFS repository tree)
 */
export function resolveCamelEnvPath(rawPath: string, cwd = WORKSPACE_ROOT): string {
  const trimmed = rawPath.trim().replace(/\\/g, "/");
  if (!trimmed) return posixNormalize(cwd) || WORKSPACE_ROOT;

  if (trimmed === ".skills" || trimmed.startsWith(".skills/")) {
    return posixNormalize(`/${trimmed}`);
  }
  if (trimmed === "/.skills" || trimmed.startsWith("/.skills/")) {
    return posixNormalize(trimmed);
  }
  if (trimmed === "/workspace/.skills" || trimmed.startsWith("/workspace/.skills/")) {
    return posixNormalize(trimmed.slice("/workspace".length));
  }
  if (trimmed === "/bot/.skills" || trimmed.startsWith("/bot/.skills/")) {
    return posixNormalize(trimmed.slice("/bot".length));
  }
  if (trimmed === "/tmp" || trimmed.startsWith("/tmp/")) {
    return posixNormalize(trimmed);
  }
  if (trimmed === "/bot" || trimmed.startsWith("/bot/")) {
    const rest = trimmed.slice("/bot".length);
    return posixNormalize(`${WORKSPACE_ROOT}${rest}`);
  }
  if (trimmed === WORKSPACE_ROOT || trimmed.startsWith(`${WORKSPACE_ROOT}/`)) {
    return posixNormalize(trimmed);
  }

  if (trimmed.startsWith("/")) {
    // Treat bare absolute paths like `/src/app.ts` as repo paths under `/workspace`
    return posixNormalize(`${WORKSPACE_ROOT}${trimmed}`);
  }

  const base = posixNormalize(cwd) || WORKSPACE_ROOT;
  return posixNormalize(`${base}/${trimmed}`);
}

export function isVirtualSkillsPath(canonicalPath: string): boolean {
  return canonicalPath === SKILLS_ROOT || canonicalPath.startsWith(`${SKILLS_ROOT}/`);
}

export function isTempScratchPath(canonicalPath: string): boolean {
  return canonicalPath === TMP_ROOT || canonicalPath.startsWith(`${TMP_ROOT}/`);
}

function toRepoRelativePath(canonicalPath: string): string {
  if (canonicalPath === WORKSPACE_ROOT) return "";
  if (canonicalPath.startsWith(`${WORKSPACE_ROOT}/`)) {
    return canonicalPath.slice(`${WORKSPACE_ROOT}/`.length);
  }
  return canonicalPath.replace(/^\/+/, "");
}

function basenameOf(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx >= 0 ? trimmed.slice(idx + 1) || "/" : trimmed || "/";
}

interface LoadedFile {
  bytes: Uint8Array;
  mtimeMs: number;
  name: string;
}

function createInMemoryBinaryReader(path: string, loaded: LoadedFile): BinaryReader {
  const { bytes, mtimeMs, name } = loaded;
  const infoValue: FileInfo = {
    name,
    path,
    kind: "file",
    size: bytes.byteLength,
    mtimeMs,
  };

  return {
    async info(_context: Context): Promise<Result<FileInfo, FileError>> {
      return ok(infoValue);
    },
    async read(offset: number, length: number, _context: Context): Promise<Result<Uint8Array, FileError>> {
      const start = Math.max(0, Math.min(bytes.byteLength, offset));
      const end = Math.max(start, Math.min(bytes.byteLength, start + Math.max(0, length)));
      return ok(bytes.subarray(start, end));
    },
    async scanLines(
      options: { startLine: number; endLine?: number },
      _context: Context,
    ): Promise<Result<ReturnType<LineScanner["finish"]>, FileError>> {
      const scanner = new LineScanner(options.startLine, options.endLine);
      scanner.push(bytes);
      return ok(scanner.finish());
    },
    async close(_context: Context): Promise<void> {},
  };
}

function createInMemoryTextLineReader(text: string): TextLineReader {
  const lines: TextLine[] = [];
  if (text.length > 0) {
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10) {
        const end = i > start && text.charCodeAt(i - 1) === 13 ? i - 1 : i;
        lines.push({ text: text.slice(start, end), terminated: true });
        start = i + 1;
      }
    }
    if (start < text.length) {
      lines.push({ text: text.slice(start), terminated: false });
    }
  }
  let idx = 0;
  return {
    async readLine(_context: Context): Promise<Result<TextLine | undefined, FileError>> {
      if (idx >= lines.length) return ok(undefined);
      return ok(lines[idx++]!);
    },
    async close(_context: Context): Promise<void> {},
  };
}

function createInMemoryDirReader(entries: FileInfo[]): DirReader {
  let idx = 0;
  return {
    async next(maxEntries: number, _context: Context) {
      const limit = Math.max(1, maxEntries);
      const slice = entries.slice(idx, idx + limit);
      idx += slice.length;
      return ok({ entries: slice, done: idx >= entries.length });
    },
    async close(_context: Context) {},
  };
}

function toBytes(content: string | Uint8Array): Uint8Array {
  return typeof content === "string" ? encoder.encode(content) : content;
}

/**
 * Full `@earendil-works/pi-durable/env` `ExecutionEnv` over:
 * 1. CamelFS repository workspace (`/workspace/...`)
 * 2. Read-only virtual R2 skills (`/.skills/...`)
 * 3. Ephemeral scratch (`/tmp/...`) for codemode & bash output spills
 * 4. Firecracker session VM execution (`exec`) with `vm_stopped` (410) auto-retry & billing callback
 */
export function createCamelFsExecutionEnv(opts: CamelFsExecutionEnvOptions): ExecutionEnv {
  const cfs: CamelFsClientLike = opts.client ?? new CamelFsClient(opts.env, opts.tenantId);
  let repoInfoPromise: Promise<{ repoId: string; lineage: string; branch: string }> | null = null;
  let cwd = WORKSPACE_ROOT;

  // Ephemeral `/tmp/...` scratch store (shared across tool calls when provided by PiAgentEngine)
  const tmpEntries = opts.tmpEntries ?? new Map<string, TmpScratchEntry>();
  if (!tmpEntries.has(TMP_ROOT)) {
    tmpEntries.set(TMP_ROOT, { kind: "directory", bytes: new Uint8Array(0), mtimeMs: Date.now() });
  }

  const getRepoInfo = () => {
    repoInfoPromise ??= opts.ensureRepo();
    return repoInfoPromise;
  };

  const ensureTmpParentDirs = (canonicalPath: string) => {
    const parts = canonicalPath.split("/").filter(Boolean);
    let cur = "";
    const now = Date.now();
    for (let i = 0; i < parts.length - 1; i++) {
      cur += `/${parts[i]}`;
      if (!tmpEntries.has(cur)) {
        tmpEntries.set(cur, { kind: "directory", bytes: new Uint8Array(0), mtimeMs: now });
      }
    }
  };

  const resolveSkillFile = async (canonicalPath: string): Promise<Result<LoadedFile, FileError>> => {
    if (canonicalPath === SKILLS_ROOT) {
      return err(new FileError("is_directory", "Path refers to virtual skills directory", canonicalPath));
    }
    const rest = canonicalPath.slice(`${SKILLS_ROOT}/`.length).replace(/^\/+/, "");
    if (!rest || rest.includes("..")) {
      return err(new FileError("invalid", `Invalid virtual skill path '${canonicalPath}'`, canonicalPath));
    }

    // 1. Check pre-resolved skills first
    if (opts.getResolvedSkills) {
      const resolved = await opts.getResolvedSkills();
      for (const skill of resolved) {
        if (
          rest === skill.slug ||
          rest === `${skill.slug}/SKILL.md` ||
          rest.toLowerCase() === `${skill.slug.toLowerCase()}/skill.md`
        ) {
          return ok({
            bytes: encoder.encode(skill.markdown),
            mtimeMs: skill.updatedAt || 1,
            name: "SKILL.md",
          });
        }
        const slugPrefix = `${skill.slug}/`;
        if (rest.startsWith(slugPrefix)) {
          const relFile = rest.slice(slugPrefix.length);
          if (Object.prototype.hasOwnProperty.call(skill.files, relFile)) {
            return ok({
              bytes: encoder.encode(skill.files[relFile]!),
              mtimeMs: skill.updatedAt || 1,
              name: basenameOf(relFile),
            });
          }
        }
      }
    }

    // 2. Fallback to R2SkillStore
    const store = getSkillStore(opts.env);
    const lowerRest = rest.toLowerCase();
    if (lowerRest.endsWith("/skill.md")) {
      const candidateSlug = rest.slice(0, -"/skill.md".length);
      if (SKILL_SLUG_REGEX.test(candidateSlug)) {
        const skill = await store.getSkill(opts.tenantId, candidateSlug);
        if (skill) {
          return ok({
            bytes: encoder.encode(skill.markdown),
            mtimeMs: skill.updatedAt || 1,
            name: "SKILL.md",
          });
        }
      }
      return err(new FileError("not_found", `Skill '${candidateSlug}' not found`, canonicalPath));
    }

    for (let idx = rest.lastIndexOf("/"); idx > 0; idx = rest.lastIndexOf("/", idx - 1)) {
      const candidateSlug = rest.slice(0, idx);
      const candidateFile = rest.slice(idx + 1);
      if (!candidateFile || !SKILL_SLUG_REGEX.test(candidateSlug)) continue;
      const skill = await store.getSkill(opts.tenantId, candidateSlug);
      if (!skill) continue;
      if (Object.prototype.hasOwnProperty.call(skill.files, candidateFile)) {
        return ok({
          bytes: encoder.encode(skill.files[candidateFile]!),
          mtimeMs: skill.updatedAt || 1,
          name: basenameOf(candidateFile),
        });
      }
      return err(
        new FileError(
          "not_found",
          `File '${candidateFile}' not found in skill '${skill.slug}'`,
          canonicalPath,
        ),
      );
    }

    if (SKILL_SLUG_REGEX.test(rest)) {
      const skill = await store.getSkill(opts.tenantId, rest);
      if (skill) {
        return ok({
          bytes: encoder.encode(skill.markdown),
          mtimeMs: skill.updatedAt || 1,
          name: "SKILL.md",
        });
      }
    }

    return err(new FileError("not_found", `Skill file '${canonicalPath}' not found`, canonicalPath));
  };

  const listAllVirtualSkillFiles = async (): Promise<Array<{ path: string; size: number; mtimeMs: number }>> => {
    const skills = opts.getResolvedSkills
      ? await opts.getResolvedSkills()
      : await (async () => {
          const store = getSkillStore(opts.env);
          const summaries = await store.listSkills(opts.tenantId);
          const records = await Promise.all(summaries.map((s) => store.getSkill(opts.tenantId, s.slug)));
          return records.filter((r): r is SkillRecord => r !== null);
        })();

    const out: Array<{ path: string; size: number; mtimeMs: number }> = [];
    for (const skill of skills) {
      out.push({
        path: `${SKILLS_ROOT}/${skill.slug}/SKILL.md`,
        size: encoder.encode(skill.markdown).byteLength,
        mtimeMs: skill.updatedAt || 1,
      });
      for (const [relFile, content] of Object.entries(skill.files)) {
        out.push({
          path: `${SKILLS_ROOT}/${skill.slug}/${relFile}`,
          size: encoder.encode(content).byteLength,
          mtimeMs: skill.updatedAt || 1,
        });
      }
    }
    return out;
  };

  const loadFileBytes = async (canonicalPath: string): Promise<Result<LoadedFile, FileError>> => {
    if (isVirtualSkillsPath(canonicalPath)) {
      return resolveSkillFile(canonicalPath);
    }

    if (isTempScratchPath(canonicalPath)) {
      const entry = tmpEntries.get(canonicalPath);
      if (!entry) {
        return err(new FileError("not_found", `File '${canonicalPath}' not found`, canonicalPath));
      }
      if (entry.kind === "directory") {
        return err(new FileError("is_directory", `'${canonicalPath}' is a directory`, canonicalPath));
      }
      return ok({ bytes: entry.bytes, mtimeMs: entry.mtimeMs, name: basenameOf(canonicalPath) });
    }

    const repoPath = toRepoRelativePath(canonicalPath);
    if (!repoPath) {
      return err(new FileError("is_directory", "Path refers to workspace root", canonicalPath));
    }

    try {
      const { lineage, branch } = await getRepoInfo();
      const res = await cfs.read(lineage, {
        at: opts.at?.trim() || branch,
        path: repoPath,
      });
      const bytes =
        res.base64 !== null
          ? new Uint8Array(Buffer.from(res.base64, "base64"))
          : res.content !== null
            ? encoder.encode(res.content)
            : new Uint8Array(0);
      return ok({
        bytes,
        mtimeMs: 1,
        name: basenameOf(repoPath),
      });
    } catch (error) {
      const apiErr = extractApiError(error);
      if (apiErr?.status === 404) {
        return err(new FileError("not_found", apiErr.message, canonicalPath));
      }
      if (apiErr?.code === "is_directory" || apiErr?.status === 400) {
        return err(new FileError("is_directory", apiErr.message, canonicalPath));
      }
      const msg = error instanceof Error ? error.message : String(error);
      return err(new FileError("unknown", msg, canonicalPath, error instanceof Error ? error : undefined));
    }
  };

  const writeCamelFile = async (
    canonicalPath: string,
    content: string | Uint8Array,
    message?: string,
  ): Promise<Result<void, FileError>> => {
    if (isVirtualSkillsPath(canonicalPath)) {
      return err(
        new FileError(
          "permission_denied",
          `Virtual skills path '${canonicalPath}' is read-only`,
          canonicalPath,
        ),
      );
    }

    if (isTempScratchPath(canonicalPath)) {
      ensureTmpParentDirs(canonicalPath);
      tmpEntries.set(canonicalPath, {
        kind: "file",
        bytes: new Uint8Array(toBytes(content)),
        mtimeMs: Date.now(),
      });
      return ok(undefined);
    }

    const repoPath = toRepoRelativePath(canonicalPath);
    if (!repoPath) {
      return err(new FileError("is_directory", "Cannot write directly to workspace root", canonicalPath));
    }

    try {
      const { repoId, lineage, branch } = await getRepoInfo();
      const put =
        typeof content === "string"
          ? { path: repoPath, content, mode: 0o644 }
          : { path: repoPath, base64: Buffer.from(content).toString("base64"), mode: 0o644 };
      const out = await cfs.write(lineage, {
        ref: branch,
        holder: opts.agentId,
        author: `agent:${opts.agentId}`,
        message: message ?? `write ${repoPath}`,
        puts: [put],
      });
      opts.onFilesChanged?.(out.changed);
      await opts.onRepoCommit?.(repoId, out.commit);
      return ok(undefined);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return err(new FileError("unknown", msg, canonicalPath, error instanceof Error ? error : undefined));
    }
  };

  const getFileInfo = async (canonicalPath: string): Promise<Result<FileInfo, FileError>> => {
    if (isVirtualSkillsPath(canonicalPath)) {
      if (canonicalPath === SKILLS_ROOT) {
        return ok({ name: ".skills", path: SKILLS_ROOT, kind: "directory", size: 0, mtimeMs: 1 });
      }
      const loaded = await resolveSkillFile(canonicalPath);
      if (loaded.ok) {
        return ok({
          name: loaded.value.name,
          path: canonicalPath,
          kind: "file",
          size: loaded.value.bytes.byteLength,
          mtimeMs: loaded.value.mtimeMs,
        });
      }
      // Check if it is a virtual directory prefix (e.g. `/.skills/my-skill`)
      const all = await listAllVirtualSkillFiles();
      const dirPrefix = `${canonicalPath}/`;
      if (all.some((f) => f.path.startsWith(dirPrefix))) {
        return ok({
          name: basenameOf(canonicalPath),
          path: canonicalPath,
          kind: "directory",
          size: 0,
          mtimeMs: 1,
        });
      }
      return loaded;
    }

    if (isTempScratchPath(canonicalPath)) {
      const entry = tmpEntries.get(canonicalPath);
      if (!entry) {
        return err(new FileError("not_found", `Path '${canonicalPath}' not found`, canonicalPath));
      }
      return ok({
        name: basenameOf(canonicalPath),
        path: canonicalPath,
        kind: entry.kind,
        size: entry.bytes.byteLength,
        mtimeMs: entry.mtimeMs,
      });
    }

    if (canonicalPath === WORKSPACE_ROOT) {
      return ok({ name: "workspace", path: WORKSPACE_ROOT, kind: "directory", size: 0, mtimeMs: 1 });
    }

    const loaded = await loadFileBytes(canonicalPath);
    if (loaded.ok) {
      return ok({
        name: loaded.value.name,
        path: canonicalPath,
        kind: "file",
        size: loaded.value.bytes.byteLength,
        mtimeMs: loaded.value.mtimeMs,
      });
    }

    // Check if directory exists in CamelFS
    try {
      const { lineage, branch } = await getRepoInfo();
      const repoPath = toRepoRelativePath(canonicalPath);
      const listing = await cfs.ls(lineage, {
        at: opts.at?.trim() || branch,
        path: repoPath,
        recursive: false,
      });
      if (listing.entries.length > 0) {
        return ok({
          name: basenameOf(canonicalPath),
          path: canonicalPath,
          kind: "directory",
          size: 0,
          mtimeMs: 1,
        });
      }
    } catch {
      // fall through to original error
    }

    return loaded;
  };

  const listDirectoryEntries = async (canonicalPath: string): Promise<Result<FileInfo[], FileError>> => {
    if (isVirtualSkillsPath(canonicalPath)) {
      const all = await listAllVirtualSkillFiles();
      const prefix = canonicalPath === SKILLS_ROOT ? `${SKILLS_ROOT}/` : `${canonicalPath}/`;
      const children = new Map<string, FileInfo>();
      for (const item of all) {
        if (!item.path.startsWith(prefix)) continue;
        const rest = item.path.slice(prefix.length);
        const slashIdx = rest.indexOf("/");
        if (slashIdx < 0) {
          children.set(rest, {
            name: rest,
            path: item.path,
            kind: "file",
            size: item.size,
            mtimeMs: item.mtimeMs,
          });
        } else {
          const dirName = rest.slice(0, slashIdx);
          if (!children.has(dirName)) {
            children.set(dirName, {
              name: dirName,
              path: `${canonicalPath}/${dirName}`,
              kind: "directory",
              size: 0,
              mtimeMs: 1,
            });
          }
        }
      }
      if (canonicalPath !== SKILLS_ROOT && children.size === 0) {
        return err(new FileError("not_found", `Directory '${canonicalPath}' not found`, canonicalPath));
      }
      return ok([...children.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)));
    }

    if (isTempScratchPath(canonicalPath)) {
      const dir = tmpEntries.get(canonicalPath);
      if (!dir) return err(new FileError("not_found", `Directory '${canonicalPath}' not found`, canonicalPath));
      if (dir.kind !== "directory") {
        return err(new FileError("not_directory", `'${canonicalPath}' is not a directory`, canonicalPath));
      }
      const prefix = `${canonicalPath}/`;
      const entries: FileInfo[] = [];
      for (const [k, v] of tmpEntries.entries()) {
        if (!k.startsWith(prefix)) continue;
        const rest = k.slice(prefix.length);
        if (!rest || rest.includes("/")) continue;
        entries.push({
          name: rest,
          path: k,
          kind: v.kind,
          size: v.bytes.byteLength,
          mtimeMs: v.mtimeMs,
        });
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      return ok(entries);
    }

    try {
      const { lineage, branch } = await getRepoInfo();
      const repoPath = toRepoRelativePath(canonicalPath);
      const listing = await cfs.ls(lineage, {
        at: opts.at?.trim() || branch,
        path: repoPath,
        recursive: false,
      });
      const out: FileInfo[] = listing.entries.map((entry) => ({
        name: basenameOf(entry.path),
        path: `${WORKSPACE_ROOT}/${entry.path.replace(/^\/+/, "")}`,
        kind: entry.type === "dir" ? "directory" : entry.type === "symlink" ? "symlink" : "file",
        size: entry.size,
        mtimeMs: 1,
      }));
      return ok(out);
    } catch (error) {
      const apiErr = extractApiError(error);
      if (apiErr?.status === 404) {
        return err(new FileError("not_found", apiErr.message, canonicalPath));
      }
      const msg = error instanceof Error ? error.message : String(error);
      return err(new FileError("unknown", msg, canonicalPath, error instanceof Error ? error : undefined));
    }
  };

  const envObj: ExecutionEnv = {
    id: `camelfs:${opts.tenantId}:${opts.agentId}`,
    get cwd() {
      return cwd;
    },
    set cwd(next: string) {
      cwd = resolveCamelEnvPath(next, WORKSPACE_ROOT);
    },

    async absolutePath(path: string, _context: Context): Promise<Result<string, FileError>> {
      return ok(resolveCamelEnvPath(path, cwd));
    },

    async canonicalPath(path: string, _context: Context): Promise<Result<string, FileError>> {
      return ok(resolveCamelEnvPath(path, cwd));
    },

    async joinPath(parts: string[], _context: Context): Promise<Result<string, FileError>> {
      const joined = parts.filter((p) => p.length > 0).join("/");
      return ok(resolveCamelEnvPath(joined, cwd));
    },

    async exists(path: string, _context: Context): Promise<Result<boolean, FileError>> {
      const canonical = resolveCamelEnvPath(path, cwd);
      const info = await getFileInfo(canonical);
      return ok(info.ok);
    },

    async fileInfo(path: string, _context: Context): Promise<Result<FileInfo, FileError>> {
      return getFileInfo(resolveCamelEnvPath(path, cwd));
    },

    async readTextFile(path: string, _context: Context): Promise<Result<string, FileError>> {
      const loaded = await loadFileBytes(resolveCamelEnvPath(path, cwd));
      if (!loaded.ok) return loaded;
      return ok(decoder.decode(loaded.value.bytes));
    },

    async readBinaryFile(path: string, _context: Context): Promise<Result<Uint8Array, FileError>> {
      const loaded = await loadFileBytes(resolveCamelEnvPath(path, cwd));
      if (!loaded.ok) return loaded;
      return ok(loaded.value.bytes);
    },

    async openTextLineReader(path: string, _context: Context): Promise<Result<TextLineReader, FileError>> {
      const loaded = await loadFileBytes(resolveCamelEnvPath(path, cwd));
      if (!loaded.ok) return loaded;
      return ok(createInMemoryTextLineReader(decoder.decode(loaded.value.bytes)));
    },

    async readTextLines(
      path: string,
      options: { maxLines?: number } | undefined,
      _context: Context,
    ): Promise<Result<string[], FileError>> {
      const loaded = await loadFileBytes(resolveCamelEnvPath(path, cwd));
      if (!loaded.ok) return loaded;
      const lines = decoder.decode(loaded.value.bytes).split(/\r?\n/);
      const maxLines = options?.maxLines;
      return ok(maxLines !== undefined && maxLines >= 0 ? lines.slice(0, maxLines) : lines);
    },

    async openBinaryReader(
      path: string,
      _options: { noFollow?: boolean } | undefined,
      _context: Context,
    ): Promise<Result<BinaryReader, FileError>> {
      const canonical = resolveCamelEnvPath(path, cwd);
      const loaded = await loadFileBytes(canonical);
      if (!loaded.ok) return loaded;
      return ok(createInMemoryBinaryReader(canonical, loaded.value));
    },

    async writeFile(
      path: string,
      content: string | Uint8Array,
      _context: Context,
    ): Promise<Result<void, FileError>> {
      return writeCamelFile(resolveCamelEnvPath(path, cwd), content);
    },

    async appendFile(
      path: string,
      content: string | Uint8Array,
      _context: Context,
    ): Promise<Result<void, FileError>> {
      const canonical = resolveCamelEnvPath(path, cwd);
      if (isVirtualSkillsPath(canonical)) {
        return err(
          new FileError("permission_denied", `Virtual skills path '${canonical}' is read-only`, canonical),
        );
      }
      const existing = await loadFileBytes(canonical);
      const prev = existing.ok ? existing.value.bytes : new Uint8Array(0);
      const add = toBytes(content);
      const merged = new Uint8Array(prev.byteLength + add.byteLength);
      merged.set(prev, 0);
      merged.set(add, prev.byteLength);
      return writeCamelFile(canonical, merged, `append ${toRepoRelativePath(canonical)}`);
    },

    async truncateFile(path: string, size: number, _context: Context): Promise<Result<void, FileError>> {
      const canonical = resolveCamelEnvPath(path, cwd);
      if (isVirtualSkillsPath(canonical)) {
        return err(
          new FileError("permission_denied", `Virtual skills path '${canonical}' is read-only`, canonical),
        );
      }
      const existing = await loadFileBytes(canonical);
      if (!existing.ok) return existing;
      const targetSize = Math.max(0, Math.floor(size));
      const next = new Uint8Array(targetSize);
      next.set(existing.value.bytes.subarray(0, Math.min(targetSize, existing.value.bytes.byteLength)));
      return writeCamelFile(canonical, next, `truncate ${toRepoRelativePath(canonical)}`);
    },

    async flushFile(_path: string, _context: Context): Promise<Result<void, FileError>> {
      return ok(undefined);
    },

    async renameFile(
      sourcePath: string,
      destinationPath: string,
      _context: Context,
    ): Promise<Result<void, FileError>> {
      const from = resolveCamelEnvPath(sourcePath, cwd);
      const to = resolveCamelEnvPath(destinationPath, cwd);
      if (isVirtualSkillsPath(from) || isVirtualSkillsPath(to)) {
        return err(
          new FileError("permission_denied", "Virtual skills directory is read-only", isVirtualSkillsPath(from) ? from : to),
        );
      }
      if (isTempScratchPath(from) && isTempScratchPath(to)) {
        const entry = tmpEntries.get(from);
        if (!entry) return err(new FileError("not_found", `Path '${from}' not found`, from));
        ensureTmpParentDirs(to);
        tmpEntries.set(to, { ...entry, mtimeMs: Date.now() });
        tmpEntries.delete(from);
        return ok(undefined);
      }
      try {
        const { repoId, lineage, branch } = await getRepoInfo();
        const fromRel = toRepoRelativePath(from);
        const toRel = toRepoRelativePath(to);
        const out = await cfs.write(lineage, {
          ref: branch,
          holder: opts.agentId,
          author: `agent:${opts.agentId}`,
          message: `rename ${fromRel} -> ${toRel}`,
          moves: [{ from: fromRel, to: toRel }],
        });
        opts.onFilesChanged?.(out.changed);
        await opts.onRepoCommit?.(repoId, out.commit);
        return ok(undefined);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return err(new FileError("unknown", msg, from, error instanceof Error ? error : undefined));
      }
    },

    async listDir(path: string, _context: Context): Promise<Result<FileInfo[], FileError>> {
      return listDirectoryEntries(resolveCamelEnvPath(path, cwd));
    },

    async openDirReader(path: string, _context: Context): Promise<Result<DirReader, FileError>> {
      const res = await listDirectoryEntries(resolveCamelEnvPath(path, cwd));
      if (!res.ok) return res;
      return ok(createInMemoryDirReader(res.value));
    },

    async listFiles(
      path: string,
      options: ListFilesOptions | undefined,
      _context: Context,
    ): Promise<Result<FileListing, FileError>> {
      const canonical = resolveCamelEnvPath(path, cwd);
      const maxEntries = options?.maxEntries ?? 50_000;
      const exclude = new Set(options?.exclude ?? []);
      const includeHidden = options?.hidden ?? true;

      if (isVirtualSkillsPath(canonical)) {
        const all = await listAllVirtualSkillFiles();
        const prefix = canonical === SKILLS_ROOT ? `${SKILLS_ROOT}/` : `${canonical}/`;
        const entries: FileListEntry[] = [];
        let truncated = false;
        for (const item of all) {
          if (!item.path.startsWith(prefix)) continue;
          const rel = item.path.slice(prefix.length);
          if (entries.length >= maxEntries) {
            truncated = true;
            break;
          }
          entries.push({ path: rel, kind: "file" });
        }
        return ok({ entries, truncated });
      }

      if (isTempScratchPath(canonical)) {
        const prefix = `${canonical}/`;
        const entries: FileListEntry[] = [];
        let truncated = false;
        for (const [k, v] of tmpEntries.entries()) {
          if (!k.startsWith(prefix)) continue;
          const rel = k.slice(prefix.length);
          if (!rel) continue;
          if (entries.length >= maxEntries) {
            truncated = true;
            break;
          }
          entries.push({ path: rel, kind: v.kind });
        }
        return ok({ entries, truncated });
      }

      try {
        const { lineage, branch } = await getRepoInfo();
        const repoPath = toRepoRelativePath(canonical);
        const listing = await cfs.ls(lineage, {
          at: opts.at?.trim() || branch,
          path: repoPath,
          recursive: true,
        });
        const basePrefix = repoPath ? `${repoPath.replace(/\/+$/, "")}/` : "";
        const entries: FileListEntry[] = [];
        let truncated = false;
        for (const item of listing.entries) {
          const clean = item.path.replace(/^\/+/, "");
          const rel = basePrefix && clean.startsWith(basePrefix) ? clean.slice(basePrefix.length) : clean;
          if (!rel) continue;
          const segs = rel.split("/");
          if (segs.includes(".git")) continue;
          if (!includeHidden && segs.some((s) => s.startsWith("."))) continue;
          if (segs.some((s) => exclude.has(s))) continue;
          if (entries.length >= maxEntries) {
            truncated = true;
            break;
          }
          entries.push({
            path: rel,
            kind: item.type === "dir" ? "directory" : item.type === "symlink" ? "symlink" : "file",
          });
        }
        return ok({ entries, truncated });
      } catch (error) {
        const apiErr = extractApiError(error);
        if (apiErr?.status === 404) {
          return err(new FileError("not_found", apiErr.message, canonical));
        }
        const msg = error instanceof Error ? error.message : String(error);
        return err(new FileError("unknown", msg, canonical, error instanceof Error ? error : undefined));
      }
    },

    async watch(
      _targets: readonly WatchTarget[],
      _onChange: (change: FileChange) => void,
      _context: Context,
    ): Promise<Result<FileWatcher, FileError>> {
      return err(new FileError("not_supported", "File watching is not supported on CamelFS"));
    },

    async createDir(
      path: string,
      _options: { recursive?: boolean } | undefined,
      _context: Context,
    ): Promise<Result<void, FileError>> {
      const canonical = resolveCamelEnvPath(path, cwd);
      if (isVirtualSkillsPath(canonical)) {
        return err(
          new FileError("permission_denied", `Virtual skills path '${canonical}' is read-only`, canonical),
        );
      }
      if (isTempScratchPath(canonical)) {
        ensureTmpParentDirs(canonical);
        tmpEntries.set(canonical, { kind: "directory", bytes: new Uint8Array(0), mtimeMs: Date.now() });
      }
      // CamelFS is Git-tree backed: directories materialize automatically on file write.
      return ok(undefined);
    },

    async remove(
      path: string,
      options: { recursive?: boolean; force?: boolean } | undefined,
      _context: Context,
    ): Promise<Result<void, FileError>> {
      const canonical = resolveCamelEnvPath(path, cwd);
      if (isVirtualSkillsPath(canonical)) {
        return err(
          new FileError("permission_denied", `Virtual skills path '${canonical}' is read-only`, canonical),
        );
      }
      if (isTempScratchPath(canonical)) {
        const existed = tmpEntries.delete(canonical);
        if (options?.recursive) {
          const prefix = `${canonical}/`;
          for (const key of [...tmpEntries.keys()]) {
            if (key.startsWith(prefix)) tmpEntries.delete(key);
          }
        }
        if (!existed && !options?.force) {
          return err(new FileError("not_found", `Path '${canonical}' not found`, canonical));
        }
        return ok(undefined);
      }

      const repoPath = toRepoRelativePath(canonical);
      if (!repoPath) {
        return err(new FileError("permission_denied", "Cannot remove workspace root", canonical));
      }
      try {
        const { repoId, lineage, branch } = await getRepoInfo();
        const out = await cfs.write(lineage, {
          ref: branch,
          holder: opts.agentId,
          author: `agent:${opts.agentId}`,
          message: `delete ${repoPath}`,
          deletes: [repoPath],
        });
        opts.onFilesChanged?.(out.changed);
        await opts.onRepoCommit?.(repoId, out.commit);
        return ok(undefined);
      } catch (error) {
        const apiErr = extractApiError(error);
        if (apiErr?.status === 404 && options?.force) {
          return ok(undefined);
        }
        const msg = error instanceof Error ? error.message : String(error);
        return err(new FileError("unknown", msg, canonical, error instanceof Error ? error : undefined));
      }
    },

    async createTempDir(
      prefix: string | undefined,
      _context: Context,
    ): Promise<Result<string, FileError>> {
      const cleanPrefix = (prefix || "pi-").replace(/[^A-Za-z0-9._-]/g, "");
      const dirPath = `${TMP_ROOT}/${cleanPrefix}${randomId("d", 6)}`;
      tmpEntries.set(dirPath, { kind: "directory", bytes: new Uint8Array(0), mtimeMs: Date.now() });
      return ok(dirPath);
    },

    async createTempFile(
      options: { prefix?: string; suffix?: string } | undefined,
      _context: Context,
    ): Promise<Result<string, FileError>> {
      const cleanPrefix = (options?.prefix || "pi-").replace(/[^A-Za-z0-9._-]/g, "");
      const cleanSuffix = (options?.suffix || ".tmp").replace(/[^A-Za-z0-9._-]/g, "");
      const filePath = `${TMP_ROOT}/${cleanPrefix}${randomId("f", 6)}${cleanSuffix}`;
      tmpEntries.set(filePath, { kind: "file", bytes: new Uint8Array(0), mtimeMs: Date.now() });
      return ok(filePath);
    },

    async exec(
      command: string | readonly string[],
      options: ShellExecOptions | undefined,
      context: Context,
    ): Promise<Result<ShellExecResult, ExecutionError>> {
      if (context.abortSignal?.aborted) {
        return err(new ExecutionError("aborted", "Command aborted before execution"));
      }

      const commandStr = Array.isArray(command)
        ? command
            .map((arg) => `'${String(arg).replace(/'/g, "'\\''")}'`)
            .join(" ")
        : String(command);

      try {
        const { repoId, lineage, branch } = await getRepoInfo();

        let session = opts.getVmSession?.(branch) ?? null;
        if (!session || session.leaseExpiresAt <= Date.now() + 5_000) {
          const booted = await cfs.ensureVm({
            lineage,
            ref: branch,
            holder: opts.agentId,
            leaseS: 600,
          });
          session = { vmId: booted.vmId, leaseExpiresAt: booted.leaseExpiresAt };
          opts.saveVmSession?.(branch, booted.vmId, booted.leaseExpiresAt);
        }

        const execRequest: CamelFsVmExecRequest = {
          execId: randomId("exec", 8),
          command: commandStr,
          ...(options?.cwd && options.cwd !== WORKSPACE_ROOT ? { cwd: options.cwd } : {}),
          ...(options?.env && Object.keys(options.env).length > 0 ? { env: options.env } : {}),
          timeoutS: options?.timeout ? Math.ceil(options.timeout) : 60,
          commit: {
            author: `agent:${opts.agentId}`,
            message: `bash: ${commandStr.slice(0, 72)}`,
            skip: false,
          },
        };

        let execRes: CamelFsVmExecResult;
        try {
          execRes = await cfs.execVm(session.vmId, lineage, execRequest);
        } catch (execErr) {
          const apiErr = extractApiError(execErr);
          if (!apiErr || apiErr.status >= 500 || apiErr.code === "vm_lost") {
            opts.clearVmSession?.(branch, session.vmId);
            return err(
              new ExecutionError(
                "spawn_error",
                execErr instanceof Error ? execErr.message : String(execErr),
                execErr instanceof Error ? execErr : undefined,
              ),
            );
          }
          if (apiErr.status === 410 && apiErr.code === "vm_stopped") {
            const booted = await cfs.ensureVm({
              lineage,
              ref: branch,
              holder: opts.agentId,
              leaseS: 600,
            });
            opts.saveVmSession?.(branch, booted.vmId, booted.leaseExpiresAt);
            execRes = await cfs.execVm(booted.vmId, lineage, execRequest);
          } else {
            return err(
              new ExecutionError(
                "unknown",
                apiErr.message,
                execErr instanceof Error ? execErr : undefined,
              ),
            );
          }
        }

        opts.onVmBillableMs?.(execRes.billableMs || execRes.durationMs || 0);
        if (execRes.commit?.filesChanged?.length) {
          opts.onFilesChanged?.(execRes.commit.filesChanged);
        }
        if (execRes.commit?.commit) {
          await opts.onRepoCommit?.(repoId, execRes.commit.commit);
        }

        if (execRes.stdout) {
          options?.onOutput?.(execRes.stdout, context, { stream: "stdout" });
        }
        if (execRes.stderr) {
          options?.onOutput?.(execRes.stderr, context, { stream: "stderr" });
        }

        let spillPath: string | undefined;
        if (options?.spill) {
          const combined = `${execRes.stdout ?? ""}${execRes.stderr ?? ""}`;
          const combinedBytes = encoder.encode(combined).byteLength;
          const lineCount = combined ? combined.split("\n").length : 0;
          if (
            combinedBytes > options.spill.afterBytes ||
            lineCount > options.spill.afterLines
          ) {
            const tmpFile = await envObj.createTempFile(
              { prefix: "pi-bash-", suffix: ".log" },
              context,
            );
            if (tmpFile.ok) {
              await envObj.writeFile(tmpFile.value, combined, context);
              spillPath = tmpFile.value;
            }
          }
        }

        if (execRes.timedOut) {
          const timeoutErr = new ExecutionError(
            "timeout",
            `Command timed out after ${execRequest.timeoutS} seconds`,
          );
          if (spillPath) timeoutErr.spillPath = spillPath;
          return err(timeoutErr);
        }

        return ok({
          exitCode: execRes.exitCode,
          ...(spillPath ? { spillPath } : {}),
        });
      } catch (error) {
        return err(
          new ExecutionError(
            "unknown",
            error instanceof Error ? error.message : String(error),
            error instanceof Error ? error : undefined,
          ),
        );
      }
    },

    async cleanup(_context: Context): Promise<void> {
      if (!opts.tmpEntries) {
        tmpEntries.clear();
        tmpEntries.set(TMP_ROOT, { kind: "directory", bytes: new Uint8Array(0), mtimeMs: Date.now() });
      }
    },
  };

  return envObj;
}
