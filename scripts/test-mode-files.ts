import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@babel/parser";

const root = fileURLToPath(new URL("..", import.meta.url));
export const allTestFiles = readdirSync(resolve(root, "tests")).filter(file => file.endsWith(".test.ts")).sort();
export const area = (file: string) => /sandbox|hosting|worker|v8-exec|codemode|runtime|node-in-process|loop-reliability/.test(file);
export const modeModules = new Set([
  "src/supervisor.ts", "src/node-config.ts", "src/agent-child.ts", "src/agent-host.ts", "src/rpc.ts",
  "src/codemode.ts", "src/sandbox.ts", "src/sandbox-wire.ts", "src/v8-exec.ts", "src/inspect-worker.ts",
  "src/child-stderr.ts", "src/parse-job.ts", "src/inspect.ts", "src/sandbox-probe.ts",
  "src/voice/media-worker.ts", "src/voice/media-host.ts", "src/voice/turns/inference-worker.ts",
]);

/** Conservative dependency graph: includes value imports, literal dynamic imports, worker/server
 * URLs, and source paths in spawn arguments. Computed path prefixes include their whole directory.
 * No dependency is excluded just because a test pins inline or does not execute it in one run. */
export function staticModeFiles(testFiles = allTestFiles, base = root, targets = modeModules): string[] {
  const graph = new Map<string, string[]>();
  function dependencies(file: string): string[] {
    if (graph.has(file)) return graph.get(file)!;
    const result = new Set<string>();
    const source = readFileSync(resolve(base, file), "utf8");
    const ast = parse(source, { sourceType: "unambiguous", plugins: ["typescript", "jsx"] });
    function add(value: string, prefix = false) {
      if (!/^(\.\.?\/|src\/|tests\/)/.test(value)) return;
      const path = resolve(base, dirname(file), value);
      const candidates = [path, `${path}.ts`, `${path}.tsx`, resolve(path, "index.ts"), path.replace(/\.js$/, ".ts")];
      for (const candidate of candidates) {
        const key = relative(base, candidate);
        if (!key.startsWith("..") && /\.(?:[cm]?js|tsx?)$/.test(key) && existsSync(candidate)) result.add(key);
      }
      if (prefix && existsSync(path) && !relative(base, path).startsWith("..")) {
        function walk(directory: string) {
          for (const entry of readdirSync(directory, { withFileTypes: true })) {
            if (["node_modules", ".git", "target", "dist", ".venv"].includes(entry.name)) continue;
            const next = resolve(directory, entry.name);
            if (entry.isDirectory()) walk(next);
            else if (entry.isFile() && /\.(?:[cm]?js|tsx?)$/.test(entry.name)) result.add(relative(base, next));
          }
        }
        walk(path);
      }
    }
    function visit(node: any) {
      if (!node || typeof node !== "object") return;
      if (node.type?.startsWith("TS")) { if (node.expression) visit(node.expression); return; }
      if (node.type === "ImportDeclaration" && (node.importKind === "type" || (node.specifiers.length && node.specifiers.every((item: any) => item.importKind === "type")))) return;
      if (node.type === "ExportNamedDeclaration" && node.exportKind === "type") return;
      if (node.type === "StringLiteral") add(node.value);
      if (node.type === "TemplateLiteral") {
        if (!node.expressions.length) add(node.quasis[0].value.cooked ?? "");
        else {
          const prefix = node.quasis[0].value.cooked ?? "";
          const directory = prefix.slice(0, prefix.lastIndexOf("/") + 1);
          if (directory) add(directory, true);
        }
      }
      for (const [key, value] of Object.entries(node)) {
        if (["loc", "start", "end", "comments", "tokens"].includes(key)) continue;
        if (Array.isArray(value)) value.forEach(visit);
        else if (value && typeof value === "object") visit(value);
      }
    }
    visit(ast);
    // A newly introduced hosting selector becomes a root automatically.
    if ((/AGENT_HOSTING|\bhosting\s*===|\.kind\s*===\s*["'](?:inline|process)["']/.test(source) || /sandbox|worker|v8-exec|codemode/.test(file)) && file.startsWith("src/")) targets.add(file);
    graph.set(file, [...result]);
    return [...result];
  }
  function reaches(file: string, seen = new Set<string>()): boolean {
    if (seen.has(file)) return false;
    seen.add(file);
    const deps = dependencies(file);
    return targets.has(file) || deps.some(dep => reaches(dep, seen));
  }
  return testFiles.filter(file => area(file) || reaches(`tests/${file}`));
}

export function sensitiveFiles(checkStatic = true): string[] {
  const manifest = JSON.parse(readFileSync(resolve(root, "tests/mode-sensitive.json"), "utf8")) as { files: string[] };
  const selected = new Set(manifest.files);
  const missing = checkStatic ? staticModeFiles().filter(file => !selected.has(file)) : [];
  const stale = manifest.files.filter(file => !allTestFiles.includes(file));
  if (missing.length || stale.length) throw new Error(`Review tests/mode-sensitive.json. Missing: ${missing.join(", ")}; stale: ${stale.join(", ")}`);
  return allTestFiles.filter(file => selected.has(file));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = process.argv.includes("--derive") ? staticModeFiles() : sensitiveFiles();
  console.log(JSON.stringify(files, null, 2));
}
