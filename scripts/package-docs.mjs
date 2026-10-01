#!/usr/bin/env node
/**
 * The docs a package ships for coding agents, matching its version: `SKILL.md` (docs/SKILL.md, served at /SKILL.md)
 * and `sdk.md` (docs/reference/sdk.md), written to the directory given, with links made absolute: to the served docs,
 * or to the repository for files outside docs/ (examples).
 * The SDK packages run it when they build: `node scripts/package-docs.mjs sdk/docs`.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { posix } from "node:path";

const DOCS_URL = "https://run.camelai.com/docs/";
const REPOSITORY_URL = "https://github.com/qaml-ai/run/blob/main/";
const [out] = process.argv.slice(2);
if (!out) { console.error("Usage: node scripts/package-docs.mjs <directory>"); process.exit(1); }
const docs = new URL("../docs/", import.meta.url);
mkdirSync(out, { recursive: true });
for (const [page, name] of [["SKILL.md", "SKILL.md"], ["reference/sdk.md", "sdk.md"]]) {
  const text = readFileSync(new URL(page, docs), "utf8")
    .replace(/\]\((?!https?:|#|mailto:)([^)\s]+)\)/g, (_, link) => {
      const path = posix.normalize(posix.join(posix.dirname(page), link));
      return `](${path.startsWith("../") ? REPOSITORY_URL + path.slice(3) : DOCS_URL + path})`;
    });
  writeFileSync(posix.join(out, name), text);
}
