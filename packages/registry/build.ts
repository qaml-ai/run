/**
 * Builds the shadcn registry: public/r/<item>.json for each item in registry.json, with its files'
 * contents inlined, and public/r/registry.json listing them. `--check` fails if the built files are stale.
 *   node --experimental-strip-types packages/registry/build.ts [--check]
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("./", import.meta.url);
const out = new URL("public/r/", root);
const registry = JSON.parse(readFileSync(new URL("registry.json", root), "utf8"));
const check = process.argv.includes("--check");
const outputs = new Map<string, string>();
for (const item of registry.items) {
  const files = item.files.map((file: { path: string }) => ({ ...file, content: readFileSync(new URL(file.path, root), "utf8") }));
  outputs.set(`${item.name}.json`, `${JSON.stringify({ $schema: "https://ui.shadcn.com/schema/registry-item.json", ...item, files }, null, 2)}\n`);
}
outputs.set("registry.json", `${JSON.stringify(registry, null, 2)}\n`);
let stale = 0;
mkdirSync(out, { recursive: true });
for (const [name, text] of outputs) {
  const path = fileURLToPath(new URL(name, out));
  if (check) { if (!existsSync(path) || readFileSync(path, "utf8") !== text) { console.error(`stale: ${path}`); stale++; } }
  else writeFileSync(path, text);
}
if (stale) { console.error("Run: node --experimental-strip-types packages/registry/build.ts"); process.exit(1); }
