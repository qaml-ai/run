import { Buffer } from "node:buffer";
import { BACKGROUND_CONTEXT, withAbortSignal, type Context } from "@earendil-works/chord/context";
import {
  err,
  FileError,
  LineScanner,
  ok,
  type BinaryReader,
  type ExecutionEnv,
  type FileInfo,
  type Result,
} from "@earendil-works/pi-durable/env";
import { createReadTool } from "@earendil-works/pi-durable/tools";
import { CamelFsClient, normalizeRepoPath } from "./camelfs.ts";
import { imageHeader, imageIntact } from "./lib/image-header.ts";
import { getSkillStore, SKILL_SLUG_REGEX, type SkillRecord } from "./skills.ts";
import { extractApiError, type Env } from "./types.ts";

type ReadToolOptions = NonNullable<Parameters<typeof createReadTool>[0]>;
type PiImageProcessor = NonNullable<ReadToolOptions["images"]>;
type PiImageLimits = Parameters<PiImageProcessor["prepare"]>[2];
type PiPreparedImage = Awaited<ReturnType<PiImageProcessor["prepare"]>>;

const INLINE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const encoder = new TextEncoder();

function base64ByteLength(rawByteLength: number): number {
  return Math.ceil(rawByteLength / 3) * 4;
}

/**
 * Normalizes a tool path into either:
 * - Virtual skill path: `/.skills/<slug>/SKILL.md` or `/.skills/<slug>/<file>`
 * - Canonical repo path: `/<relative-repo-path>` (stripping `/workspace/` and `/bot/` prefixes)
 */
export function normalizePiReadPath(rawPath: string): string {
  let cleaned = rawPath.trim().replace(/\\/g, "/");
  if (cleaned.startsWith("/workspace/")) {
    cleaned = cleaned.slice("/workspace/".length);
  } else if (cleaned === "/workspace") {
    cleaned = "";
  } else if (cleaned.startsWith("/bot/")) {
    cleaned = cleaned.slice("/bot/".length);
  } else if (cleaned === "/bot") {
    cleaned = "";
  }

  // Normalize virtual skills root (`/.skills/...` or `.skills/...`)
  if (cleaned === "/.skills" || cleaned === ".skills") {
    return "/.skills";
  }
  if (cleaned.startsWith("/.skills/")) {
    return `/.skills/${cleaned.slice("/.skills/".length).replace(/^\/+/, "")}`;
  }
  if (cleaned.startsWith(".skills/")) {
    return `/.skills/${cleaned.slice(".skills/".length).replace(/^\/+/, "")}`;
  }

  const repoRel = normalizeRepoPath(cleaned.replace(/^\.\//, ""));
  return `/${repoRel}`;
}

export function isVirtualSkillPath(rawPath: string): boolean {
  const normalized = normalizePiReadPath(rawPath);
  return normalized === "/.skills" || normalized.startsWith("/.skills/");
}

interface LoadedFile {
  bytes: Uint8Array;
  mtimeMs: number;
  name: string;
}

async function resolveVirtualSkillFile(
  env: Pick<Env, "MEDIA_BUCKET">,
  tenantId: string,
  canonicalPath: string,
  getResolvedSkills?: () => Promise<SkillRecord[]>,
): Promise<Result<LoadedFile, FileError>> {
  const prefix = "/.skills/";
  if (!canonicalPath.startsWith(prefix)) {
    return err(new FileError("not_found", `Skill path '${canonicalPath}' not found`, canonicalPath));
  }
  const rest = canonicalPath.slice(prefix.length).replace(/^\/+/, "");
  if (!rest || rest.includes("..")) {
    return err(new FileError("invalid", `Invalid virtual skill path '${canonicalPath}'`, canonicalPath));
  }

  // 1. Check already-resolved turn skills first (covers attached R2 skills + workspace `.agents/skills` with zero extra I/O)
  if (getResolvedSkills) {
    const resolved = await getResolvedSkills();
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
            name: relFile.split("/").pop() || relFile,
          });
        }
      }
    }
  }

  // 2. Fall back to R2SkillStore direct lookup (supports multi-segment slugs & nested reference files)
  const store = getSkillStore(env);
  const lowerRest = rest.toLowerCase();

  if (lowerRest.endsWith("/skill.md")) {
    const candidateSlug = rest.slice(0, -"/skill.md".length);
    if (SKILL_SLUG_REGEX.test(candidateSlug)) {
      const skill = await store.getSkill(tenantId, candidateSlug);
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

  // Try splitting `rest` at each `/` from right to left to match `<slug>/<file>`
  for (let idx = rest.lastIndexOf("/"); idx > 0; idx = rest.lastIndexOf("/", idx - 1)) {
    const candidateSlug = rest.slice(0, idx);
    const candidateFile = rest.slice(idx + 1);
    if (!candidateFile || !SKILL_SLUG_REGEX.test(candidateSlug)) continue;
    const skill = await store.getSkill(tenantId, candidateSlug);
    if (!skill) continue;
    if (Object.prototype.hasOwnProperty.call(skill.files, candidateFile)) {
      return ok({
        bytes: encoder.encode(skill.files[candidateFile]!),
        mtimeMs: skill.updatedAt || 1,
        name: candidateFile.split("/").pop() || candidateFile,
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

  // Bare `/.skills/<slug>` resolves to SKILL.md
  if (SKILL_SLUG_REGEX.test(rest)) {
    const skill = await store.getSkill(tenantId, rest);
    if (skill) {
      return ok({
        bytes: encoder.encode(skill.markdown),
        mtimeMs: skill.updatedAt || 1,
        name: "SKILL.md",
      });
    }
  }

  return err(new FileError("not_found", `Skill file '${canonicalPath}' not found`, canonicalPath));
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

/**
 * Lightweight `ImageProcessor` backed by Cloudflare's native `env.IMAGES` binding
 * (zero WASM bundle overhead, fast pass-through when already within model limits).
 */
export function createCloudflareImageProcessor(images?: ImagesBinding): PiImageProcessor {
  return {
    async prepare(
      bytes: Uint8Array,
      mimeType: string,
      limits: PiImageLimits,
    ): Promise<PiPreparedImage> {
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

      if (!images) {
        return undefined;
      }

      const qualities = [80, 65, 50];
      for (const quality of qualities) {
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

export interface CamelReadEnvOptions {
  env: Env;
  tenantId: string;
  at?: string;
  ensureRepo: () => Promise<{ repoId: string; lineage: string; branch: string }>;
  getResolvedSkills?: () => Promise<SkillRecord[]>;
}

/**
 * Builds the minimal `@earendil-works/pi-durable` `ExecutionEnv` surface needed by `createReadTool`:
 * `absolutePath`, `exists`, and `openBinaryReader` (`info`, `read`, `scanLines`, `close`).
 * Caches loaded bytes per canonical path within a single tool call so `exists` + `openBinaryReader`
 * never trigger duplicate CamelFS or R2 reads.
 */
export function createCamelPiReadEnv(opts: CamelReadEnvOptions): ExecutionEnv {
  const fileCache = new Map<string, Promise<Result<LoadedFile, FileError>>>();
  let repoInfoPromise: Promise<{ repoId: string; lineage: string; branch: string }> | null = null;

  const getRepoInfo = () => {
    repoInfoPromise ??= opts.ensureRepo();
    return repoInfoPromise;
  };

  const loadPath = (canonicalPath: string): Promise<Result<LoadedFile, FileError>> => {
    const cached = fileCache.get(canonicalPath);
    if (cached) return cached;

    const work = (async (): Promise<Result<LoadedFile, FileError>> => {
      if (canonicalPath === "/.skills" || canonicalPath.startsWith("/.skills/")) {
        return resolveVirtualSkillFile(
          opts.env,
          opts.tenantId,
          canonicalPath,
          opts.getResolvedSkills,
        );
      }

      const repoPath = canonicalPath.replace(/^\/+/, "");
      if (!repoPath) {
        return err(new FileError("is_directory", "Path refers to repository root", canonicalPath));
      }

      try {
        const { lineage, branch } = await getRepoInfo();
        const cfs = new CamelFsClient(opts.env, opts.tenantId);
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
          name: repoPath.split("/").pop() || repoPath,
        });
      } catch (error) {
        const apiErr = extractApiError(error);
        if (apiErr?.status === 404) {
          return err(new FileError("not_found", apiErr.message, canonicalPath));
        }
        const msg = error instanceof Error ? error.message : String(error);
        return err(new FileError("unknown", msg, canonicalPath, error instanceof Error ? error : undefined));
      }
    })();

    fileCache.set(canonicalPath, work);
    return work;
  };

  const unsupported = (method: string) =>
    Promise.resolve(err(new FileError("not_supported", `Operation '${method}' is not supported by CamelRun read env`)));

  return {
    async absolutePath(path: string, _context: Context): Promise<Result<string, FileError>> {
      return ok(normalizePiReadPath(path));
    },
    async exists(path: string, _context: Context): Promise<Result<boolean, FileError>> {
      const loaded = await loadPath(normalizePiReadPath(path));
      return ok(loaded.ok);
    },
    async openBinaryReader(
      path: string,
      _options: unknown,
      _context: Context,
    ): Promise<Result<BinaryReader, FileError>> {
      const canonical = normalizePiReadPath(path);
      const loaded = await loadPath(canonical);
      if (!loaded.ok) return loaded;
      return ok(createInMemoryBinaryReader(canonical, loaded.value));
    },
    stat: () => unsupported("stat"),
    readFile: () => unsupported("readFile"),
    readText: () => unsupported("readText"),
    writeFile: () => unsupported("writeFile"),
    mkdir: () => unsupported("mkdir"),
    remove: () => unsupported("remove"),
    openTextLines: () => unsupported("openTextLines"),
    openDir: () => unsupported("openDir"),
    listFiles: () => unsupported("listFiles"),
    watch: () => unsupported("watch"),
    exec: () => unsupported("exec"),
    cleanup: async () => {},
  } as unknown as ExecutionEnv;
}

export interface ExecutePiReadFileOptions extends CamelReadEnvOptions {
  path: string;
  offset?: number;
  limit?: number;
  signal?: AbortSignal;
}

/**
 * Executes `@earendil-works/pi-durable`'s `createReadTool` against CamelFS + virtual `/.skills/...` paths.
 * Returns bounded text (with continuation/truncation diagnostics appended when present) or a
 * `{ content: [...] }` image block compatible with `storeToolImages()`.
 */
export async function executePiReadFile(opts: ExecutePiReadFileOptions): Promise<unknown> {
  const fsEnv = createCamelPiReadEnv(opts);
  const readTool = createReadTool({
    images: createCloudflareImageProcessor(opts.env.IMAGES),
  });

  const context = opts.signal
    ? withAbortSignal(opts.signal, BACKGROUND_CONTEXT)
    : BACKGROUND_CONTEXT;

  // Minimal ToolApi surface used by `createReadTool`: `env`, `agent()`, `models.getModel()`.
  const api = {
    env: fsEnv,
    agent: async () => ({ model: undefined }),
    models: {
      getModel: () => undefined,
    },
  } as unknown as Parameters<typeof readTool.execute>[1];

  const result = await readTool.execute(
    {
      path: opts.path,
      ...(opts.offset !== undefined ? { offset: opts.offset } : {}),
      ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
    },
    api,
    context,
  );

  const diagnostics = (result.diagnostics ?? [])
    .map((d) => d.message)
    .filter((m): m is string => typeof m === "string" && m.length > 0);

  if (result.isError) {
    throw new Error(diagnostics.join(" ") || `Failed to read '${opts.path}'`);
  }

  const outputBlocks = result.output ?? [];
  const imageBlock = outputBlocks.find(
    (b): b is { type: "image"; data: string; mimeType: string } =>
      !!b && typeof b === "object" && "type" in b && b.type === "image",
  );
  if (imageBlock) {
    return {
      content: [
        ...(diagnostics.length > 0 ? [{ type: "text", text: diagnostics.join("\n") }] : []),
        { type: "image", mimeType: imageBlock.mimeType, data: imageBlock.data },
      ],
    };
  }

  const textParts = outputBlocks
    .filter(
      (b): b is { type: "text"; text: string } =>
        !!b && typeof b === "object" && "type" in b && b.type === "text" && typeof b.text === "string",
    )
    .map((b) => b.text);
  const text = textParts.join("");

  if (diagnostics.length > 0) {
    const diagBlock = diagnostics.map((m) => `[${m}]`).join("\n");
    return text ? `${text}\n\n${diagBlock}` : diagBlock;
  }

  return text;
}
