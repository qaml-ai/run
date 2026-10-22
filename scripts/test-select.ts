import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@babel/parser";

// Host lifecycle, sandbox execution, provider errors, history and configuration.
// Together these take about ten seconds in the checked-in process timings.
export const SMOKE = ["agent-host", "code-executor", "model-errors", "history", "config"].map(name => `tests/${name}.test.ts`);
export type Selection = { files: string[]; full: boolean; reason: string };

export function selectTests(root: string, changed: string[]): Selection {
  const sources = new Map<string, string>();
  function walk(dir: string) {
    if (!existsSync(join(root, dir))) return;
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (path.endsWith(".ts")) sources.set(path, readFileSync(join(root, path), "utf8"));
    }
  }
  for (const dir of ["src", "shared", "clients", "tests"]) walk(dir);
  const tests = [...sources.keys()].filter(path => /^tests\/[^/]+\.test\.ts$/.test(path)).sort();
  const full = (reason: string): Selection => ({ files: tests, full: true, reason });
  if (!changed.length) return full("empty diff");
  const broad = /^(?:package(?:-lock)?\.json$|(?:.*\/)?tsconfig[^/]*|scripts\/test-[^/]*\.ts$|migrations\/|\.github\/|sandbox\/|Dockerfile$|tests\/(?![^/]+\.test\.ts$).*\.ts$)/;
  if (changed.some(path => broad.test(path))) return full("shared test or build infrastructure changed");
  // Changes outside this graph can load code through other means (plugins, generated assets, etc.).
  if (changed.some(path => !/^(src|shared|clients|tests)\/.*\.ts$/.test(path))) return full("change outside TypeScript import graph");

  const reverse = new Map<string, Set<string>>();
  for (const [path, source] of sources) {
    const ast = parse(source, { sourceType: "module", plugins: ["typescript"], createImportExpressions: true });
    const add = (specifier: string) => {
      if (!specifier.startsWith(".")) return;
      const target = relative(root, resolve(root, dirname(path), specifier)).replaceAll("\\", "/");
      const candidates = /\.[cm]?[jt]s$/.test(target)
        ? [target, target.replace(/\.[cm]?js$/, ".ts")]
        : [target + ".ts", target + "/index.ts"];
      // Keep missing targets too: deleting or renaming an imported module must select its callers.
      for (const dependency of candidates) {
        const callers = reverse.get(dependency) ?? new Set<string>();
        callers.add(path);
        reverse.set(dependency, callers);
      }
    };
    function visit(value: unknown) {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) { for (const child of value) visit(child); return; }
      const node = value as Record<string, unknown>;
      const literal = (value: unknown) => {
        if (value && typeof value === "object" && "type" in value && value.type === "StringLiteral" && "value" in value && typeof value.value === "string") add(value.value);
      };
      if (["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration", "ImportExpression"].includes(String(node.type))) literal(node.source);
      if (node.type === "TSImportType") literal(node.argument);
      if (node.type === "CallExpression") {
        const callee = node.callee as Record<string, unknown>;
        if (callee.type === "Import" || (callee.type === "Identifier" && callee.name === "require")) literal((node.arguments as unknown[])[0]);
      }
      for (const child of Object.values(node)) visit(child);
    }
    visit(ast);
  }
  const affected = new Set(changed);
  const queue = [...changed];
  for (const path of queue) for (const caller of reverse.get(path) ?? []) {
    if (!affected.has(caller)) { affected.add(caller); queue.push(caller); }
  }
  if (changed.some(path => !sources.has(path) && !reverse.has(path))) return full("unmapped or deleted source");
  const smoke = new Set(SMOKE);
  const files = tests.filter(path => affected.has(path) || smoke.has(path));
  if (files.length > tests.length * 0.4) return full("selection exceeds 40% of test files");
  return { files, full: false, reason: "transitive imports plus smoke tests" };
}

function git(root: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr}`);
  return result.stdout.trimEnd();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.cwd();
  const run = process.argv.includes("--run");
  const baseArg = process.argv.indexOf("--base");
  const base = baseArg >= 0 ? process.argv[baseArg + 1] : git(root, ["merge-base", "origin/main", "HEAD"]);
  if (!base) throw new Error("Missing --base revision");
  const headArg = process.argv.indexOf("--head");
  const head = headArg >= 0 ? process.argv[headArg + 1] : "HEAD";
  // Local iteration includes tracked working-tree edits; CI compares the event revisions.
  const revisions = run && headArg < 0 ? [base] : [`${base}...${head}`];
  const changed = git(root, ["diff", "--no-renames", "--name-only", "-z", ...revisions]).split("\0").filter(Boolean);
  const selection = selectTests(root, changed);
  if (!run) console.log(JSON.stringify(selection));
  else {
    const hosting = process.env.AGENT_HOSTING ?? "process";
    if (hosting !== "process" && hosting !== "inline") throw new Error("AGENT_HOSTING must be process or inline");
    console.log(`# ${selection.reason}: ${selection.files.length} files (${hosting} hosting)`);
    mkdirSync("test-timings", { recursive: true });
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "--test-timeout=240000", fileURLToPath(new URL("test-files.ts", import.meta.url)), "test-timings/affected.json", "test-timings/affected.failed", ...selection.files], {
      cwd: root, stdio: "inherit", env: { ...process.env, AGENT_HOSTING: hosting },
    });
    process.exitCode = result.status ?? 1;
  }
}
