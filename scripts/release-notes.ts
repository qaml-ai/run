/**
 * Release notes are written a file per change, in docs/operations/unreleased/, so changes merged in any order never
 * conflict over one file. Each file has one or more `### <heading>` sections, its links relative to
 * docs/operations/. `npm run release-notes` prints them as one version's notes (sections of the same heading, from
 * several files, become one); `npm run release-notes -- <version> [<summary>]` writes them into
 * docs/operations/release-notes.md under `## <version> (runtime-v<version>, <today>)` and removes the files.
 */
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const operations = new URL("../docs/operations/", import.meta.url);
const unreleased = new URL("unreleased/", operations);

/** The fragments' sections, merged by heading in the order each heading first appears (files in name order). */
export function gather(fragments: { name: string; text: string }[]) {
  const sections = new Map<string, string[]>();
  for (const { name, text } of [...fragments].sort((a, b) => a.name.localeCompare(b.name))) {
    const parts = text.trim().split(/^(?=### )/m);
    if (!parts[0]!.startsWith("### ")) throw new Error(`${name}: begin with a "### <heading>" section`);
    for (const part of parts) {
      const [heading, ...body] = part.trimEnd().split("\n");
      sections.set(heading!, [...sections.get(heading!) ?? [], body.join("\n").trim()]);
    }
  }
  return [...sections].map(([heading, bodies]) => `${heading}\n\n${bodies.join("\n")}\n`).join("\n");
}

export function fragments() {
  return readdirSync(unreleased).filter(name => name.endsWith(".md")).map(name => ({ name, text: readFileSync(new URL(name, unreleased), "utf8") }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [version, summary] = process.argv.slice(2);
  const notes = gather(fragments());
  if (!version) process.stdout.write(notes);
  else {
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("The version is <major>.<minor>.<patch>");
    const file = new URL("release-notes.md", operations);
    const current = readFileSync(file, "utf8");
    const next = current.search(/^## \d/m);
    if (next < 0) throw new Error("No version heading to put the new one above");
    const heading = `## ${version} (runtime-v${version}, ${new Date().toISOString().slice(0, 10)})\n\n${summary ? `${summary}\n\n` : ""}`;
    writeFileSync(file, current.slice(0, next) + heading + notes + "\n" + current.slice(next));
    for (const { name } of fragments()) rmSync(new URL(name, unreleased));
  }
}
