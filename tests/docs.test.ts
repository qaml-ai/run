import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { llmsFullTxt, llmsTxt, PAGES } from "../scripts/docs.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const markdown = (directory: string): string[] => readdirSync(join(root, directory)).flatMap(name => {
  const path = join(directory, name);
  return statSync(join(root, path)).isDirectory() ? markdown(path) : name.endsWith(".md") ? [path] : [];
});
const pages = [...markdown("docs"), "README.md", "clients/README.md", "sdk/README.md", "clients/python/README.md"];

test("the committed llms.txt and llms-full.txt are current (npm run docs regenerates them)", () => {
  assert.equal(readFileSync(join(root, "docs/llms.txt"), "utf8"), llmsTxt());
  assert.equal(readFileSync(join(root, "docs/llms-full.txt"), "utf8"), llmsFullTxt());
});

test("llms.txt lists every user-facing page, and only those", () => {
  const listed = new Set(PAGES.map(page => page.path));
  const user = markdown("docs").map(path => relative("docs", path)).filter(path => !path.startsWith("operations/") && path !== "README.md");
  assert.deepEqual([...listed].sort(), user.sort());
});

test("every relative link in the docs resolves, to a file and a heading", () => {
  // GitHub's anchors: a heading's text, lower case, punctuation dropped, spaces as hyphens; and explicit <a id>s.
  const anchors = (path: string) => {
    const text = readFileSync(join(root, path), "utf8");
    return new Set([
      ...[...text.matchAll(/^#+ (.+)$/gm)].map(([, heading]) => heading.toLowerCase().replace(/[`*_]/g, "").replace(/[^\p{L}\p{N} -]/gu, "").trim().replace(/ /g, "-")),
      ...[...text.matchAll(/<a id="([^"]+)"/g)].map(([, id]) => id),
    ]);
  };
  const broken: string[] = [];
  for (const page of pages) {
    const text = readFileSync(join(root, page), "utf8").replace(/```[\s\S]*?```/g, "");
    for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^(https?:|mailto:)/.test(target)) continue;
      const [path, anchor] = target.split("#");
      const file = path ? join(dirname(page), path) : page;
      if (!existsSync(join(root, file))) { broken.push(`${page}: ${target}`); continue; }
      if (anchor && file.endsWith(".md") && !anchors(file).has(anchor)) broken.push(`${page}: ${target} (no such heading)`);
    }
  }
  assert.deepEqual(broken, []);
});
