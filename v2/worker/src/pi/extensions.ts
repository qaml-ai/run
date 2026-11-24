import { Buffer } from "node:buffer";
import type { Context } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import {
  CompactionTask,
  defineExtension,
  defineSignal,
  defineTool,
  GenerationTask,
  hook,
  section,
  ToolTask,
  UsageDoc,
  wrapTool,
  type Extension,
  type HookApi,
  type JsonObject,
  type ToolExecutionApi,
  type ToolExecutionResult,
  type ToolHookCall,
  type ToolPark,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { createCodingTools } from "@earendil-works/pi-durable/tools";
import {
  McpClient,
  normalizeMcpInputSchema,
  StreamableHttpTransport,
  toLlmContent,
} from "@earendil-works/pi-mcp";
import { arr, bool, map, num, obj, opt, str, unknown } from "@earendil-works/pi-schema";
import { SVG_RENDER_LIMITS } from "../../../svg-renderer/limits.ts";
import type { AgentDO } from "../agent-do.ts";
import {
  assertScreenshotPathExtension,
  BROWSER_TOOL_SCHEMAS,
  executeBrowserTool,
} from "../browser.ts";
import { CamelFsClient, normalizeRepoPath } from "../camelfs.ts";
import { mintAgentToken, openSecret, randomId, sealSecret } from "../crypto.ts";
import { imageHeader } from "../lib/image-header.ts";
import { FILE_LIMITS } from "../lib/limits.ts";
import { computeRepoDiff } from "../lib/repo-diff.ts";
import { lookupCatalogModel } from "../model-catalog-data.ts";
import {
  discoverMcpTools,
  invokeMcpTool,
  McpInputRequired,
  type DiscoveredMcpTool,
  type McpInputResponse,
} from "../mcp.ts";
import {
  buildSkillsPromptBlock,
  getSkillStore,
  readSkillFile,
  searchSkills,
  type SkillRecord,
} from "../skills.ts";
import { normalizeSvgRasterInput, recordSvgRenderUsage, renderSvg } from "../svg-render.ts";
import type { TenantDO } from "../tenant-do.ts";
import type { ToolApproval } from "../tool-identity.ts";
import type {
  AgentConfig,
  AgentUpsertInput,
  BuiltinSuite,
  Env,
  McpServerSpec,
  RpcStub,
} from "../types.ts";
import { createCloudflareImageProcessor } from "./camelfs-env.ts";
import { calculatePiCostUsd } from "./models.ts";

function getTenantStub(env: Env, tenantId: string): RpcStub<TenantDO> {
  return env.TENANT_DO.get(env.TENANT_DO.idFromName(tenantId)) as unknown as RpcStub<TenantDO>;
}

function getAgentStub(env: Env, agentId: string): RpcStub<AgentDO> {
  return env.AGENT_DO.get(env.AGENT_DO.idFromName(agentId)) as unknown as RpcStub<AgentDO>;
}

// ---- Helpers ----

function textOutput(value: unknown): ToolExecutionResult {
  if (typeof value === "string") {
    return { output: [{ type: "text", text: value }] };
  }
  if (
    value &&
    typeof value === "object" &&
    "content" in value &&
    Array.isArray((value as { content: unknown }).content)
  ) {
    const blocks = (value as { content: Array<Record<string, unknown>> }).content
      .filter((b): b is Record<string, unknown> => Boolean(b && typeof b === "object"))
      .map((b) => {
        if (b.type === "image" && typeof b.data === "string" && typeof b.mimeType === "string") {
          return { type: "image" as const, data: b.data, mimeType: b.mimeType };
        }
        return { type: "text" as const, text: typeof b.text === "string" ? b.text : JSON.stringify(b) };
      });
    return { output: blocks };
  }
  return { output: [{ type: "text", text: JSON.stringify(value ?? null) }] };
}

function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as JsonValue;
}

// ---- 1. Coding Tools Extension (`read`, `write`, `edit`, `bash` + legacy aliases) ----

export interface CamelRunCodingExtensionOptions {
  images?: ImagesBinding;
  /** Include legacy `read_file`, `write_file`, `edit_file` aliases alongside `read`, `write`, `edit`. Default `true`. */
  includeLegacyAliases?: boolean;
  /** Optional historical-commit file reader for `read_file({ path, at })`. */
  readAtCommit?: (path: string, at: string) => Promise<string>;
}

function formatBoundedLineRange(
  path: string,
  fullText: string,
  startLineArg: number | undefined,
  endLineArg: number | undefined,
  byteLimitArg: number | undefined,
): ToolExecutionResult {
  const rawLines =
    fullText.length === 0
      ? []
      : fullText.endsWith("\n")
        ? fullText.slice(0, -1).split("\n")
        : fullText.split("\n");
  const totalLines = rawLines.length;
  const startLine = startLineArg !== undefined ? Math.max(1, Math.floor(startLineArg)) : 1;
  const requestedEnd = endLineArg !== undefined ? Math.floor(endLineArg) : totalLines;
  if (endLineArg !== undefined && requestedEnd < startLine) {
    throw new Error(`read_file: end_line (${requestedEnd}) must be >= start_line (${startLine})`);
  }
  if (totalLines === 0 || startLine > totalLines) {
    return textOutput({
      path,
      content: "",
      totalLines,
      startLine: totalLines === 0 ? 0 : startLine,
      endLine: totalLines === 0 ? 0 : totalLines,
      truncated: false,
    });
  }
  const MAX_LINES = 500;
  const MAX_BYTES =
    typeof byteLimitArg === "number" && Number.isFinite(byteLimitArg) && byteLimitArg > 0
      ? Math.floor(byteLimitArg)
      : 32 * 1024;
  const clampedEnd = Math.min(totalLines, requestedEnd);
  const maxLineEnd = Math.min(clampedEnd, startLine + MAX_LINES - 1);
  const encoder = new TextEncoder();
  const formattedLines: string[] = [];
  let usedBytes = 0;
  let actualEndLine = startLine - 1;
  let byteTruncated = false;
  for (let lineNo = startLine; lineNo <= maxLineEnd; lineNo++) {
    const rawLine = rawLines[lineNo - 1]!;
    const cleanLine = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const numbered = `${lineNo}: ${cleanLine}`;
    const chunk = formattedLines.length === 0 ? numbered : `\n${numbered}`;
    const chunkBytes = encoder.encode(chunk).byteLength;
    if (usedBytes + chunkBytes > MAX_BYTES) {
      if (formattedLines.length === 0) {
        let slice = numbered;
        while (slice.length > 0 && encoder.encode(slice).byteLength > MAX_BYTES) {
          slice = slice.slice(0, Math.floor(slice.length * 0.8));
        }
        formattedLines.push(slice);
        actualEndLine = lineNo;
      }
      byteTruncated = true;
      break;
    }
    formattedLines.push(numbered);
    usedBytes += chunkBytes;
    actualEndLine = lineNo;
  }
  return textOutput({
    path,
    content: formattedLines.join("\n"),
    totalLines,
    startLine,
    endLine: actualEndLine,
    truncated: byteTruncated || actualEndLine < clampedEnd,
  });
}

export function createCamelRunCodingExtension(
  options?: CamelRunCodingExtensionOptions,
): Extension {
  const imageProcessor = createCloudflareImageProcessor(options?.images);
  const baseCoding = createCodingTools({ images: imageProcessor });
  const baseTools = [...(baseCoding.tools ?? [])] as ToolRegistration[];
  const readBase = baseTools.find((t) => t.name === "read");
  const writeBase = baseTools.find((t) => t.name === "write");
  const editBase = baseTools.find((t) => t.name === "edit");

  const readParams = obj(
    {
      path: str({ description: "Path to the file to read (relative or absolute)" }),
      offset: opt(num({ description: "Line number to start reading from (1-indexed)" })),
      limit: opt(num({ description: "Maximum number of lines to read (or byte budget with start_line/end_line)" })),
      start_line: opt(num({ description: "1-indexed inclusive start line number" })),
      end_line: opt(num({ description: "1-indexed inclusive end line number" })),
      at: opt(str({ description: "Optional git ref or commit hash to read from" })),
    },
    { open: true },
  );

  const executeCamelRead = async (
    base: ToolRegistration,
    args: {
      path: string;
      offset?: number;
      limit?: number;
      start_line?: number;
      end_line?: number;
      at?: string;
    },
    api: ToolExecutionApi,
    context: Context,
  ) => {
    if (args.start_line !== undefined || args.end_line !== undefined) {
      let fullText: string;
      if (args.at && options?.readAtCommit) {
        fullText = await options.readAtCommit(args.path, args.at);
      } else {
        if (!api.env) throw new Error("No execution environment available");
        const absRes = await api.env.absolutePath(args.path, context);
        if (!absRes.ok) throw absRes.error;
        const readRes = await api.env.readTextFile(absRes.value, context);
        if (!readRes.ok) throw readRes.error;
        fullText = readRes.value;
      }
      return formatBoundedLineRange(args.path, fullText, args.start_line, args.end_line, args.limit);
    }
    if (args.at && options?.readAtCommit) {
      return { output: [{ type: "text" as const, text: await options.readAtCommit(args.path, args.at) }] };
    }
    return base.execute(args as never, api as never, context);
  };

  // Use native `wrapTool` to extend `read` with `at` historical reads & `start_line`/`end_line`
  const wraps = [
    ...(baseCoding.wraps ?? []),
    ...(readBase
      ? [
          wrapTool(readBase, (tool) => ({
            ...tool,
            parameters: readParams,
            execute: (args, api, context) =>
              executeCamelRead(tool, args as never, api as never, context),
          })),
        ]
      : []),
  ] as Extension["wraps"];

  const aliasTools: ToolRegistration[] = [];
  if (options?.includeLegacyAliases !== false) {
    if (readBase) {
      aliasTools.push(
        defineTool({
          name: "read_file",
          description:
            "Read file contents from the repository or virtual skill files (/.skills/<slug>/SKILL.md). Compatibility alias for `read`.",
          parameters: readParams,
          execute: (args, api, context) =>
            executeCamelRead(readBase, args, api as never, context),
        }) as ToolRegistration,
      );
    }

    if (writeBase) {
      aliasTools.push(
        defineTool({
          name: "write_file",
          description: "Create or overwrite a file in the repository. Compatibility alias for `write`.",
          parameters: obj(
            {
              path: str({ description: "File path to write" }),
              content: str({ description: "File contents" }),
              message: opt(str({ description: "Optional commit message" })),
            },
            { open: true },
          ),
          execute: (args, api, context) =>
            writeBase.execute({ path: args.path, content: args.content } as never, api as never, context),
        }) as ToolRegistration,
      );
    }

    if (editBase) {
      aliasTools.push(
        defineTool({
          name: "edit_file",
          description:
            "Replace exact text inside a repository file (`oldString`/`newString` or `edits`). Compatibility alias for `edit`.",
          parameters: obj(
            {
              path: str({ description: "File path to edit" }),
              oldString: opt(str({ description: "Exact text to replace" })),
              newString: opt(str({ description: "Replacement text" })),
              replaceAll: opt(bool({ description: "Replace all occurrences" })),
              edits: opt(arr(obj({ oldText: str(), newText: str() }))),
            },
            { open: true },
          ),
          async execute(args, api, context) {
            if (args.oldString !== undefined && args.newString !== undefined) {
              if (!api.env) throw new Error("No execution environment available");
              const absRes = await api.env.absolutePath(args.path, context);
              if (!absRes.ok) throw absRes.error;
              const curRes = await api.env.readTextFile(absRes.value, context);
              if (!curRes.ok) throw curRes.error;
              const content = curRes.value;
              if (args.replaceAll) {
                if (!content.includes(args.oldString)) {
                  throw new Error(`edit_file: oldString not found in '${args.path}'`);
                }
                const writeRes = await api.env.writeFile(
                  absRes.value,
                  content.split(args.oldString).join(args.newString),
                  context,
                );
                if (!writeRes.ok) throw writeRes.error;
                return {
                  output: [{ type: "text", text: `Successfully replaced all occurrences in ${args.path}.` }],
                };
              }
              if (args.oldString.length > 0) {
                const lineNumbers: number[] = [];
                for (let idx = content.indexOf(args.oldString); idx !== -1; idx = content.indexOf(args.oldString, idx + args.oldString.length)) {
                  lineNumbers.push(content.slice(0, idx).split("\n").length);
                }
                if (lineNumbers.length > 1) {
                  throw new Error(
                    `edit_file: oldString matched ${lineNumbers.length} times in '${args.path}' (lines ${lineNumbers.join(", ")}). Provide more context or set replaceAll: true.`,
                  );
                }
              }
            }
            const edits =
              args.edits && args.edits.length > 0
                ? args.edits
                : args.oldString !== undefined && args.newString !== undefined
                  ? [{ oldText: args.oldString, newText: args.newString }]
                  : [];
            return editBase.execute({ path: args.path, edits } as never, api as never, context);
          },
        }) as ToolRegistration,
      );
    }
  }

  return defineExtension({
    name: baseCoding.name,
    namespace: {
      name: "coding",
      description: "Read, write, edit files and run bash commands in the workspace",
    },
    tools: [...baseTools, ...aliasTools],
    sections: baseCoding.sections as Extension["sections"],
    hooks: baseCoding.hooks,
    wraps,
    tasks: baseCoding.tasks,
  });
}

// ---- 2. CamelFS Repo Extension (`list_files`, `grep_files`, `delete_file`, checkpoints, `view_image`, `render_image`) ----

export interface CamelRunRepoExtensionOptions {
  env: Env;
  tenantId: string;
  agentId: string;
  ensureRepo: () => Promise<{ repoId: string; lineage: string; branch: string }>;
  onFilesChanged?: (files: string[]) => void;
  onRepoCommit?: (repoId: string, commit: string) => void | Promise<void>;
  client?: CamelFsClient;
}

export function createCamelRunRepoExtension(options: CamelRunRepoExtensionOptions): Extension {
  const getCfs = () => options.client ?? new CamelFsClient(options.env, options.tenantId);

  const listFilesTool = defineTool({
    name: "list_files",
    description: "List files and directories in the repository.",
    parameters: obj(
      {
        path: opt(str({ description: "Subdirectory path prefix" })),
        recursive: opt(bool({ description: "Whether to list recursively (default true)" })),
        glob: opt(str({ description: "Optional glob filter" })),
        at: opt(str({ description: "Optional commit or ref" })),
      },
      { open: true },
    ),
    async execute(args) {
      const { lineage, branch } = await options.ensureRepo();
      const out = await getCfs().ls(lineage, {
        at: args.at || branch,
        path: args.path || "",
        recursive: args.recursive !== undefined ? args.recursive : true,
        glob: args.glob,
      });
      return textOutput(out);
    },
  });

  const grepFilesTool = defineTool({
    name: "grep_files",
    description: "Search repository files with a regular expression.",
    parameters: obj(
      {
        pattern: str({ description: "Regular expression pattern" }),
        pathPrefix: opt(str({ description: "Optional path prefix" })),
        maxMatches: opt(num({ description: "Maximum number of matches (default 100)" })),
        at: opt(str({ description: "Optional commit or ref" })),
      },
      { open: true },
    ),
    async execute(args) {
      const { lineage, branch } = await options.ensureRepo();
      const out = await getCfs().grep(lineage, {
        at: args.at || branch,
        pattern: args.pattern,
        pathPrefix: args.pathPrefix,
        maxMatches: args.maxMatches ?? 100,
      });
      return textOutput(out);
    },
  });

  const deleteFileTool = defineTool({
    name: "delete_file",
    description: "Delete a file from the repository.",
    parameters: obj(
      {
        path: str({ description: "Repository file path to delete" }),
        message: opt(str({ description: "Optional commit message" })),
      },
      { open: true },
    ),
    async execute(args) {
      const { repoId, lineage, branch } = await options.ensureRepo();
      const path = normalizeRepoPath(args.path);
      const out = await getCfs().write(lineage, {
        ref: branch,
        holder: options.agentId,
        author: `agent:${options.agentId}`,
        message: args.message ?? `delete ${path}`,
        deletes: [path],
      });
      options.onFilesChanged?.(out.changed);
      await options.onRepoCommit?.(repoId, out.commit);
      return textOutput(out);
    },
  });

  const checkpointTool = defineTool({
    name: "repo_checkpoint",
    description: "Create a named checkpoint ref pointing at the current branch head commit.",
    parameters: obj(
      {
        name: opt(str({ description: "Checkpoint name" })),
      },
      { open: true },
    ),
    async execute(args) {
      const { lineage, branch } = await options.ensureRepo();
      const cfs = getCfs();
      const refsRes = await cfs.listRefs(lineage, branch);
      const head = refsRes.refs.find((r) => r.name === branch) ?? refsRes.refs[0];
      if (!head) throw new Error(`Branch '${branch}' not found`);
      const tagName =
        args.name && args.name.trim()
          ? args.name.trim().replace(/^refs\/checkpoints\//, "")
          : `cp-${Date.now()}`;
      const checkpointRef = tagName.startsWith("refs/") ? tagName : `refs/checkpoints/${tagName}`;
      const out = await cfs.updateRef(lineage, {
        ref: checkpointRef,
        commit: head.commit,
        holder: options.agentId,
      });
      return textOutput(out);
    },
  });

  const restoreTool = defineTool({
    name: "repo_restore",
    description: "Restore the repository branch to a target commit.",
    parameters: obj(
      {
        targetCommit: str({ description: "Target commit hash to restore" }),
        expectedCommit: opt(str({ description: "Optional CAS expected current HEAD commit" })),
        message: opt(str({ description: "Optional restore commit message" })),
      },
      { open: true },
    ),
    async execute(args) {
      const { repoId, lineage, branch } = await options.ensureRepo();
      const out = await getCfs().restore(lineage, {
        ref: branch,
        targetCommit: args.targetCommit,
        ...(args.expectedCommit ? { expectedCommit: args.expectedCommit } : {}),
        holder: options.agentId,
        author: `agent:${options.agentId}`,
        message: args.message ?? "restore checkpoint",
      });
      await options.onRepoCommit?.(repoId, out.commit);
      return textOutput(out);
    },
  });

  const historyTool = defineTool({
    name: "repo_history",
    description: "List recent commits on the current repository branch.",
    parameters: obj(
      {
        limit: opt(num({ description: "Maximum number of commits to return (default 20)" })),
      },
      { open: true },
    ),
    async execute(args) {
      const { lineage, branch } = await options.ensureRepo();
      const out = await getCfs().history(lineage, {
        ref: branch,
        limit: args.limit ?? 20,
      });
      return textOutput(out);
    },
  });

  const diffTool = defineTool({
    name: "repo_diff",
    description:
      "Compute a unified diff between two commits or refs in the agent repository (defaults `to` to the current branch).",
    parameters: obj(
      {
        from: str({ description: "Base commit SHA or ref" }),
        to: opt(str({ description: "Target commit SHA or ref (default: current branch HEAD)" })),
        path: opt(str({ description: "Optional single file path filter" })),
        statOnly: opt(bool({ description: "Return file list and stats without patches" })),
        maxBytes: opt(num({ description: "Maximum total patch bytes (default 65536)" })),
        contextLines: opt(num({ description: "Unified diff context lines (default 3)" })),
      },
      { open: true },
    ),
    async execute(args) {
      const { lineage, branch } = await options.ensureRepo();
      const out = await computeRepoDiff(getCfs(), lineage, {
        from: args.from,
        to: args.to || branch,
        defaultRef: branch,
        path: args.path,
        statOnly: args.statOnly === true,
        maxBytes: args.maxBytes,
        contextLines: args.contextLines,
      });
      return textOutput(out);
    },
  });

  const viewImageTool = defineTool({
    name: "view_image",
    description: "Inspect a PNG, JPEG, GIF, or WebP in the repository as an image.",
    parameters: obj(
      {
        path: str({ description: "Relative file path in the repo" }),
        at: opt(str({ description: "Ref or commit of the file version to inspect" })),
      },
      { open: true },
    ),
    async execute(args) {
      const { lineage, branch } = await options.ensureRepo();
      const path = normalizeRepoPath(args.path);
      const maxBytes = Math.floor(FILE_LIMITS.requestImageBase64Bytes / 4) * 3;
      const file = await getCfs().read(lineage, {
        at: args.at || branch,
        path,
        limit: maxBytes + 1,
      });
      if (file.size > maxBytes) {
        throw new Error("Repository image exceeds the tool image byte budget");
      }
      const header = file.base64 ? imageHeader(Buffer.from(file.base64, "base64")) : null;
      if (!header || !file.base64) {
        throw new Error("Expected a PNG, JPEG, GIF, or WebP in the repository");
      }
      return {
        output: [
          {
            type: "text",
            text: `Repository image ${path} at commit ${file.commit}\n[image ${header.width}×${header.height}]`,
          },
          { type: "image", mimeType: header.mimeType, data: file.base64 },
        ],
      };
    },
  });

  const renderImageTool = defineTool({
    name: "render_image",
    description:
      "Render an SVG to PNG, save it in the repo, and view the result. Reference input images by name in SVG and map each name to its repo file.",
    parameters: obj(
      {
        svg: str({ description: "SVG markup to render" }),
        path: str({ description: "Repository path of the output PNG" }),
        files: opt(map(str(), { description: "Mapping of SVG image names to repo paths" })),
      },
      { open: true },
    ),
    async execute(args) {
      const path = normalizeRepoPath(args.path);
      if (!/\.png$/i.test(path)) throw new Error("Choose a .png output path");
      const { repoId, lineage, branch } = await options.ensureRepo();
      const cfs = getCfs();
      const entries = Object.entries(args.files ?? {});
      if (entries.length > SVG_RENDER_LIMITS.imageCount) {
        throw new Error("Too many SVG input images");
      }
      const files: Record<string, { data: string }> = Object.create(null);
      let remaining = SVG_RENDER_LIMITS.imageBase64Bytes;
      for (const [name, filePath] of entries) {
        const limit = Math.min(Math.floor(remaining / 4) * 3, SVG_RENDER_LIMITS.imageBytes);
        const file = await cfs.read(lineage, { at: branch, path: filePath, limit: limit + 1 });
        if (!file.base64 || file.size > limit) {
          throw new Error("SVG file exceeds the image byte budget or is empty");
        }
        let data = file.base64;
        const rawBytes = Buffer.from(data, "base64");
        const header = imageHeader(rawBytes);
        if (header && (header.mimeType === "image/webp" || header.mimeType === "image/gif")) {
          const converted = await normalizeSvgRasterInput(options.env, rawBytes);
          data = converted.bytes.toString("base64");
          if (data.length > remaining) {
            throw new Error("SVG file exceeds the image byte budget after PNG conversion");
          }
        }
        remaining -= data.length;
        files[name] = { data };
      }

      const startedAt = Date.now();
      const image = await renderSvg(options.env, args.svg, files);
      try {
        void recordSvgRenderUsage(
          getTenantStub(options.env, options.tenantId),
          Date.now() - startedAt,
          "tool:render_image",
        );
      } catch {
        // Optional in minimal unit harnesses without TENANT_DO
      }

      const out = await cfs.write(lineage, {
        ref: branch,
        holder: options.agentId,
        author: `agent:${options.agentId}`,
        message: `render ${path}`,
        puts: [{ path, base64: image.data, mode: 0o644 }],
      });
      options.onFilesChanged?.(out.changed);
      await options.onRepoCommit?.(repoId, out.commit);

      return {
        output: [
          { type: "text", text: `Rendered ${image.width}×${image.height} PNG to ${path}` },
          { type: "image", mimeType: image.contentType, data: image.data },
        ],
      };
    },
  });

  return defineExtension({
    name: "camelrun-repo",
    namespace: {
      name: "repo",
      description: "CamelFS repository inspection, checkpoints, history, and SVG rendering",
    },
    tools: [
      listFilesTool as ToolRegistration,
      grepFilesTool as ToolRegistration,
      deleteFileTool as ToolRegistration,
      checkpointTool as ToolRegistration,
      restoreTool as ToolRegistration,
      historyTool as ToolRegistration,
      diffTool as ToolRegistration,
      viewImageTool as ToolRegistration,
      renderImageTool as ToolRegistration,
    ],
  });
}

// ---- 3. CamelRun Skills Extension (`read_skill`, `search_skills` + `<skills>` prompt section) ----

export interface CamelRunSkillsExtensionOptions {
  env: Pick<Env, "MEDIA_BUCKET">;
  tenantId: string;
  skillSelectors?: readonly string[];
  getResolvedSkills?: () => Promise<SkillRecord[]>;
}

export function createCamelRunSkillsExtension(options: CamelRunSkillsExtensionOptions): Extension {
  const resolveSkills = async (): Promise<SkillRecord[]> => {
    if (options.getResolvedSkills) {
      return options.getResolvedSkills();
    }
    const selectors = options.skillSelectors ?? [];
    if (selectors.length === 0) return [];
    return getSkillStore(options.env).resolveSkills(options.tenantId, [...selectors]);
  };

  const readSkillTool = defineTool({
    name: "read_skill",
    description:
      "Read an attached skill's SKILL.md instructions or one of its reference files with optional 1-indexed start_line/end_line slicing.",
    parameters: obj(
      {
        name: str({ description: "Skill slug (e.g. 'camel-bots/sql-storage') or unique short name" }),
        file: opt(str({ description: "Optional reference file path. Defaults to SKILL.md." })),
        start_line: opt(num({ description: "Optional 1-indexed starting line number." })),
        end_line: opt(num({ description: "Optional 1-indexed ending line number (inclusive)." })),
      },
      { open: true },
    ),
    async execute(args) {
      const skills = await resolveSkills();
      const result = readSkillFile(skills, {
        name: args.name,
        file: args.file,
        start_line: args.start_line,
        end_line: args.end_line,
      });
      return textOutput(result);
    },
  });

  const searchSkillsTool = defineTool({
    name: "search_skills",
    description:
      "Search across attached skills' SKILL.md and reference files for APIs, types, symbols, or rules without loading entire files.",
    parameters: obj(
      {
        query: str({ description: "Keyword, symbol name, or phrase to search for." }),
        skill: opt(str({ description: "Optional skill slug, short name, or glob selector." })),
        max_results: opt(num({ description: "Maximum number of ranked snippets (default 12, max 30)." })),
      },
      { open: true },
    ),
    async execute(args) {
      const skills = await resolveSkills();
      const result = searchSkills(skills, {
        query: args.query,
        skill: args.skill,
        max_results: args.max_results,
      });
      return textOutput(result);
    },
  });

  const skillsSection = section(
    "skills",
    async () => {
      const skills = await resolveSkills();
      const block = buildSkillsPromptBlock(skills);
      return block || undefined;
    },
    { tag: false },
  );

  return defineExtension({
    name: "camelrun-skills",
    namespace: {
      name: "skills",
      description: "Read and search attached domain skills stored in R2",
    },
    tools: [readSkillTool as ToolRegistration, searchSkillsTool as ToolRegistration],
    sections: [skillsSection],
  });
}

// ---- 4. CamelRun Human Input & Approval Gate Extension (`HumanInputSignal`, `ask_human`, `requiresApproval`) ----

export const HumanInputSignalSchema = obj(
  {
    approved: opt(bool()),
    answer: opt(unknown()),
    action: opt(str()),
    content: opt(unknown()),
    actor: opt(str()),
    at: num(),
  },
  { open: true },
);

export const HumanInputSignal = defineSignal({
  name: "camelrun.human_input",
  version: 1,
  schema: HumanInputSignalSchema,
});

export interface HumanInputRequiredEvent {
  inputId: string;
  taskId: number;
  conversationId: number;
  toolCallId: string;
  toolName: string;
  kind: "approval" | "question";
  prompt: Record<string, unknown>;
  expiresAt: number;
  mcpInput?: Record<string, unknown>;
}

export interface CamelRunHumanExtensionOptions {
  /** Returns true when a tool requires explicit human approval before executing. */
  requiresApproval?: (toolName: string, call: ToolHookCall) => boolean;
  /** Default timeout in ms before a parked human input/approval expires (default 24h). */
  defaultTimeoutMs?: number;
  /** Called right before parking so AgentDO can persist the `inputs` row & broadcast `input_required`. */
  onInputRequired?: (event: HumanInputRequiredEvent) => void | Promise<void>;
  /** Called if a parked human input call is cancelled/aborted while parked. */
  onInputCancelled?: (inputId: string) => void | Promise<void>;
}

type AskHumanCheckpoint = {
  inputId: string;
  question: string;
};

export function createCamelRunHumanExtension(
  options?: CamelRunHumanExtensionOptions,
): Extension {
  const timeoutMs = options?.defaultTimeoutMs ?? 24 * 60 * 60 * 1000;

  const askHumanTool = defineTool<
    ReturnType<typeof askHumanSchema>,
    JsonValue,
    AskHumanCheckpoint
  >({
    name: "ask_human",
    description:
      "Pause the run and request clarification, input, or confirmation from a human.",
    parameters: askHumanSchema(),
    structuredOutputSchema: obj(
      {
        inputId: str(),
        answered: bool(),
        answer: opt(unknown()),
        approved: opt(bool()),
      },
      { open: true },
    ),
    async execute(args, api, context): Promise<ToolExecutionResult | ToolPark<AskHumanCheckpoint>> {
      if (!api.wake) {
        const inputId = await api.memo("ask_human.inputId", `inp_${randomId("h", 8)}`, context);
        const expiresAt = api.now() + timeoutMs;
        await options?.onInputRequired?.({
          inputId,
          taskId: api.taskId,
          conversationId: api.conversationId,
          toolCallId: api.callId,
          toolName: "ask_human",
          kind: "question",
          prompt: {
            question: args.question,
            ...(args.options ? { options: args.options } : {}),
            args,
          },
          expiresAt,
        });

        return {
          sleep: {
            checkpoint: { inputId, question: args.question },
            signals: [HumanInputSignal.key(inputId)],
            until: expiresAt,
          },
        };
      }

      const inputId = api.checkpoint?.inputId ?? (await api.memo("ask_human.inputId", context)) ?? "";
      const sig = inputId ? await api.readSignal(HumanInputSignal, inputId, context) : undefined;

      if (!sig || "expired" in sig || api.wake.reason === "expired") {
        return {
          isError: true,
          output: [{ type: "text", text: "Human input request expired before a response arrived." }],
          structuredOutput: { inputId, answered: false },
          diagnostics: [
            {
              severity: "error",
              code: "input_expired",
              message: "Human input request expired",
            },
          ],
        };
      }

      const val = sig.value;
      const answerVal = val.answer !== undefined ? val.answer : val.approved;
      const answerText =
        typeof answerVal === "string"
          ? answerVal
          : JSON.stringify(answerVal ?? { approved: val.approved });

      return {
        output: [{ type: "text", text: answerText }],
        structuredOutput: toJsonValue({
          inputId,
          answered: true,
          ...(val.answer !== undefined ? { answer: val.answer } : {}),
          ...(val.approved !== undefined ? { approved: val.approved } : {}),
        }),
      };
    },
    async cancel(_args, api) {
      if (api.checkpoint?.inputId) {
        await options?.onInputCancelled?.(api.checkpoint.inputId);
      }
    },
  });

  const approvalHook = hook(ToolTask, {
    async beforeTool(call, api, context) {
      if (!options?.requiresApproval?.(call.name, call)) {
        return undefined;
      }

      const inputId = await api.memo(
        `approval.inputId:${call.id}`,
        `inp_${randomId("a", 8)}`,
        context,
      );
      const sig = await api.readSignal(HumanInputSignal, inputId, context);

      if (sig) {
        if ("expired" in sig) {
          return { block: `Approval for tool '${call.name}' expired` };
        }
        const approved = sig.value.approved === true || sig.value.action === "accept";
        if (approved) {
          return undefined;
        }
        return { block: `Tool '${call.name}' was denied by human` };
      }

      const expiresAt = api.now() + timeoutMs;
      await options.onInputRequired?.({
        inputId,
        taskId: api.taskId,
        conversationId: api.conversationId,
        toolCallId: call.id,
        toolName: call.name,
        kind: "approval",
        prompt: {
          tool: call.name,
          args: call.arguments,
          message: `Approve execution of tool '${call.name}'?`,
        },
        expiresAt,
      });

      return {
        sleep: {
          signals: [HumanInputSignal.key(inputId)],
          until: expiresAt,
        },
      };
    },
  });

  return defineExtension({
    name: "camelrun-human",
    tools: [askHumanTool as unknown as ToolRegistration],
    hooks: [approvalHook],
  });
}

function askHumanSchema() {
  return obj(
    {
      question: str({ description: "Question or confirmation prompt to show the human" }),
      options: opt(arr(str(), { description: "Optional list of suggested choices" })),
    },
    { open: true },
  );
}

// ---- 5. CamelRun Billing & Spend-Limit Extension (`camelrun-billing`) ----

export class SpendLimitExceededError extends Error {
  readonly code = "run_spend_limit_exceeded";
  readonly spentUsd: number;
  readonly spendLimitUsd: number;

  constructor(spentUsd: number, spendLimitUsd: number) {
    super(
      `Run spend limit exceeded ($${spentUsd.toFixed(6)} >= $${spendLimitUsd.toFixed(6)})`,
    );
    this.name = "SpendLimitExceededError";
    this.spentUsd = spentUsd;
    this.spendLimitUsd = spendLimitUsd;
  }
}

export interface BillingUsageEvent {
  conversationId: number;
  taskId: number;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  stopReason: string;
}

export interface SpendLimitExceededEvent {
  conversationId: number;
  taskId: number;
  spentUsd: number;
  spendLimitUsd: number;
  code: "run_spend_limit_exceeded";
}

export interface CamelRunBillingExtensionOptions {
  /** Active run's spend cap in USD. Omit or return `undefined` / `<= 0` for unlimited. */
  getSpendLimitUsd?: () => number | undefined;
  /** Optional external cumulative spend (e.g. VM ms + prior steps); if omitted, reads `UsageDoc` total. */
  getSpentUsd?: () => number;
  /** Called when `beforeRequest` trips the spend limit. */
  onSpendLimitExceeded?: (event: SpendLimitExceededEvent) => void | Promise<void>;
  /**
   * Non-blocking abort trigger (e.g. `(taskId) => harness.abortTask(taskId)`).
   * Called fire-and-forget when spend limit is exceeded so `runtime.signal` aborts
   * cleanly and prevents `GenerationTask` from issuing another provider request.
   */
  abortTask?: (taskId: number) => Promise<unknown> | void;
  /** Called in `afterResponse` for every terminal provider response. */
  onUsageRecorded?: (event: BillingUsageEvent) => void | Promise<void>;
}

async function computeTotalSpentUsd(
  options: CamelRunBillingExtensionOptions,
  api: HookApi,
  context: Context,
): Promise<number> {
  if (options.getSpentUsd) {
    return options.getSpentUsd();
  }
  const usage = await api.snapshot(UsageDoc, api.conversationId, context);
  let total = 0;
  for (const modelUsage of Object.values(usage?.models ?? {})) {
    total += modelUsage?.cost?.total ?? 0;
  }
  for (const toolUsage of Object.values(usage?.tools ?? {})) {
    total += toolUsage?.cost?.total ?? 0;
  }
  return total;
}

function waitForAbort(signal: AbortSignal | undefined, maxMs = 250): Promise<void> {
  if (!signal || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, maxMs);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function createCamelRunBillingExtension(
  options: CamelRunBillingExtensionOptions,
): Extension {
  const checkSpendExceeded = async (
    api: Parameters<NonNullable<import("@earendil-works/pi-durable").GenerationHooks["beforeRequest"]>>[1],
    context: Context,
  ): Promise<{ exceeded: boolean; spentUsd: number; spendLimitUsd: number }> => {
    const spendLimitUsd = options.getSpendLimitUsd?.();
    if (spendLimitUsd === undefined || !Number.isFinite(spendLimitUsd) || spendLimitUsd < 0) {
      return { exceeded: false, spentUsd: 0, spendLimitUsd: Number.POSITIVE_INFINITY };
    }
    const spentUsd = await computeTotalSpentUsd(options, api, context);
    return { exceeded: spentUsd >= spendLimitUsd, spentUsd, spendLimitUsd };
  };

  return defineExtension({
    name: "camelrun-billing",
    hooks: [
      hook(GenerationTask, {
        async beforeRequest(_request, api, context) {
          const check = await checkSpendExceeded(api, context);
          if (!check.exceeded) return undefined;

          await options.onSpendLimitExceeded?.({
            conversationId: api.conversationId,
            taskId: api.taskId,
            spentUsd: check.spentUsd,
            spendLimitUsd: check.spendLimitUsd,
            code: "run_spend_limit_exceeded",
          });

          if (options.abortTask) {
            // Fire-and-forget to avoid deadlocking `abortTask()` joining this invocation;
            // wait briefly for the Session commit to flip `context.abortSignal` before throwing.
            void Promise.resolve(options.abortTask(api.taskId)).catch(() => {});
            await waitForAbort(context.abortSignal, 250);
          }

          throw new SpendLimitExceededError(check.spentUsd, check.spendLimitUsd);
        },
        async afterResponse(message, api) {
          // pi-ai reports `usage.input` as UNCACHED input tokens, while CamelRun v2's usage &
          // pricing schema defines `inputTokens` as TOTAL input tokens (inclusive of cache tokens).
          const uncachedInputTokens = message.usage?.input ?? 0;
          const outputTokens = message.usage?.output ?? 0;
          const cacheReadTokens = message.usage?.cacheRead ?? 0;
          const cacheWriteTokens = message.usage?.cacheWrite ?? 0;
          const inputTokens = uncachedInputTokens + cacheReadTokens + cacheWriteTokens;
          const reportedCost = message.usage?.cost?.total ?? 0;
          const qualifiedModel = `${message.provider}/${message.model}`;
          const costUsd =
            lookupCatalogModel(qualifiedModel) || reportedCost <= 0
              ? calculatePiCostUsd(qualifiedModel, inputTokens, outputTokens, 0, cacheReadTokens)
              : reportedCost;

          await options.onUsageRecorded?.({
            conversationId: api.conversationId,
            taskId: api.taskId,
            provider: message.provider,
            model: message.model,
            inputTokens,
            outputTokens,
            cacheReadTokens,
            costUsd,
            stopReason: message.stopReason,
          });
        },
      }),
      hook(CompactionTask, {
        async beforeCompact(_compaction, api, context) {
          const check = await checkSpendExceeded(api, context);
          if (check.exceeded) {
            return { decline: true };
          }
          return undefined;
        },
      }),
    ],
  });
}

// ---- 6. CamelRun MCP Extension (`@earendil-works/pi-mcp` + signed-runtime elicitation via ToolPark) ----

export interface CamelRunMcpExtensionOptions {
  env: Env;
  agent: AgentConfig;
  getRunId?: () => string;
  getActor?: () => string | undefined;
  defaultInputTimeoutMs?: number;
  onInputRequired?: (event: HumanInputRequiredEvent) => void | Promise<void>;
  fetch?: typeof globalThis.fetch;
  /** Default `deferred` flag for MCP tools (when `tool_search` builtin is enabled). */
  deferByDefault?: boolean;
}

type SignedMcpCheckpoint = {
  inputId: string;
  mode: "approval" | "form" | "url";
  key?: string;
  sealedState?: string;
};

function formatMcpCallResult(res: unknown): ToolExecutionResult {
  if (res && typeof res === "object" && Array.isArray((res as { content?: unknown }).content)) {
    const blocks = (res as { content: Array<Record<string, unknown>> }).content;
    const hasImages = blocks.some(
      (b) => b && b.type === "image" && typeof b.data === "string" && typeof b.mimeType === "string",
    );
    if (hasImages) {
      const output: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];
      const textParts: string[] = [];
      const imageDims: string[] = [];
      for (const b of blocks) {
        if (b.type === "text" && typeof b.text === "string" && b.text) {
          textParts.push(b.text);
        } else if (b.type === "image" && typeof b.data === "string" && typeof b.mimeType === "string") {
          const hdr = imageHeader(Buffer.from(b.data, "base64"));
          if (hdr) imageDims.push(`[image ${hdr.width}×${hdr.height}]`);
        }
      }
      const headerText = [...textParts, ...imageDims].join("\n").trim();
      if (headerText) output.push({ type: "text", text: headerText });
      for (const b of blocks) {
        if (b.type === "image" && typeof b.data === "string" && typeof b.mimeType === "string") {
          output.push({ type: "image", mimeType: b.mimeType, data: b.data });
        }
      }
      return { output };
    }
  }
  return textOutput(res);
}

async function discoverStandardMcpTools(
  server: McpServerSpec,
  options: CamelRunMcpExtensionOptions,
  signal?: AbortSignal,
): Promise<ToolRegistration[]> {
  const fetchImpl = options.fetch;
  const client = new McpClient({ name: "camelrun-v2", version: "2.0.0" });
  const transport = new StreamableHttpTransport({
    url: server.url,
    headers: server.headers,
    openGetStream: false,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });

  try {
    await client.connect(transport);
    const listed = await client.listTools({ signal });
    const tools: ToolRegistration[] = [];

    for (const remoteTool of listed) {
      if (server.allowTools && !server.allowTools.includes(remoteTool.name)) continue;
      const qualifiedName = `${server.name}__${remoteTool.name}`;
      const parameters = normalizeMcpInputSchema(remoteTool.inputSchema) as unknown as JsonObject;
      const remoteName = remoteTool.name;

      const deferred = server.deferred ?? options.deferByDefault ?? false;
      tools.push(
        defineTool({
          name: qualifiedName,
          description: remoteTool.description || `MCP tool ${remoteName} from ${server.name}`,
          parameters,
          ...(deferred ? { deferred: true as const } : {}),
          async execute(args, _api, context) {
            const callClient = new McpClient({ name: "camelrun-v2", version: "2.0.0" });
            const callTransport = new StreamableHttpTransport({
              url: server.url,
              headers: server.headers,
              openGetStream: false,
              ...(fetchImpl ? { fetch: fetchImpl } : {}),
            });
            try {
              await callClient.connect(callTransport);
              const result = await callClient.callTool(
                remoteName,
                (args ?? {}) as Record<string, unknown>,
                { signal: context.abortSignal },
              );
              const llmContent = toLlmContent(result);
              const imageDims: string[] = [];
              for (const block of llmContent) {
                if (block.type === "image" && typeof block.data === "string") {
                  const hdr = imageHeader(Buffer.from(block.data, "base64"));
                  if (hdr) imageDims.push(`[image ${hdr.width}×${hdr.height}]`);
                }
              }
              if (imageDims.length > 0) {
                const firstTextIdx = llmContent.findIndex((b) => b.type === "text");
                if (firstTextIdx >= 0) {
                  const prev = llmContent[firstTextIdx] as { type: "text"; text: string };
                  llmContent[firstTextIdx] = {
                    type: "text",
                    text: `${prev.text}\n${imageDims.join("\n")}`,
                  };
                } else {
                  llmContent.unshift({ type: "text", text: imageDims.join("\n") });
                }
              }
              return {
                output: llmContent,
                ...(result.isError ? { isError: true } : {}),
              };
            } finally {
              await callClient.close().catch(() => {});
            }
          },
        }) as unknown as ToolRegistration,
      );
    }

    return tools;
  } catch {
    // Fallback to stateless JSON-RPC discovery/invocation for lightweight HTTP MCP servers
    try {
      const discovered = await discoverMcpTools(
        options.env,
        { ...options.agent, mcpServers: [server] },
        signal,
      );
      const deferred = server.deferred ?? options.deferByDefault ?? false;
      return discovered.map((d) =>
        defineTool({
          name: d.qualifiedName,
          description: d.schema.description,
          parameters: d.schema.parameters as unknown as JsonObject,
          ...(deferred ? { deferred: true as const } : {}),
          async execute(args, api, context) {
            const runId = options.getRunId?.() ?? `run_${api.conversationId}`;
            const actor = options.getActor?.();
            const res = await invokeMcpTool(
              d,
              (args ?? {}) as Record<string, unknown>,
              {
                env: options.env,
                agent: options.agent,
                call: { runId, callId: api.callId, actor },
              },
              context.abortSignal,
            );
            return formatMcpCallResult(res);
          },
        }) as unknown as ToolRegistration,
      );
    } catch {
      return [];
    }
  } finally {
    await client.close().catch(() => {});
  }
}

function buildSignedRuntimeMcpTool(
  discovered: DiscoveredMcpTool,
  options: CamelRunMcpExtensionOptions,
): ToolRegistration {
  const timeoutMs = options.defaultInputTimeoutMs ?? 24 * 60 * 60 * 1000;
  const deferred = discovered.server.deferred ?? options.deferByDefault ?? false;

  return defineTool<Record<string, unknown>, JsonValue, SignedMcpCheckpoint>({
    name: discovered.qualifiedName,
    description: discovered.schema.description,
    parameters: discovered.schema.parameters,
    ...(deferred ? { deferred: true as const } : {}),
    async execute(
      args,
      api: ToolExecutionApi<JsonValue, SignedMcpCheckpoint>,
      context: Context,
    ): Promise<ToolExecutionResult | ToolPark<SignedMcpCheckpoint>> {
      const runId = options.getRunId?.() ?? `run_${api.conversationId}`;
      const actor = options.getActor?.();

      let approval: ToolApproval | undefined;
      let mcpInput: McpInputResponse | undefined;

      if (api.wake && api.checkpoint) {
        const sig = await api.readSignal(HumanInputSignal, api.checkpoint.inputId, context);
        if (!sig || "expired" in sig || api.wake.reason === "expired") {
          return {
            isError: true,
            output: [
              {
                type: "text",
                text: `MCP input request for '${discovered.qualifiedName}' expired.`,
              },
            ],
            diagnostics: [
              {
                severity: "error",
                code: "input_expired",
                message: "MCP human input expired",
              },
            ],
          };
        }

        const val = sig.value;
        if (api.checkpoint.mode === "approval") {
          if (val.approved !== true && val.action !== "accept") {
            return {
              isError: true,
              output: [{ type: "text", text: `MCP tool '${discovered.qualifiedName}' denied.` }],
              diagnostics: [
                { severity: "error", code: "denied", message: "Approval denied by human" },
              ],
            };
          }
          approval = {
            input: api.checkpoint.inputId,
            by: { id: val.actor ?? actor ?? options.agent.id },
            at: val.at,
          };
        } else {
          const requestState = api.checkpoint.sealedState
            ? await openSecret(api.checkpoint.sealedState, options.env.VAULT_SECRET)
            : undefined;
          const action: "accept" | "decline" =
            val.action === "decline" || val.approved === false ? "decline" : "accept";
          mcpInput = {
            key: api.checkpoint.key!,
            ...(requestState !== undefined ? { requestState } : {}),
            response: {
              action,
              ...(val.content !== undefined
                ? { content: val.content }
                : val.answer !== undefined
                  ? { content: val.answer }
                  : {}),
            },
          };
        }
      }

      try {
        const res = await invokeMcpTool(
          discovered,
          (args ?? {}) as Record<string, unknown>,
          {
            env: options.env,
            agent: options.agent,
            call: { runId, callId: api.callId, actor, approval },
          },
          context.abortSignal,
          mcpInput,
        );
        return formatMcpCallResult(res);
      } catch (error) {
        if (!(error instanceof McpInputRequired)) throw error;

        const inputId = `inp_${randomId("mcp", 8)}`;
        const expiresAt = api.now() + timeoutMs;

        if (error.input.method === "agent-runtime/approval") {
          if (approval) {
            throw new Error(`MCP tool '${discovered.qualifiedName}' requested approval again`);
          }
          await options.onInputRequired?.({
            inputId,
            taskId: api.taskId,
            conversationId: api.conversationId,
            toolCallId: api.callId,
            toolName: discovered.qualifiedName,
            kind: "approval",
            prompt: {
              tool: discovered.qualifiedName,
              args,
              message: `Approve execution of tool '${discovered.qualifiedName}'?`,
            },
            expiresAt,
            mcpInput: { mode: "approval", url: discovered.server.url },
          });
          return {
            sleep: {
              checkpoint: { inputId, mode: "approval" },
              signals: [HumanInputSignal.key(inputId)],
              until: expiresAt,
            },
          };
        }

        const sealedState =
          error.requestState === undefined
            ? undefined
            : await sealSecret(error.requestState, options.env.VAULT_SECRET);
        const elicitation = error.input.params;
        await options.onInputRequired?.({
          inputId,
          taskId: api.taskId,
          conversationId: api.conversationId,
          toolCallId: api.callId,
          toolName: discovered.qualifiedName,
          kind: "question",
          prompt: {
            tool: discovered.qualifiedName,
            question: elicitation.message,
            elicitation,
          },
          expiresAt,
          mcpInput: {
            mode: elicitation.mode,
            key: error.key,
            url: discovered.server.url,
          },
        });
        return {
          sleep: {
            checkpoint: {
              inputId,
              mode: elicitation.mode,
              key: error.key,
              ...(sealedState !== undefined ? { sealedState } : {}),
            },
            signals: [HumanInputSignal.key(inputId)],
            until: expiresAt,
          },
        };
      }
    },
  }) as unknown as ToolRegistration;
}

/**
 * Discovers MCP tools across both generic Streamable HTTP MCP servers (via `@earendil-works/pi-mcp`)
 * and CamelRun signed-runtime MCP servers (`auth: { type: "runtime" }`, bridged onto `ToolPark` + `HumanInputSignal`).
 */
export async function createCamelRunMcpExtension(
  options: CamelRunMcpExtensionOptions,
  signal?: AbortSignal,
): Promise<Extension> {
  const servers = options.agent.mcpServers ?? [];
  const genericServers = servers.filter((s) => s.auth?.type !== "runtime");
  const signedServers = servers.filter((s) => s.auth?.type === "runtime");

  const [genericToolLists, signedDiscovered] = await Promise.all([
    Promise.all(
      genericServers.map((server) => discoverStandardMcpTools(server, options, signal)),
    ),
    signedServers.length > 0
      ? discoverMcpTools(options.env, { ...options.agent, mcpServers: signedServers }, signal)
      : Promise.resolve([]),
  ]);

  const tools: ToolRegistration[] = [
    ...genericToolLists.flat(),
    ...signedDiscovered.map((d) => buildSignedRuntimeMcpTool(d, options)),
  ];

  return defineExtension({
    name: "camelrun-mcp",
    namespace: {
      name: "mcp",
      description: "Remote Model Context Protocol (MCP) tools",
    },
    tools,
  });
}

// ---- 7. CamelRun Browser Extension (wraps `browser.ts` 10 discrete `browser_*` tools) ----

export interface CamelRunBrowserExtensionOptions {
  env: Env;
  tenantId: string;
  agentId: string;
  ensureRepo: () => Promise<{ repoId: string; lineage: string; branch: string }>;
  onFilesChanged?: (files: string[]) => void;
  onRepoCommit?: (repoId: string, commit: string) => void | Promise<void>;
}

export function createCamelRunBrowserExtension(
  options: CamelRunBrowserExtensionOptions,
): Extension {
  const tools: ToolRegistration[] = BROWSER_TOOL_SCHEMAS.map((schema) =>
    defineTool({
      name: schema.name,
      description: schema.description,
      parameters: schema.parameters,
      async execute(args, _api, context) {
        const result = await executeBrowserTool(
          options.env,
          schema.name as Parameters<typeof executeBrowserTool>[1],
          (args ?? {}) as Record<string, unknown>,
          {
            signal: context.abortSignal,
            saveScreenshot: async ({ path: rawPath, contentType, base64, url }) => {
              const path = normalizeRepoPath(rawPath);
              assertScreenshotPathExtension(path, contentType);
              const { repoId, lineage, branch } = await options.ensureRepo();
              const cfs = new CamelFsClient(options.env, options.tenantId);
              const out = await cfs.write(lineage, {
                ref: branch,
                holder: options.agentId,
                author: `agent:${options.agentId}`,
                message: `browser screenshot ${url.slice(0, 80)} -> ${path}`,
                puts: [{ path, base64, mode: 0o644 }],
              });
              options.onFilesChanged?.(out.changed);
              await options.onRepoCommit?.(repoId, out.commit);
              return path;
            },
          },
        );
        return textOutput(result);
      },
    }) as unknown as ToolRegistration,
  );

  return defineExtension({
    name: "camelrun-browser",
    namespace: {
      name: "browser",
      description: "Cloudflare Browser Run navigation, extraction, markdown, and screenshots",
    },
    tools,
  });
}

// ---- 8. CamelRun Delegate Extension (`delegate`, `spawn_agent`, `send_message`, `wait_agent`) ----

export interface CamelRunDelegateExtensionOptions {
  env: Env;
  config: AgentConfig;
  getRunId?: () => string;
  recordChildAgent?: (entry: {
    id: string;
    childAgentId: string;
    childAgentKey: string;
    parentRunId: string;
    status: string;
    result: unknown;
  }) => void;
  getChildAgent?: (idOrAgentId: string) => {
    id: string;
    childAgentId: string;
    childAgentKey: string;
    status: string;
    result: unknown;
  } | null;
  /** Optional custom handler for tests or specialized delegation routing. */
  onDelegate?: (args: {
    synchronous: boolean;
    prompt: string;
    definition?: string;
    key?: string;
    model?: string;
    instructions?: string;
    forkRepo?: boolean;
  }) => Promise<unknown>;
}

async function upsertChildAgent(
  env: Env,
  tenantId: string,
  key: string,
  opts: {
    model: string;
    instructions: string;
    builtins: BuiltinSuite[];
    skills?: string[];
    compactThresholdTokens?: number;
    tools?: AgentUpsertInput["tools"];
    mcpServers?: AgentUpsertInput["mcpServers"];
    definitionSlug?: string | null;
    repoId: string | null;
    lineage: string | null;
    branch: string;
  },
): Promise<{ id: string; key: string }> {
  const tenantStub = getTenantStub(env, tenantId);
  const existing = await tenantStub.resolveAgent(key);
  const id = existing?.id ?? randomId("agt", 8);

  if (!existing) {
    const { token, tokenHash } = await mintAgentToken(tenantId, id);
    const sealedToken = await sealSecret(token, env.VAULT_SECRET);
    await tenantStub.upsertAgentIndex({
      id,
      key,
      tokenHash,
      sealedToken,
      model: opts.model,
      repoId: opts.repoId,
      branch: opts.branch,
      definitionSlug: opts.definitionSlug ?? null,
    });
  }

  await getAgentStub(env, id).initAgent({
    id,
    tenantId,
    key,
    model: opts.model,
    instructions: opts.instructions,
    definition: opts.definitionSlug ?? undefined,
    builtins: opts.builtins,
    skills: opts.skills,
    compactThresholdTokens: opts.compactThresholdTokens,
    tools: opts.tools,
    mcpServers: opts.mcpServers,
    repoId: opts.repoId,
    lineage: opts.lineage,
    branch: opts.branch,
  });

  return { id, key };
}

export function createCamelRunDelegateExtension(
  options: CamelRunDelegateExtensionOptions,
): Extension {
  const delegateParams = obj(
    {
      prompt: str({ description: "Task prompt for the child agent" }),
      definition: opt(str({ description: "Optional named agent definition slug" })),
      key: opt(str({ description: "Optional child agent key" })),
      model: opt(str({ description: "Optional model override" })),
      instructions: opt(str({ description: "Optional system instructions override" })),
      forkRepo: opt(bool({ description: "Whether to fork the parent repository" })),
    },
    { open: true },
  );

  const runDelegation = async (
    synchronous: boolean,
    args: {
      prompt: string;
      definition?: string;
      key?: string;
      model?: string;
      instructions?: string;
      forkRepo?: boolean;
    },
  ) => {
    if (options.onDelegate) {
      return options.onDelegate({ synchronous, ...args });
    }

    const { env, config } = options;
    const tenantStub = getTenantStub(env, config.tenantId);
    const defSlug = args.definition?.trim() || undefined;
    const defEntry = defSlug ? await tenantStub.getDefinition(defSlug) : null;
    const defCfg = defEntry?.config;
    const childKey = args.key?.trim() || `${config.key}__sub_${randomId("c", 4)}`;
    const model = args.model ?? defCfg?.model ?? config.model;
    const instructions = args.instructions ?? defCfg?.instructions ?? config.instructions;
    const childBuiltins = (defCfg?.builtins ?? config.builtins).filter((b) => b !== "delegate");

    let childRepoId = config.repoId;
    let childLineage = config.lineage;
    let childBranch = config.branch;

    if (args.forkRepo && config.lineage) {
      const cfs = new CamelFsClient(env, config.tenantId);
      const forked = await cfs.forkLineage(config.lineage, { sourceRef: config.branch });
      const repoRec = await tenantStub.createRepo({
        name: `${childKey}-fork`,
        existingLineage: forked.lineage,
        defaultRef: forked.ref,
        commit: forked.commit,
      });
      childRepoId = repoRec.repoId;
      childLineage = repoRec.lineage;
      childBranch = repoRec.defaultRef;
    }

    const childAgent = await upsertChildAgent(env, config.tenantId, childKey, {
      model,
      instructions,
      builtins: childBuiltins,
      skills: defCfg?.skills ?? config.skills,
      compactThresholdTokens: defCfg?.compactThresholdTokens ?? config.compactThresholdTokens,
      tools: defCfg?.tools,
      mcpServers: defCfg?.mcpServers,
      definitionSlug: defEntry?.slug ?? null,
      repoId: childRepoId,
      lineage: childLineage,
      branch: childBranch,
    });

    const runRecord = await getAgentStub(env, childAgent.id).startRun({
      prompt: args.prompt,
      wait: synchronous,
    });
    const handleId = randomId("sub", 6);
    const parentRunId = options.getRunId?.() ?? "";

    options.recordChildAgent?.({
      id: handleId,
      childAgentId: childAgent.id,
      childAgentKey: childKey,
      parentRunId,
      status: runRecord.status === "completed" ? "completed" : synchronous ? "failed" : "running",
      result: runRecord,
    });

    if (synchronous) {
      return {
        id: handleId,
        childAgentId: childAgent.id,
        childKey,
        runId: runRecord.id,
        status: runRecord.status,
        text: runRecord.text,
        output: runRecord.output,
        filesChanged: runRecord.filesChanged,
      };
    }

    return {
      id: handleId,
      childAgentId: childAgent.id,
      childKey,
      runId: runRecord.id,
      status: runRecord.status,
    };
  };

  const delegateTool = defineTool({
    name: "delegate",
    description:
      "Synchronously delegate a task to a child agent (optionally from a named definition or on a forked repo) and return its result.",
    parameters: delegateParams,
    async execute(args) {
      return textOutput(await runDelegation(true, args));
    },
  });

  const spawnAgentTool = defineTool({
    name: "spawn_agent",
    description:
      "Start an asynchronous child agent run (optionally from a named definition) and return its handle.",
    parameters: delegateParams,
    async execute(args) {
      return textOutput(await runDelegation(false, args));
    },
  });

  const sendMessageTool = defineTool({
    name: "send_message",
    description: "Send a follow-up prompt or mid-turn steer message to a child agent.",
    parameters: obj(
      {
        childId: str({ description: "Child handle ID or child agent ID" }),
        prompt: str({ description: "Message prompt to send" }),
        whileRunning: opt(str({ description: "'queue' or 'steer'" })),
        wait: opt(bool({ description: "Wait for completion" })),
      },
      { open: true },
    ),
    async execute(args) {
      const child = options.getChildAgent?.(args.childId);
      const agentId = child?.childAgentId ?? args.childId;
      const out = await getAgentStub(options.env, agentId).startRun({
        prompt: args.prompt,
        whileRunning: args.whileRunning === "steer" ? "steer" : "queue",
        wait: Boolean(args.wait ?? false),
      });
      return textOutput(out);
    },
  });

  const waitAgentTool = defineTool({
    name: "wait_agent",
    description: "Wait for an asynchronous child agent run to finish and return its output.",
    parameters: obj(
      {
        childId: str({ description: "Child handle ID or child agent ID" }),
        runId: opt(str({ description: "Optional specific run ID to wait for" })),
      },
      { open: true },
    ),
    async execute(args) {
      const child = options.getChildAgent?.(args.childId);
      const agentId = child?.childAgentId ?? args.childId;
      const prevRun = child?.result as { id?: string } | undefined;
      const runId = args.runId ?? prevRun?.id;
      const stub = getAgentStub(options.env, agentId);
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const rec = runId ? await stub.getRun(runId) : (await stub.getState()).lastRun;
        if (
          rec &&
          (rec.status === "completed" ||
            rec.status === "failed" ||
            rec.status === "cancelled" ||
            rec.status === "input_required")
        ) {
          if (child) {
            options.recordChildAgent?.({
              id: child.id,
              childAgentId: child.childAgentId,
              childAgentKey: child.childAgentKey,
              parentRunId: options.getRunId?.() ?? "",
              status: rec.status === "completed" ? "completed" : "failed",
              result: rec,
            });
          }
          return textOutput(rec);
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(`Timed out waiting for child agent '${args.childId}'`);
    },
  });

  return defineExtension({
    name: "camelrun-delegate",
    namespace: {
      name: "delegate",
      description: "Delegate tasks synchronously or asynchronously to child agents",
    },
    tools: [
      delegateTool as ToolRegistration,
      spawnAgentTool as ToolRegistration,
      sendMessageTool as ToolRegistration,
      waitAgentTool as ToolRegistration,
    ],
  });
}
