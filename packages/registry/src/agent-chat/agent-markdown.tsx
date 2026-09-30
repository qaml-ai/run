"use client";

import { memo, useMemo, type ReactNode } from "react";
import { parseMarkdown, type Block, type Inline } from "@camelai/run/markdown";
import { cn } from "@/lib/utils";

/**
 * The agent's markdown, rendered with elements (never HTML): only http(s) and mailto links, images as
 * links (loading an image the model chose tells its server about the reader), and tolerant of text
 * that is still streaming. Unchanged blocks are not rendered again.
 */
export const AgentMarkdown = memo(function AgentMarkdown({ text, streaming = false, className }: { text: string; streaming?: boolean; className?: string }) {
  // Should parsing ever fail, the text shows as it is: a reply always renders.
  const blocks = useMemo<Block[]>(() => {
    try { return parseMarkdown(text, { streaming }); }
    catch { return [{ type: "paragraph", children: [{ type: "text", text }], raw: text }]; }
  }, [text, streaming]);
  return (
    <div className={cn("space-y-3 break-words text-sm leading-relaxed", className)}>
      {blocks.map((block, at) => <MarkdownBlock key={at} block={block} open={streaming && at === blocks.length - 1} />)}
    </div>
  );
});

const MarkdownBlock = memo(function MarkdownBlock({ block }: { block: Block; open?: boolean }) {
  switch (block.type) {
    case "paragraph": return <p><Inlines nodes={block.children} /></p>;
    case "heading": {
      const size = ["text-xl", "text-lg", "text-base", "text-sm", "text-sm", "text-sm"][block.level - 1];
      const Tag = `h${block.level}` as "h2";
      return <Tag className={cn("font-semibold tracking-tight", size)}><Inlines nodes={block.children} /></Tag>;
    }
    case "code": return (
      <div className="overflow-hidden rounded-md border bg-muted">
        {block.lang && <div className="border-b px-3 py-1 text-xs text-muted-foreground">{block.lang}</div>}
        <pre className="overflow-x-auto p-3 font-mono text-xs leading-normal"><code>{block.text}</code></pre>
      </div>
    );
    case "blockquote": return <blockquote className="space-y-3 border-l-2 pl-3 text-muted-foreground">{block.children.map((child, at) => <MarkdownBlock key={at} block={child} />)}</blockquote>;
    case "list": {
      const items = block.items.map((item, at) => (
        <li key={at}>{item.length === 1 && item[0].type === "paragraph" ? <Inlines nodes={item[0].children} /> : item.map((child, index) => <MarkdownBlock key={index} block={child} />)}</li>
      ));
      return block.ordered
        ? <ol start={block.start === 1 ? undefined : block.start} className="list-decimal space-y-1 pl-5">{items}</ol>
        : <ul className="list-disc space-y-1 pl-5">{items}</ul>;
    }
    case "table": return (
      <div className="overflow-x-auto">
        <table className="w-auto border-collapse text-sm">
          <thead><tr>{block.head.map((cell, at) => <th key={at} className="border bg-muted px-3 py-1 text-left font-medium" style={block.align[at] ? { textAlign: block.align[at]! } : undefined}><Inlines nodes={cell} /></th>)}</tr></thead>
          <tbody>{block.rows.map((row, index) => <tr key={index}>{row.map((cell, at) => <td key={at} className="border px-3 py-1" style={block.align[at] ? { textAlign: block.align[at]! } : undefined}><Inlines nodes={cell} /></td>)}</tr>)}</tbody>
        </table>
      </div>
    );
    case "hr": return <hr className="border-border" />;
  }
}, (a, b) => a.block.raw === b.block.raw && a.block.type === b.block.type && a.open === b.open);

function Inlines({ nodes }: { nodes: Inline[] }) {
  return <>{nodes.map((node, at) => <InlineNode key={at} node={node} />)}</>;
}

function InlineNode({ node }: { node: Inline }): ReactNode {
  switch (node.type) {
    case "text": return node.text;
    case "break": return <br />;
    case "code": return <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">{node.text}</code>;
    case "strong": return <strong className="font-semibold"><Inlines nodes={node.children} /></strong>;
    case "em": return <em><Inlines nodes={node.children} /></em>;
    case "del": return <del><Inlines nodes={node.children} /></del>;
    case "link": return <a href={node.href} target="_blank" rel="noopener noreferrer nofollow" className="underline underline-offset-2"><Inlines nodes={node.children} /></a>;
    case "image": return <a href={node.src} target="_blank" rel="noopener noreferrer nofollow" className="underline underline-offset-2">{node.alt || node.src}</a>;
  }
}
