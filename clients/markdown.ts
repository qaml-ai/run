/**
 * Markdown as an agent writes it, parsed into a small tree for any UI framework to render: paragraphs,
 * headings, lists, quotes, code, tables and rules; bold, italic, strikethrough, code, links and
 * images. There is no raw HTML, and links keep only http(s) and mailto URLs, so rendering the tree
 * with a framework's elements (never as HTML) is safe with untrusted text.
 *
 * It is made for text that is still streaming: an unclosed code fence runs to the end, and with
 * `streaming`, emphasis or code opened in the last paragraph shows as such before it closes, so
 * nothing jumps when the closing marker arrives. Each block keeps its source (`raw`), so a renderer
 * can skip blocks that did not change.
 */

export type Inline =
  | { type: "text"; text: string }
  | { type: "strong" | "em" | "del"; children: Inline[] }
  | { type: "code"; text: string }
  | { type: "link"; href: string; children: Inline[] }
  | { type: "image"; src: string; alt: string }
  | { type: "break" };

export type Block = (
  | { type: "paragraph"; children: Inline[] }
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; children: Inline[] }
  | { type: "code"; lang: string; text: string; closed: boolean }
  | { type: "blockquote"; children: Block[] }
  | { type: "list"; ordered: boolean; start: number; items: Block[][] }
  | { type: "table"; align: ("left" | "center" | "right" | null)[]; head: Inline[][]; rows: Inline[][][] }
  | { type: "hr" }
) & { raw: string };

export interface MarkdownOptions {
  /** The text is still being written: close what its last block leaves open. */
  streaming?: boolean;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}> ?/;
const ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])([ \t]+|$)/;
const TABLE_DIVIDER = /^ {0,3}\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/** Only URLs a link may take: http(s) and mailto. Anything else (javascript:, data:, relative) is not a link. */
export function safeUrl(url: string): string | null {
  const trimmed = url.trim();
  return /^(https?:\/\/|mailto:)/i.test(trimmed) && !/[\s<>"]/.test(trimmed) ? trimmed : null;
}

/**
 * How deep quotes, lists and emphasis nest before the rest is plain text, and how far a link's label or
 * URL may reach: text a model streams (or a user pastes) cannot make parsing deep or quadratic.
 */
const MAX_DEPTH = 16;
const MAX_LABEL = 1000;
const MAX_URL = 2048;

export function parseMarkdown(text: string, options: MarkdownOptions = {}): Block[] {
  return parseBlocks(text.replace(/\r\n?/g, "\n").split("\n"), options.streaming ?? false, 0);
}

function parseBlocks(lines: string[], streaming: boolean, depth: number): Block[] {
  if (depth > MAX_DEPTH) return [{ type: "paragraph", children: [{ type: "text", text: lines.join("\n") }], raw: lines.join("\n") }];
  const blocks: Block[] = [];
  let at = 0;
  while (at < lines.length) {
    const line = lines[at];
    if (!line.trim()) { at++; continue; }
    const start = at;
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1];
      const indent = line.length - line.trimStart().length;
      const body: string[] = [];
      at++;
      let closed = false;
      while (at < lines.length) {
        const close = lines[at].trim();
        if (close.startsWith(marker[0].repeat(marker.length)) && /^[`~]+$/.test(close) && close.length >= marker.length) { closed = true; at++; break; }
        body.push(indent ? lines[at].replace(new RegExp(`^ {0,${indent}}`), "") : lines[at]);
        at++;
      }
      blocks.push({ type: "code", lang: fence[2] ?? "", text: body.join("\n"), closed, raw: lines.slice(start, at).join("\n") });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      at++;
      blocks.push({ type: "heading", level: heading[1].length as 1, children: parseInline(heading[2] ?? "", streaming && at >= lines.length), raw: line });
      continue;
    }
    if (RULE.test(line)) { at++; blocks.push({ type: "hr", raw: line }); continue; }
    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (at < lines.length && lines[at].trim() && (QUOTE.test(lines[at]) || inner.length)) {
        if (!QUOTE.test(lines[at]) && (FENCE.test(lines[at]) || HEADING.test(lines[at]) || ITEM.test(lines[at]))) break;
        inner.push(lines[at].replace(QUOTE, ""));
        at++;
      }
      blocks.push({ type: "blockquote", children: parseBlocks(inner, streaming && at >= lines.length, depth + 1), raw: lines.slice(start, at).join("\n") });
      continue;
    }
    const item = ITEM.exec(line);
    if (item) {
      const list = parseList(lines, at, streaming, depth);
      at = list.end;
      blocks.push({ ...list.block, raw: lines.slice(start, at).join("\n") });
      continue;
    }
    if (line.includes("|") && at + 1 < lines.length && TABLE_DIVIDER.test(lines[at + 1]) && lines[at + 1].includes("-")) {
      const head = cells(line);
      const align = cells(lines[at + 1]).map(cell => {
        const left = cell.startsWith(":"), right = cell.endsWith(":");
        return left && right ? "center" as const : right ? "right" as const : left ? "left" as const : null;
      });
      at += 2;
      const rows: Inline[][][] = [];
      while (at < lines.length && lines[at].trim() && lines[at].includes("|")) {
        const row = cells(lines[at]);
        rows.push(head.map((_, column) => parseInline(row[column] ?? "", false)));
        at++;
      }
      blocks.push({ type: "table", align: head.map((_, column) => align[column] ?? null), head: head.map(cell => parseInline(cell, false)), rows, raw: lines.slice(start, at).join("\n") });
      continue;
    }
    // A paragraph: up to a blank line or the start of another block.
    const body: string[] = [];
    while (at < lines.length && lines[at].trim()) {
      const next = lines[at];
      if (body.length && (FENCE.test(next) || HEADING.test(next) || RULE.test(next) || QUOTE.test(next) || ITEM.test(next))) break;
      body.push(next);
      at++;
    }
    // Only the last block is still being written.
    blocks.push({ type: "paragraph", children: parseInline(body.join("\n"), streaming && at >= lines.length), raw: body.join("\n") });
  }
  return blocks;
}

function cells(line: string): string[] {
  let row = line.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|") && !row.endsWith("\\|")) row = row.slice(0, -1);
  const out: string[] = [];
  let cell = "";
  for (let at = 0; at < row.length; at++) {
    if (row[at] === "\\" && row[at + 1] === "|") { cell += "|"; at++; continue; }
    if (row[at] === "|") { out.push(cell.trim()); cell = ""; continue; }
    cell += row[at];
  }
  out.push(cell.trim());
  return out;
}

function parseList(lines: string[], from: number, streaming: boolean, depth: number): { block: Omit<Extract<Block, { type: "list" }>, "raw">; end: number } {
  const first = ITEM.exec(lines[from])!;
  const ordered = /\d/.test(first[2]);
  const indent = first[1].length;
  const items: Block[][] = [];
  let at = from;
  while (at < lines.length) {
    const item = ITEM.exec(lines[at]);
    if (!item || item[1].length !== indent || /\d/.test(item[2]) !== ordered) break;
    const contentIndent = item[0].length || indent + item[2].length + 1;
    const body = [lines[at].slice(item[0].length)];
    at++;
    while (at < lines.length) {
      const next = lines[at];
      if (!next.trim()) {
        // A blank line continues the item only if what follows is indented under it.
        const after = lines[at + 1];
        if (after !== undefined && after.trim() && after.length - after.trimStart().length >= contentIndent) { body.push(""); at++; continue; }
        break;
      }
      const nested = ITEM.exec(next);
      const nextIndent = next.length - next.trimStart().length;
      if (nested && nested[1].length <= indent) break;
      if (!nested && nextIndent < contentIndent && (FENCE.test(next) || HEADING.test(next) || RULE.test(next) || QUOTE.test(next))) break;
      body.push(nextIndent >= contentIndent ? next.slice(contentIndent) : next.trimStart());
      at++;
    }
    items.push(parseBlocks(body, streaming && at >= lines.length, depth + 1));
  }
  return { block: { type: "list", ordered, start: ordered ? parseInt(first[2], 10) : 1, items }, end: at };
}

const PUNCTUATION = /[!-/:-@[-`{-~\s]/;

/** Inline markdown. `open`: close emphasis and code left open at the end (the text is still streaming). */
export function parseInline(text: string, open = false, depth = 0): Inline[] {
  if (depth > MAX_DEPTH) return text ? [{ type: "text", text }] : [];
  const out: Inline[] = [];
  /** Where each marker has no closer from, once a search found none: a later search cannot find one either. */
  const unclosed = new Map<string, number>();
  let buffer = "";
  const flush = () => { if (buffer) { out.push({ type: "text", text: buffer }); buffer = ""; } };
  let at = 0;
  while (at < text.length) {
    const char = text[at];
    if (char === "\\" && at + 1 < text.length && PUNCTUATION.test(text[at + 1]) && text[at + 1] !== " ") { buffer += text[at + 1]; at += 2; continue; }
    if (char === "\\" && text[at + 1] === "\n") { flush(); out.push({ type: "break" }); at += 2; continue; }
    if (char === "\n") {
      // A newline is a line break, as people expect in a chat.
      buffer = buffer.replace(/ +$/, "");
      flush(); out.push({ type: "break" }); at++; continue;
    }
    if (char === "`") {
      const ticks = /^`+/.exec(text.slice(at))![0];
      const close = at >= (unclosed.get(ticks) ?? Infinity) ? -1 : text.indexOf(ticks, at + ticks.length);
      if (close === -1 && !unclosed.has(ticks)) unclosed.set(ticks, at);
      if (close !== -1 && text[close + ticks.length] !== "`") {
        flush();
        let code = text.slice(at + ticks.length, close).replace(/\n/g, " ");
        if (/^ .*[^ ].* $/.test(code)) code = code.slice(1, -1);
        out.push({ type: "code", text: code });
        at = close + ticks.length;
        continue;
      }
      if (open && close === -1) { flush(); out.push({ type: "code", text: text.slice(at + ticks.length) }); at = text.length; continue; }
      buffer += ticks; at += ticks.length; continue;
    }
    if (char === "!" && text[at + 1] === "[") {
      const link = linkAt(text, at + 1);
      if (link) { flush(); const src = safeUrl(link.url); out.push(src ? { type: "image", src, alt: link.label } : { type: "text", text: link.label }); at = link.end; continue; }
    }
    if (char === "[") {
      const link = linkAt(text, at);
      if (link) {
        flush();
        const href = safeUrl(link.url);
        const children = parseInline(link.label, false, depth + 1);
        if (href) out.push({ type: "link", href, children }); else out.push(...children);
        at = link.end;
        continue;
      }
    }
    if (char === "<") {
      const auto = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/i.exec(text.slice(at));
      if (auto) { flush(); out.push({ type: "link", href: auto[1], children: [{ type: "text", text: auto[1].replace(/^mailto:/i, "") }] }); at += auto[0].length; continue; }
    }
    if ((char === "h" || char === "H") && (at === 0 || /[\s(]/.test(text[at - 1]))) {
      const bare = /^https?:\/\/[^\s<>]*[^\s<>.,:;"')\]!?*_~]/i.exec(text.slice(at));
      if (bare) { flush(); out.push({ type: "link", href: bare[0], children: [{ type: "text", text: bare[0] }] }); at += bare[0].length; continue; }
    }
    if (char === "*" || char === "_" || char === "~") {
      const run = new RegExp(`^\\${char}+`).exec(text.slice(at))![0];
      const size = char === "~" ? (run.length >= 2 ? 2 : 0) : Math.min(run.length, 2);
      const before = at > 0 ? text[at - 1] : " ";
      const after = text[at + size] ?? " ";
      // An opener is followed by a non-space; `_` inside a word (snake_case) is not emphasis.
      const canOpen = size > 0 && !/\s/.test(after) && !(char === "_" && /[\p{L}\p{N}]/u.test(before));
      if (canOpen) {
        const marker = char.repeat(size);
        const close = at + size >= (unclosed.get(marker) ?? Infinity) ? -1 : findCloser(text, at + size, marker);
        if (close === -1 && !unclosed.has(marker)) unclosed.set(marker, at + size);
        const type = char === "~" ? "del" as const : size === 2 ? "strong" as const : "em" as const;
        if (close !== -1) {
          flush();
          out.push({ type, children: parseInline(text.slice(at + size, close), false, depth + 1) });
          at = close + size;
          continue;
        }
        if (open && at + size < text.length) {
          flush();
          out.push({ type, children: parseInline(text.slice(at + size), true, depth + 1) });
          at = text.length;
          continue;
        }
      }
      buffer += run; at += run.length; continue;
    }
    buffer += char;
    at++;
  }
  flush();
  return out;
}

function findCloser(text: string, from: number, marker: string): number {
  for (let at = from; at < text.length; at++) {
    const char = text[at];
    if (char === "\\") { at++; continue; }
    if (char === "`") {
      const ticks = /^`+/.exec(text.slice(at))![0];
      const close = text.indexOf(ticks, at + ticks.length);
      if (close !== -1) { at = close + ticks.length - 1; continue; }
    }
    if (text.startsWith(marker, at) && at > from && !/\s/.test(text[at - 1])) {
      const next = text[at + marker.length];
      // `**` closes `**`, not the first half of `***`; `_` closes only at a word's end.
      if (next === marker[0] && marker.length === 1 && text[at + 2] !== marker[0]) { at++; continue; }
      if (marker[0] === "_" && next !== undefined && /[\p{L}\p{N}]/u.test(next)) continue;
      return at;
    }
  }
  return -1;
}

function linkAt(text: string, at: number): { label: string; url: string; end: number } | null {
  let depth = 0;
  for (let close = at; close < Math.min(text.length, at + MAX_LABEL); close++) {
    if (text[close] === "\\") { close++; continue; }
    if (text[close] === "[") depth++;
    else if (text[close] === "]" && --depth === 0) {
      if (text[close + 1] !== "(") return null;
      // The URL, with balanced parentheses (as in a Wikipedia link), then an optional "title".
      let end = close + 2, parens = 0;
      while (end < text.length && end < close + 2 + MAX_URL && !/\s/.test(text[end])) {
        if (text[end] === "(") parens++;
        else if (text[end] === ")" && parens-- === 0) break;
        end++;
      }
      const url = text.slice(close + 2, end).replace(/^<(.*)>$/, "$1");
      const rest = /^(?:\s+"[^"]*")?\s*\)/.exec(text.slice(end));
      if (!rest) return null;
      return { label: text.slice(at + 1, close), url, end: end + rest[0].length };
    }
  }
  return null;
}

/** The plain text of inline nodes (for alt text, copy, and announcements). */
export function inlineText(nodes: Inline[]): string {
  return nodes.map(node => node.type === "text" || node.type === "code" ? node.text : node.type === "break" ? "\n" : node.type === "image" ? node.alt : inlineText(node.children)).join("");
}
