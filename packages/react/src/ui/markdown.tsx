import { memo, useMemo, useState, type ReactNode } from "react";
import { inlineText, parseMarkdown, type Block, type Inline } from "@camelai/agent-runtime/markdown";
import { cx, useUI } from "./context.tsx";

/**
 * Markdown as the agent writes it, rendered with React elements (never HTML). Blocks that did not
 * change are not rendered again while the last one streams. Images show as links unless the chat
 * allows them (`allowImages`): loading an image the model chose tells its server about the reader.
 */
export const Markdown = memo(function Markdown({ text, streaming = false, className }: { text: string; streaming?: boolean; className?: string }) {
  const blocks = useMemo(() => safely(text, streaming), [text, streaming]);
  return <div className={cx("agent-chat__markdown", className)}>{blocks.map((block, at) => <BlockView key={at} block={block} open={streaming && at === blocks.length - 1} />)}</div>;
});

/** A block; `open`: the last block of text still streaming (it may parse differently once settled). */
/** The blocks, or the text as one paragraph should parsing ever fail: a reply always shows. */
function safely(text: string, streaming: boolean): Block[] {
  try { return parseMarkdown(text, { streaming }); }
  catch { return [{ type: "paragraph", children: [{ type: "text", text }], raw: text }]; }
}

const BlockView = memo(function BlockView({ block }: { block: Block; open?: boolean }) {
  switch (block.type) {
    case "paragraph": return <p><Inlines nodes={block.children} /></p>;
    case "heading": {
      const Tag = `h${block.level}` as "h1";
      return <Tag><Inlines nodes={block.children} /></Tag>;
    }
    case "code": return <CodeBlock lang={block.lang} text={block.text} />;
    case "blockquote": return <blockquote>{block.children.map((child, at) => <BlockView key={at} block={child} />)}</blockquote>;
    case "list": {
      const items = block.items.map((item, at) => (
        <li key={at}>{item.length === 1 && item[0].type === "paragraph" ? <Inlines nodes={item[0].children} /> : item.map((child, index) => <BlockView key={index} block={child} />)}</li>
      ));
      return block.ordered ? <ol start={block.start === 1 ? undefined : block.start}>{items}</ol> : <ul>{items}</ul>;
    }
    case "table": return (
      <div className="agent-chat__table">
        <table>
          <thead><tr>{block.head.map((cell, at) => <th key={at} style={block.align[at] ? { textAlign: block.align[at]! } : undefined}><Inlines nodes={cell} /></th>)}</tr></thead>
          <tbody>{block.rows.map((row, index) => <tr key={index}>{row.map((cell, at) => <td key={at} style={block.align[at] ? { textAlign: block.align[at]! } : undefined}><Inlines nodes={cell} /></td>)}</tr>)}</tbody>
        </table>
      </div>
    );
    case "hr": return <hr />;
  }
}, (a, b) => a.block.raw === b.block.raw && a.block.type === b.block.type && a.open === b.open);

function Inlines({ nodes }: { nodes: Inline[] }) {
  return <>{nodes.map((node, at) => <InlineView key={at} node={node} />)}</>;
}

function InlineView({ node }: { node: Inline }): ReactNode {
  const { allowImages } = useUI();
  switch (node.type) {
    case "text": return node.text;
    case "break": return <br />;
    case "code": return <code>{node.text}</code>;
    case "strong": return <strong><Inlines nodes={node.children} /></strong>;
    case "em": return <em><Inlines nodes={node.children} /></em>;
    case "del": return <del><Inlines nodes={node.children} /></del>;
    case "link": return <a href={node.href} target="_blank" rel="noopener noreferrer nofollow"><Inlines nodes={node.children} /></a>;
    case "image": return allowImages
      ? <img src={node.src} alt={node.alt} loading="lazy" referrerPolicy="no-referrer" />
      : <a href={node.src} target="_blank" rel="noopener noreferrer nofollow">{node.alt || inlineText([node]) || node.src}</a>;
  }
}

function CodeBlock({ lang, text }: { lang: string; text: string }) {
  const { labels } = useUI();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* no clipboard */ }
  };
  return (
    <div className="agent-chat__code">
      <div className="agent-chat__code-bar">
        <span>{lang}</span>
        <button type="button" className="agent-chat__code-copy" onClick={copy} aria-label={copied ? labels.copied : `${labels.copy}${lang ? ` ${lang}` : ""}`}>{copied ? labels.copied : labels.copy}</button>
      </div>
      <pre><code data-language={lang || undefined}>{text}</code></pre>
    </div>
  );
}
