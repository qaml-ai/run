import { sha256Hex } from "./crypto.ts";
import { ApiError } from "./types.ts";

export const SKILL_SLUG_REGEX = /^[a-z0-9][a-z0-9/_-]{0,127}$/;
export const SKILL_MAX_BYTES = 512 * 1024; // 512 KiB total per skill
export const SKILL_MAX_FILES = 50;
export const SKILL_READ_MAX_LINES = 400;
export const SKILL_READ_MAX_BYTES = 24 * 1024; // 24 KiB
export const SKILL_SEARCH_MAX_BYTES = 12 * 1024; // 12 KiB
export const SKILL_SEARCH_DEFAULT_RESULTS = 12;
export const SKILL_SEARCH_MAX_RESULTS = 30;

const FILE_PATH_SEGMENT_REGEX = /^[A-Za-z0-9._-]+$/;
const encoder = new TextEncoder();

export interface SkillUpsertInput {
  name?: string;
  description?: string;
  tags?: string[];
  markdown: string;
  files?: Record<string, string>;
}

export interface SkillSummary {
  slug: string;
  name: string;
  description: string;
  tags: string[];
  version: number;
  contentHash: string;
  files: string[];
  createdAt: number;
  updatedAt: number;
}

export interface SkillRecord {
  slug: string;
  name: string;
  description: string;
  tags: string[];
  version: number;
  contentHash: string;
  markdown: string;
  files: Record<string, string>;
  createdAt: number;
  updatedAt: number;
}

export interface ParsedFrontmatter {
  name?: string;
  description?: string;
  tags?: string[];
  body: string;
}

export interface ReadSkillResult {
  skill: string;
  name: string;
  file: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  truncated: boolean;
  nextStartLine?: number;
  hint?: string;
  availableFiles: string[];
  content: string;
}

export interface SkillSearchMatch {
  skill: string;
  file: string;
  line: number;
  snippet: string;
}

export interface SearchSkillsResult {
  query: string;
  totalMatches: number;
  truncated: boolean;
  results: SkillSearchMatch[];
}

export function utf8ByteLength(text: string): number {
  return encoder.encode(text).byteLength;
}

export function compareSlug(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Validates a tenant skill slug:
 * `^[a-z0-9][a-z0-9/_-]{0,127}$`, no `..`, no leading/trailing `/`, no `//`.
 */
export function validateSkillSlug(raw: string): string {
  if (typeof raw !== "string") {
    throw new ApiError(400, "invalid_skill_slug", "Skill slug must be a string");
  }
  const slug = raw.trim();
  if (
    !slug ||
    !SKILL_SLUG_REGEX.test(slug) ||
    slug.startsWith("/") ||
    slug.endsWith("/") ||
    slug.includes("//") ||
    slug.includes("..")
  ) {
    throw new ApiError(
      400,
      "invalid_skill_slug",
      `Invalid skill slug '${raw}'. Expected lowercase alphanumeric segments separated by '/', '-' or '_' (max 128 chars, no '..' or leading/trailing '/').`,
    );
  }
  return slug;
}

/**
 * Validates a relative reference file path inside a skill (e.g. `references/sdk.d.ts`).
 */
export function validateSkillFilePath(raw: string): string {
  if (typeof raw !== "string") {
    throw new ApiError(400, "invalid_skill_file", "Skill file path must be a string");
  }
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 256 || trimmed.startsWith("/") || trimmed.endsWith("/") || trimmed.includes("\\")) {
    throw new ApiError(400, "invalid_skill_file", `Invalid skill file path '${raw}'`);
  }
  const segments = trimmed.split("/");
  for (const seg of segments) {
    if (!seg || seg === "." || seg === ".." || !FILE_PATH_SEGMENT_REGEX.test(seg)) {
      throw new ApiError(400, "invalid_skill_file", `Invalid skill file path '${raw}'`);
    }
  }
  if (trimmed.toLowerCase() === "skill.md") {
    throw new ApiError(
      400,
      "invalid_skill_file",
      "SKILL.md must be provided in `markdown`, not in `files`",
    );
  }
  return trimmed;
}

export function normalizeSkillSelectors(selectors: unknown): string[] {
  if (!Array.isArray(selectors)) {
    throw new ApiError(400, "invalid_skills", "`skills` must be an array of skill slugs or globs");
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of selectors) {
    if (typeof item !== "string") {
      throw new ApiError(400, "invalid_skills", "Each entry in `skills` must be a non-empty string");
    }
    const s = item.trim();
    if (!s || s.length > 130 || s.includes("..")) {
      throw new ApiError(400, "invalid_skills", `Invalid skill selector '${item}'`);
    }
    if (!seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

function unquoteYamlScalar(raw: string): string {
  const s = raw.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    try {
      return JSON.parse(s) as string;
    } catch {
      return s.slice(1, -1);
    }
  }
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  return s;
}

function parseYamlInlineList(raw: string): string[] {
  const inner = raw.slice(1, -1).trim();
  if (!inner) return [];
  const items: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    if (quote) {
      if (ch === quote && inner[i - 1] !== "\\") {
        quote = null;
      }
      cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === ",") {
      const cleaned = unquoteYamlScalar(cur);
      if (cleaned) items.push(cleaned);
      cur = "";
    } else {
      cur += ch;
    }
  }
  const last = unquoteYamlScalar(cur);
  if (last) items.push(last);
  return items;
}

/**
 * Lightweight YAML frontmatter parser for `SKILL.md` supporting `name`, `description`, and `tags`
 * (including inline arrays, block lists, and folded/literal multiline scalars).
 */
export function parseSkillFrontmatter(markdown: string): ParsedFrontmatter {
  const text = markdown.startsWith("\uFEFF") ? markdown.slice(1) : markdown;
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) {
    return { body: text };
  }

  const yamlBlock = match[1]!;
  const body = text.slice(match[0].length);
  const lines = yamlBlock.split(/\r?\n/);

  let name: string | undefined;
  let description: string | undefined;
  let tags: string[] | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const kv = /^([A-Za-z0-9_-]+)[ \t]*:[ \t]*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1]!.toLowerCase();
    const rawVal = kv[2]!.trim();

    if (key === "name" || key === "description") {
      let value: string;
      if (rawVal === "|" || rawVal === "|-" || rawVal === ">" || rawVal === ">-") {
        const blockLines: string[] = [];
        let baseIndent: number | null = null;
        while (i + 1 < lines.length) {
          const next = lines[i + 1]!;
          if (!next.trim()) {
            blockLines.push("");
            i++;
            continue;
          }
          const indent = next.length - next.trimStart().length;
          if (indent === 0) break;
          if (baseIndent === null) baseIndent = indent;
          blockLines.push(next.slice(Math.min(indent, baseIndent)));
          i++;
        }
        value = rawVal.startsWith(">")
          ? blockLines.join(" ").replace(/\s+/g, " ").trim()
          : blockLines.join("\n").trim();
      } else {
        value = unquoteYamlScalar(rawVal);
      }
      if (value) {
        if (key === "name") name = value;
        if (key === "description") description = value;
      }
    } else if (key === "tags") {
      if (rawVal.startsWith("[") && rawVal.endsWith("]")) {
        tags = parseYamlInlineList(rawVal);
      } else if (rawVal) {
        tags = rawVal
          .split(",")
          .map((part) => unquoteYamlScalar(part))
          .filter(Boolean);
      } else {
        const list: string[] = [];
        while (i + 1 < lines.length) {
          const next = lines[i + 1]!;
          if (!next.trim()) {
            i++;
            continue;
          }
          const itemMatch = /^\s+-\s+(.+)$/.exec(next);
          if (!itemMatch) break;
          const cleaned = unquoteYamlScalar(itemMatch[1]!);
          if (cleaned) list.push(cleaned);
          i++;
        }
        tags = list;
      }
    }
  }

  return { name, description, tags, body };
}

export function normalizeSkillTags(tags: unknown): string[] {
  if (tags === undefined || tags === null) return [];
  if (!Array.isArray(tags)) {
    throw new ApiError(400, "invalid_skill", "`tags` must be an array of strings");
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tags) {
    if (typeof t !== "string") {
      throw new ApiError(400, "invalid_skill", "Each tag must be a string");
    }
    const clean = t.trim();
    if (!clean) continue;
    if (clean.length > 64) {
      throw new ApiError(400, "invalid_skill", `Tag '${clean.slice(0, 32)}...' exceeds 64 chars`);
    }
    if (!seen.has(clean)) {
      seen.add(clean);
      out.push(clean);
    }
  }
  out.sort(compareSlug);
  return out;
}

export interface NormalizedSkillPayload {
  slug: string;
  name: string;
  description: string;
  tags: string[];
  markdown: string;
  files: Record<string, string>;
  contentHash: string;
}

export async function normalizeAndValidateSkill(
  rawSlug: string,
  input: SkillUpsertInput,
): Promise<NormalizedSkillPayload> {
  const slug = validateSkillSlug(rawSlug);
  if (!input || typeof input !== "object" || typeof input.markdown !== "string") {
    throw new ApiError(400, "invalid_skill", "`markdown` string is required");
  }
  const markdown = input.markdown;
  if (!markdown.trim()) {
    throw new ApiError(400, "invalid_skill", "`markdown` cannot be empty");
  }

  const fm = parseSkillFrontmatter(markdown);
  const defaultName = slug.split("/").pop() || slug;
  const name = (typeof input.name === "string" && input.name.trim()) || fm.name?.trim() || defaultName;
  const description = (typeof input.description === "string" && input.description.trim()) || fm.description?.trim() || "";
  if (!description) {
    throw new ApiError(
      400,
      "invalid_skill",
      "Skill `description` is required (provide it in the request body or SKILL.md YAML frontmatter)",
    );
  }
  if (name.length > 160) {
    throw new ApiError(400, "invalid_skill", "Skill `name` must be at most 160 characters");
  }
  if (description.length > 1000) {
    throw new ApiError(400, "invalid_skill", "Skill `description` must be at most 1000 characters");
  }

  const tags = input.tags !== undefined ? normalizeSkillTags(input.tags) : normalizeSkillTags(fm.tags);

  const files: Record<string, string> = {};
  if (input.files !== undefined) {
    if (!input.files || typeof input.files !== "object" || Array.isArray(input.files)) {
      throw new ApiError(400, "invalid_skill_file", "`files` must be an object mapping relative paths to strings");
    }
    const entries = Object.entries(input.files);
    if (entries.length > SKILL_MAX_FILES) {
      throw new ApiError(
        400,
        "too_many_skill_files",
        `Skill may include at most ${SKILL_MAX_FILES} reference files (received ${entries.length})`,
      );
    }
    entries.sort(([a], [b]) => compareSlug(a, b));
    for (const [rawPath, content] of entries) {
      const validPath = validateSkillFilePath(rawPath);
      if (typeof content !== "string") {
        throw new ApiError(400, "invalid_skill_file", `File '${validPath}' content must be a string`);
      }
      files[validPath] = content;
    }
  }

  let totalBytes = utf8ByteLength(markdown);
  for (const [path, content] of Object.entries(files)) {
    totalBytes += utf8ByteLength(path) + utf8ByteLength(content);
  }
  if (totalBytes > SKILL_MAX_BYTES) {
    throw new ApiError(
      413,
      "skill_too_large",
      `Skill total size (${totalBytes} bytes) exceeds limit of ${SKILL_MAX_BYTES} bytes`,
    );
  }

  const contentHash = await computeSkillContentHash({
    name,
    description,
    tags,
    markdown,
    files,
  });

  return { slug, name, description, tags, markdown, files, contentHash };
}

export async function computeSkillContentHash(payload: {
  name: string;
  description: string;
  tags: string[];
  markdown: string;
  files: Record<string, string>;
}): Promise<string> {
  const sortedFiles = Object.entries(payload.files).sort(([a], [b]) => compareSlug(a, b));
  const canonical = JSON.stringify({
    name: payload.name,
    description: payload.description,
    tags: [...payload.tags].sort(compareSlug),
    markdown: payload.markdown,
    files: sortedFiles,
  });
  return sha256Hex(canonical);
}

/**
 * Matches a skill slug against an exact slug (`"camel-bots/sql-storage"`),
 * prefix glob (`"camel-bots/*"`), or universal selector (`"*"`).
 */
export function matchSkillSelector(slug: string, rawSelector: string): boolean {
  const selector = rawSelector.trim();
  if (!selector) return false;
  if (selector === "*") return true;
  if (selector.endsWith("/*")) {
    const prefix = selector.slice(0, -1); // keeps trailing '/'
    return slug.startsWith(prefix);
  }
  if (selector.endsWith("*")) {
    const prefix = selector.slice(0, -1);
    return slug.startsWith(prefix);
  }
  return slug === selector;
}

/**
 * Resolves a list of skills against selectors, deduplicated and deterministically sorted by `slug`.
 */
export function selectSkillsBySelectors<T extends { slug: string }>(
  skills: readonly T[],
  selectors: readonly string[],
): T[] {
  if (selectors.length === 0 || skills.length === 0) return [];
  const cleaned = selectors.map((s) => s.trim()).filter(Boolean);
  if (cleaned.length === 0) return [];
  const matched = new Map<string, T>();
  for (const skill of skills) {
    if (cleaned.some((sel) => matchSkillSelector(skill.slug, sel))) {
      matched.set(skill.slug, skill);
    }
  }
  return [...matched.values()].sort((a, b) => compareSlug(a.slug, b.slug));
}

/**
 * Builds a deterministic, prompt-cache-friendly `<skills>` index block to append to system instructions.
 */
export function buildSkillsPromptBlock(
  skills: ReadonlyArray<{ slug: string; description: string; files: Record<string, string> | string[] }>,
): string {
  if (skills.length === 0) return "";
  const sorted = [...skills].sort((a, b) => compareSlug(a.slug, b.slug));
  const lines: string[] = [
    "<skills>",
    "You have domain skills loaded on demand. Use `read_skill` to read a skill's instructions or reference files, and `search_skills` to find specific APIs/types/rules across skills without loading everything.",
  ];
  for (const skill of sorted) {
    const desc = skill.description.replace(/\s+/g, " ").trim();
    const fileList = Array.isArray(skill.files)
      ? [...skill.files].sort(compareSlug)
      : Object.keys(skill.files).sort(compareSlug);
    const refsSuffix = fileList.length > 0 ? ` (refs: ${fileList.join(", ")})` : "";
    lines.push(`- ${skill.slug}: ${desc}${refsSuffix}`);
  }
  lines.push("</skills>");
  return lines.join("\n");
}

function resolveSingleSkillByName(skills: readonly SkillRecord[], rawName: string): SkillRecord {
  const query = rawName.trim();
  if (!query) {
    throw new Error("`name` is required for read_skill");
  }
  if (skills.length === 0) {
    throw new Error("No skills are attached to this agent");
  }

  // 1. Exact slug match
  const exactSlug = skills.find((s) => s.slug === query);
  if (exactSlug) return exactSlug;

  // 2. Exact name match (if unambiguous)
  const exactNameMatches = skills.filter((s) => s.name === query);
  if (exactNameMatches.length === 1) return exactNameMatches[0]!;
  if (exactNameMatches.length > 1) {
    throw new Error(
      `Skill name '${query}' is ambiguous; specify one of: ${exactNameMatches.map((s) => s.slug).join(", ")}`,
    );
  }

  // 3. Unique suffix match (e.g. "sql-storage" -> "camel-bots/sql-storage")
  const suffix = `/${query}`;
  const suffixMatches = skills.filter((s) => s.slug.endsWith(suffix));
  if (suffixMatches.length === 1) return suffixMatches[0]!;
  if (suffixMatches.length > 1) {
    throw new Error(
      `Skill '${query}' is ambiguous; specify one of: ${suffixMatches.map((s) => s.slug).join(", ")}`,
    );
  }

  // 4. Case-insensitive fallback
  const lower = query.toLowerCase();
  const ciExact = skills.find((s) => s.slug.toLowerCase() === lower);
  if (ciExact) return ciExact;
  const ciSuffixMatches = skills.filter(
    (s) => s.slug.toLowerCase().endsWith(`/${lower}`) || s.name.toLowerCase() === lower,
  );
  if (ciSuffixMatches.length === 1) return ciSuffixMatches[0]!;
  if (ciSuffixMatches.length > 1) {
    throw new Error(
      `Skill '${query}' is ambiguous; specify one of: ${ciSuffixMatches.map((s) => s.slug).join(", ")}`,
    );
  }

  const available = [...skills].sort((a, b) => compareSlug(a.slug, b.slug)).map((s) => s.slug);
  throw new Error(`Skill '${query}' not found. Available skills: ${available.join(", ")}`);
}

/**
 * Reads `SKILL.md` (default) or a reference file from an attached skill with 1-indexed line slicing,
 * line numbers, byte/line caps, and continuation hint.
 */
export function readSkillFile(
  skills: readonly SkillRecord[],
  args: {
    name: string;
    file?: string;
    start_line?: number;
    end_line?: number;
  },
): ReadSkillResult {
  const skill = resolveSingleSkillByName(skills, args.name);
  const fileNames = Object.keys(skill.files).sort(compareSlug);
  const availableFiles = ["SKILL.md", ...fileNames];

  const rawFile = args.file?.trim().replace(/^\.\//, "") ?? "";
  let resolvedFile = "SKILL.md";
  let sourceText = skill.markdown;

  if (rawFile && rawFile.toLowerCase() !== "skill.md") {
    if (Object.prototype.hasOwnProperty.call(skill.files, rawFile)) {
      resolvedFile = rawFile;
      sourceText = skill.files[rawFile]!;
    } else {
      throw new Error(
        `File '${rawFile}' not found in skill '${skill.slug}'. Available files: ${availableFiles.join(", ")}`,
      );
    }
  }

  const lines = sourceText.split(/\r?\n/);
  const totalLines = lines.length;

  const requestedStart =
    typeof args.start_line === "number" && Number.isFinite(args.start_line)
      ? Math.max(1, Math.floor(args.start_line))
      : 1;
  const startLine = Math.min(requestedStart, Math.max(1, totalLines));

  const requestedEnd =
    typeof args.end_line === "number" && Number.isFinite(args.end_line)
      ? Math.min(totalLines, Math.max(startLine, Math.floor(args.end_line)))
      : totalLines;

  const maxEndByLineCap = Math.min(requestedEnd, startLine + SKILL_READ_MAX_LINES - 1);
  const outLines: string[] = [];
  let byteCount = 0;
  let actualEndLine = startLine - 1;
  let byteCapped = false;

  for (let lineNum = startLine; lineNum <= maxEndByLineCap; lineNum++) {
    let formatted = `${lineNum}: ${lines[lineNum - 1] ?? ""}`;
    const lineBytes = utf8ByteLength(formatted) + (outLines.length > 0 ? 1 : 0);
    if (outLines.length > 0 && byteCount + lineBytes > SKILL_READ_MAX_BYTES) {
      byteCapped = true;
      break;
    }
    if (outLines.length === 0 && lineBytes > SKILL_READ_MAX_BYTES) {
      // Truncate single huge line cleanly by character estimate
      formatted = formatted.slice(0, SKILL_READ_MAX_BYTES - 32) + "...[line truncated]";
      byteCapped = true;
    }
    outLines.push(formatted);
    byteCount += utf8ByteLength(formatted) + (outLines.length > 1 ? 1 : 0);
    actualEndLine = lineNum;
  }

  const truncated = byteCapped || actualEndLine < requestedEnd;
  const nextStartLine = actualEndLine < totalLines ? actualEndLine + 1 : undefined;

  return {
    skill: skill.slug,
    name: skill.name,
    file: resolvedFile,
    startLine,
    endLine: Math.max(startLine, actualEndLine),
    totalLines,
    truncated,
    ...(truncated && nextStartLine !== undefined
      ? {
          nextStartLine,
          hint: `Output truncated at line ${actualEndLine} of ${totalLines}. Call read_skill with name="${skill.slug}", file="${resolvedFile}", start_line=${nextStartLine} to continue.`,
        }
      : {}),
    availableFiles,
    content: outLines.join("\n"),
  };
}

const SYMBOL_DECL_REGEX =
  /^\s*(?:export\s+)?(?:declare\s+)?(?:default\s+)?(?:abstract\s+)?(?:async\s+)?(?:interface|type|class|function|const|let|var|enum|namespace|module|def|func|struct|trait)\s+[A-Za-z_$][A-Za-z0-9_$]*/;
const METHOD_DECL_REGEX =
  /^\s*(?:readonly\s+)?(?:async\s+)?[A-Za-z_$][A-Za-z0-9_$]*\s*(?:<[^>]*>)?\s*\([^)]*\)\s*(?::|\{)/;
const HEADING_REGEX = /^\s*#{1,6}\s+/;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function clampLine(line: string, maxLen = 220): string {
  if (line.length <= maxLen) return line;
  return `${line.slice(0, maxLen - 3)}...`;
}

/**
 * Case-insensitive keyword & symbol search across attached skills' `SKILL.md` and reference files.
 * Prioritizes skill names, markdown headings, and `.d.ts`/code symbol declarations, returning
 * compact ranked line-numbered snippets capped cleanly at 12 KiB.
 */
export function searchSkills(
  skills: readonly SkillRecord[],
  args: {
    query: string;
    skill?: string;
    max_results?: number;
  },
): SearchSkillsResult {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) {
    throw new Error("`query` must be a non-empty string");
  }

  let candidates: readonly SkillRecord[] = skills;
  if (args.skill && args.skill.trim()) {
    const filter = args.skill.trim();
    if (filter.includes("*")) {
      candidates = selectSkillsBySelectors(skills, [filter]);
    } else {
      candidates = [resolveSingleSkillByName(skills, filter)];
    }
  }

  const maxResults = Math.max(
    1,
    Math.min(
      SKILL_SEARCH_MAX_RESULTS,
      typeof args.max_results === "number" && Number.isFinite(args.max_results)
        ? Math.floor(args.max_results)
        : SKILL_SEARCH_DEFAULT_RESULTS,
    ),
  );

  const queryLower = query.toLowerCase();
  const terms = [...new Set(queryLower.split(/\s+/).filter(Boolean))];
  const wordBoundaryRegex = new RegExp(`\\b${escapeRegex(queryLower)}\\b`, "i");

  interface ScoredCandidate {
    skill: string;
    file: string;
    line: number;
    score: number;
    lines: string[];
  }

  const rawHits: ScoredCandidate[] = [];

  for (const skill of [...candidates].sort((a, b) => compareSlug(a.slug, b.slug))) {
    const slugLower = skill.slug.toLowerCase();
    const nameLower = skill.name.toLowerCase();
    const descLower = skill.description.toLowerCase();
    const tagsLower = skill.tags.map((t) => t.toLowerCase());

    let skillMetaBoost = 0;
    if (slugLower.includes(queryLower) || nameLower.includes(queryLower)) {
      skillMetaBoost += 14;
    } else if (terms.length > 0 && terms.every((t) => slugLower.includes(t) || nameLower.includes(t))) {
      skillMetaBoost += 10;
    } else if (
      descLower.includes(queryLower) ||
      tagsLower.some((t) => t.includes(queryLower))
    ) {
      skillMetaBoost += 6;
    }

    const docs: Array<{ file: string; text: string }> = [
      { file: "SKILL.md", text: skill.markdown },
      ...Object.keys(skill.files)
        .sort(compareSlug)
        .map((file) => ({ file, text: skill.files[file]! })),
    ];

    let skillHitCount = 0;

    for (const doc of docs) {
      const lines = doc.text.split(/\r?\n/);
      const isDts = doc.file.toLowerCase().endsWith(".d.ts");
      const isCode = /\.(?:d\.ts|ts|tsx|js|jsx|mjs|cjs|py|go|rs|sql)$/i.test(doc.file);

      const fileHits: ScoredCandidate[] = [];

      for (let i = 0; i < lines.length; i++) {
        const lineText = lines[i]!;
        const lineLower = lineText.toLowerCase();
        const phraseMatch = lineLower.includes(queryLower);

        let matchedTerms = 0;
        for (const t of terms) {
          if (lineLower.includes(t)) matchedTerms++;
        }

        if (!phraseMatch && matchedTerms === 0) continue;
        // For multi-term queries, require either full phrase match, all terms on line, or >= half terms
        if (terms.length > 1 && !phraseMatch && matchedTerms < Math.ceil(terms.length / 2)) {
          continue;
        }

        let score = 0;
        if (phraseMatch) score += 20;
        if (matchedTerms === terms.length) score += 12;
        score += matchedTerms * 4;

        if (wordBoundaryRegex.test(lineText)) score += 8;
        if (SYMBOL_DECL_REGEX.test(lineText)) {
          score += isDts ? 26 : isCode ? 20 : 12;
        } else if (isDts && METHOD_DECL_REGEX.test(lineText)) {
          score += 18;
        } else if (HEADING_REGEX.test(lineText)) {
          score += 14;
        } else if (isDts) {
          score += 4;
        }

        score += skillMetaBoost;

        fileHits.push({
          skill: skill.slug,
          file: doc.file,
          line: i + 1,
          score,
          lines,
        });
      }

      // Deduplicate nearby hits within 2 lines of a higher-scoring hit in the same file
      fileHits.sort((a, b) => b.score - a.score || a.line - b.line);
      const acceptedLines: number[] = [];
      for (const hit of fileHits) {
        if (acceptedLines.some((ln) => Math.abs(ln - hit.line) <= 2)) continue;
        acceptedLines.push(hit.line);
        rawHits.push(hit);
        skillHitCount++;
      }
    }

    // If the skill's name/slug/description matched strongly but no body line matched, surface top of SKILL.md
    if (skillHitCount === 0 && skillMetaBoost >= 10) {
      const mdLines = skill.markdown.split(/\r?\n/);
      const firstHeadingIdx = mdLines.findIndex((l) => HEADING_REGEX.test(l));
      const lineIdx = firstHeadingIdx >= 0 ? firstHeadingIdx : 0;
      rawHits.push({
        skill: skill.slug,
        file: "SKILL.md",
        line: lineIdx + 1,
        score: skillMetaBoost + 5,
        lines: mdLines,
      });
    }
  }

  rawHits.sort(
    (a, b) =>
      b.score - a.score ||
      compareSlug(a.skill, b.skill) ||
      compareSlug(a.file, b.file) ||
      a.line - b.line,
  );

  const results: SkillSearchMatch[] = [];
  let totalBytes = 128; // overhead for JSON wrapper

  for (const hit of rawHits) {
    if (results.length >= maxResults) break;
    const from = Math.max(1, hit.line - 1);
    const to = Math.min(hit.lines.length, hit.line + 1);
    const snippetLines: string[] = [];
    for (let ln = from; ln <= to; ln++) {
      snippetLines.push(`${ln}: ${clampLine(hit.lines[ln - 1] ?? "")}`);
    }
    const entry: SkillSearchMatch = {
      skill: hit.skill,
      file: hit.file,
      line: hit.line,
      snippet: snippetLines.join("\n"),
    };
    const entryBytes = utf8ByteLength(JSON.stringify(entry)) + 2;
    if (results.length > 0 && totalBytes + entryBytes > SKILL_SEARCH_MAX_BYTES) {
      break;
    }
    results.push(entry);
    totalBytes += entryBytes;
  }

  return {
    query,
    totalMatches: rawHits.length,
    truncated: results.length < rawHits.length,
    results,
  };
}
