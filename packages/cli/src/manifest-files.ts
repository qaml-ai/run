import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { DEFAULT_FILES, fromDocuments, parseManifests, type Manifest } from "./manifest.ts";

/** The manifest in `cwd`: agent.yaml, agent.yml or agent.json. */
export function findManifest(cwd = process.cwd()) {
  const found = DEFAULT_FILES.map(name => resolve(cwd, name)).find(path => existsSync(path));
  if (!found) throw new Error(`No manifest: expected one of ${DEFAULT_FILES.join(", ")} here, or pass a path (camelrun init writes one)`);
  return found;
}

/** Files a manifest at `path` names, read relative to it. */
export const filesBeside = (path: string) => (relative: string) => readFileSync(resolve(dirname(path), relative), "utf8");

/** The manifests in a file, with `${NAME}` read from `env` and the files they name read beside it. */
export function loadManifests(file: string, env: Record<string, string | undefined> = process.env): Manifest[] {
  const path = resolve(file);
  if (!existsSync(path)) throw new Error(`${file}: no such file`);
  const text = readFileSync(path, "utf8");
  const source = { env, readFile: filesBeside(path) };
  return extname(path) === ".json" ? fromDocuments([JSON.parse(text)], path, file, source) : parseManifests(text, file, source).map(manifest => ({ ...manifest, file: path }));
}
