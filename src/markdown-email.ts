import { parseMarkdown, safeUrl, type Block, type Inline } from "../clients/markdown.ts";

const escape = (text: string) => text.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const link = (url: string, label: string) => safeUrl(url) ? `<a href="${escape(url)}" style="color:#2563eb">${label}</a>` : label;
function inline(nodes: Inline[]): string {
  return nodes.map(node => {
    switch (node.type) {
      case "text": return escape(node.text);
      case "break": return "<br>";
      case "strong": case "em": case "del": return `<${node.type}>${inline(node.children)}</${node.type}>`;
      case "code": return `<code style="background:#f3f4f6;padding:2px 4px">${escape(node.text)}</code>`;
      case "link": return link(node.href, inline(node.children));
      // Keep image references as links: opening a report must not load tracking pixels.
      case "image": return link(node.src, escape(node.alt || "Image"));
    }
  }).join("");
}
function blocks(nodes: Block[]): string {
  return nodes.map(node => {
    switch (node.type) {
      case "paragraph": return `<p style="margin:0 0 16px">${inline(node.children)}</p>`;
      case "heading": return `<h${node.level} style="line-height:1.3;margin:24px 0 12px">${inline(node.children)}</h${node.level}>`;
      case "hr": return '<hr style="border:0;border-top:1px solid #d1d5db;margin:24px 0">';
      case "blockquote": return `<blockquote style="border-left:3px solid #d1d5db;margin:16px 0;padding-left:16px;color:#4b5563">${blocks(node.children)}</blockquote>`;
      case "code": return `<pre style="white-space:pre-wrap;overflow-wrap:anywhere;background:#f3f4f6;padding:12px"><code>${escape(node.text)}</code></pre>`;
      case "list": return `<${node.ordered ? `ol start="${node.start}"` : "ul"} style="padding-left:24px">${node.items.map(item => `<li>${blocks(item)}</li>`).join("")}</${node.ordered ? "ol" : "ul"}>`;
      case "table": {
        const row = (cells: Inline[][], tag: "th" | "td") => `<tr>${cells.map((cell, i) => `<${tag} style="border:1px solid #d1d5db;padding:8px;text-align:${node.align[i] ?? "left"}">${inline(cell)}</${tag}>`).join("")}</tr>`;
        return `<table style="border-collapse:collapse;margin:16px 0;width:100%"><thead>${row(node.head, "th")}</thead><tbody>${node.rows.map(cells => row(cells, "td")).join("")}</tbody></table>`;
      }
    }
  }).join("\n");
}
/** Render the same Markdown tree as the SDK UIs, escaping all model text and attributes. */
export function markdownEmail(text: string): string {
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#fff;color:#111827"><main style="max-width:720px;margin:0 auto;font:16px/1.6 Arial,sans-serif;overflow-wrap:anywhere">${blocks(parseMarkdown(text))}</main></body></html>`;
}
