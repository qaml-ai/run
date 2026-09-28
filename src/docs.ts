import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** The origin the docs are written for; a runtime elsewhere serves them pointing at itself. */
const DOCS_ORIGIN = "https://agents.camelai.dev";

/**
 * The public docs, read once at startup from `directory` (docs/ in the image): `/llms.txt` and
 * `/llms-full.txt` (text/plain), and every Markdown page at `/docs/<its path>` (text/markdown), but
 * the operators' own (operations/). Only these exact paths are served, so nothing else is reachable.
 */
export function loadDocs(directory: string, publicUrl: string): Map<string, { body: string; type: string }> {
  const served = new Map<string, { body: string; type: string }>();
  const own = (text: string) => publicUrl === DOCS_ORIGIN ? text : text.replaceAll(DOCS_ORIGIN, publicUrl);
  const walk = (dir: string) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      const shown = relative(directory, path).split(sep).join("/");
      if (entry.isDirectory()) { if (shown !== "operations") walk(path); }
      else if (entry.isFile() && shown.endsWith(".md")) served.set(`/docs/${shown}`, { body: own(readFileSync(path, "utf8")), type: "text/markdown; charset=utf-8" });
    }
  };
  walk(directory);
  for (const name of ["llms.txt", "llms-full.txt"]) {
    try { served.set(`/${name}`, { body: own(readFileSync(join(directory, name), "utf8")), type: "text/plain; charset=utf-8" }); } catch { /* not built in */ }
  }
  return served;
}

/**
 * The UI registry (shadcn's format), read once at startup from `directory`: each `<name>.json` at
 * `/r/<name>.json`, with the docs' origin rewritten as theirs is, so a registry's links to its own
 * items point at this runtime.
 */
export function loadRegistry(directory: string, publicUrl: string): Map<string, { body: string; type: string }> {
  const served = new Map<string, { body: string; type: string }>();
  let entries;
  try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return served; }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const text = readFileSync(join(directory, entry.name), "utf8");
    served.set(`/r/${entry.name}`, { body: publicUrl === DOCS_ORIGIN ? text : text.replaceAll(DOCS_ORIGIN, publicUrl), type: "application/json; charset=utf-8" });
  }
  return served;
}
