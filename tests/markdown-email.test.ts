import { test } from "node:test";
import assert from "node:assert/strict";
import { markdownEmail } from "../src/markdown-email.ts";
test("report email renders Markdown headings, tables, lists and safe source links", () => {
 const html=markdownEmail('# Report\n\n**Summary** and *context*.\n\n- One\n- Two\n\n| Source | Value |\n| --- | ---: |\n| Filing | 10 |\n\n[SEC](https://sec.gov/?a=1&b=2)');
 for(const tag of ['<h1','<strong>Summary</strong>','<em>context</em>','<ul','<li>','<table','<th','href="https://sec.gov/?a=1&amp;b=2"'])assert.ok(html.includes(tag),tag);
});
test("model HTML is escaped, dangerous links are inactive, and images do not load", () => {
 const html=markdownEmail('<script>alert(1)</script>\n\n[bad](javascript:alert(1))\n\n![tracking](https://example.com/pixel)\n\n`<b>`');
 assert.ok(html.includes('&lt;script&gt;'));
 assert.ok(!html.includes('<script>'));
 assert.ok(!html.includes('href="javascript:'));
 assert.ok(!html.includes('<img'));
 assert.ok(html.includes('href="https://example.com/pixel"'));
 assert.ok(html.includes('&lt;b&gt;'));
});
