import { test } from "node:test";
import assert from "node:assert/strict";
import { inlineText, parseInline, parseMarkdown, safeUrl, type Block } from "../clients/markdown.ts";

const types = (blocks: Block[]) => blocks.map(block => block.type);
const strip = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (key, inner) => key === "raw" ? undefined : inner));

test("blocks: paragraphs, headings, rules, quotes, fences, lists and tables", () => {
  const blocks = parseMarkdown([
    "# Title", "", "Some *text*", "on two lines.", "", "---", "> quoted", "> more", "",
    "```ts", "const a = 1;", "```", "", "- one", "- two", "  - nested", "", "1. first", "2. second", "",
    "| a | b |", "|:--|--:|", "| 1 | 2 |",
  ].join("\n"));
  assert.deepEqual(types(blocks), ["heading", "paragraph", "hr", "blockquote", "code", "list", "list", "table"]);
  assert.deepEqual(strip(blocks[0]), { type: "heading", level: 1, children: [{ type: "text", text: "Title" }] });
  assert.deepEqual(strip(blocks[1]), { type: "paragraph", children: [{ type: "text", text: "Some " }, { type: "em", children: [{ type: "text", text: "text" }] }, { type: "break" }, { type: "text", text: "on two lines." }] });
  assert.deepEqual(strip(blocks[4]), { type: "code", lang: "ts", text: "const a = 1;", closed: true });
  const list = blocks[5] as Extract<Block, { type: "list" }>;
  assert.equal(list.items.length, 2);
  assert.deepEqual(types(list.items[1]), ["paragraph", "list"]);
  assert.deepEqual(strip(blocks[6]), { type: "list", ordered: true, start: 1, items: [[{ type: "paragraph", children: [{ type: "text", text: "first" }] }], [{ type: "paragraph", children: [{ type: "text", text: "second" }] }]] });
  const table = blocks[7] as Extract<Block, { type: "table" }>;
  assert.deepEqual(table.align, ["left", "right"]);
  assert.deepEqual(strip(table.rows), [[[{ type: "text", text: "1" }], [{ type: "text", text: "2" }]]]);
  assert.equal(blocks[4].raw, "```ts\nconst a = 1;\n```");
});

test("inline: strong, em, del, code, links and escapes; snake_case is not emphasis", () => {
  assert.deepEqual(parseInline("**bold** and _it_ ~~gone~~ `x*y`"), [
    { type: "strong", children: [{ type: "text", text: "bold" }] }, { type: "text", text: " and " },
    { type: "em", children: [{ type: "text", text: "it" }] }, { type: "text", text: " " },
    { type: "del", children: [{ type: "text", text: "gone" }] }, { type: "text", text: " " }, { type: "code", text: "x*y" },
  ]);
  assert.deepEqual(parseInline("snake_case_name and 2 * 3 * 4"), [{ type: "text", text: "snake_case_name and 2 * 3 * 4" }]);
  assert.deepEqual(parseInline("\\*not em\\*"), [{ type: "text", text: "*not em*" }]);
  assert.deepEqual(parseInline("[docs](https://example.com/a?b=1) <mailto:a@b.co> see https://x.dev/p."), [
    { type: "link", href: "https://example.com/a?b=1", children: [{ type: "text", text: "docs" }] }, { type: "text", text: " " },
    { type: "link", href: "mailto:a@b.co", children: [{ type: "text", text: "a@b.co" }] }, { type: "text", text: " see " },
    { type: "link", href: "https://x.dev/p", children: [{ type: "text", text: "https://x.dev/p" }] }, { type: "text", text: "." },
  ]);
  assert.equal(inlineText(parseInline("**a** [b](https://c.d)")), "a b");
});

test("unsafe URLs are never links or images", () => {
  assert.equal(safeUrl("javascript:alert(1)"), null);
  assert.equal(safeUrl("data:text/html,x"), null);
  assert.equal(safeUrl("/relative"), null);
  assert.equal(safeUrl(" https://ok.dev "), "https://ok.dev");
  assert.deepEqual(parseInline("[click](javascript:alert(1))"), [{ type: "text", text: "click" }]);
  assert.deepEqual(parseInline("![x](data:image/png;base64,AAAA)"), [{ type: "text", text: "x" }]);
  assert.deepEqual(parseInline("<b>hi</b>"), [{ type: "text", text: "<b>hi</b>" }], "HTML stays text");
});

test("streaming: an open fence runs to the end, and open emphasis or code shows before it closes", () => {
  const fence = parseMarkdown("Here:\n```py\nprint(1)\nprint(", { streaming: true });
  assert.deepEqual(strip(fence[1]), { type: "code", lang: "py", text: "print(1)\nprint(", closed: false });
  assert.deepEqual(strip(parseMarkdown("This is **impor", { streaming: true })[0]), { type: "paragraph", children: [{ type: "text", text: "This is " }, { type: "strong", children: [{ type: "text", text: "impor" }] }] });
  assert.deepEqual(strip(parseMarkdown("Run `npm i", { streaming: true })[0]), { type: "paragraph", children: [{ type: "text", text: "Run " }, { type: "code", text: "npm i" }] });
  // Settled text keeps unmatched markers as they are; and only the last block is still being written.
  assert.deepEqual(strip(parseMarkdown("This is **impor")[0]), { type: "paragraph", children: [{ type: "text", text: "This is **impor" }] });
  assert.deepEqual(strip(parseMarkdown("a **b\n\nc", { streaming: true })[0]), { type: "paragraph", children: [{ type: "text", text: "a **b" }] });
  // A marker alone at the very end is not yet emphasis.
  assert.deepEqual(strip(parseMarkdown("list: *", { streaming: true })[0]), { type: "paragraph", children: [{ type: "text", text: "list: *" }] });
});

test("blocks keep their source, so unchanged ones can be skipped while the last one streams", () => {
  const first = parseMarkdown("Para one.\n\nPara tw", { streaming: true });
  const second = parseMarkdown("Para one.\n\nPara two", { streaming: true });
  assert.equal(first[0].raw, second[0].raw);
  assert.notEqual(first[1].raw, second[1].raw);
});
