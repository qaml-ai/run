import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { parse } from "@babel/parser";

const PURE_PACKAGES = new Set(["zod", "postal-mime", "tldts"]);
const NODE_GLOBALS = new Set(["Buffer", "process", "global", "NodeJS", "require", "__dirname", "__filename", "setImmediate", "clearImmediate"]);
const within = (root: string, path: string) => {
  const part = relative(root, path);
  return !isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`);
};

type AstNode = { type?: unknown; loc?: { start: { line: number } }; [key: string]: unknown };
const astNode = (value: unknown): AstNode | undefined => value !== null && typeof value === "object" ? value as AstNode : undefined;

async function relativeModule(file: string, specifier: string): Promise<string | undefined> {
  const target = resolve(dirname(file), specifier);
  const suffixes = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
  const mapped = target.replace(/\.([cm]?)js(x?)$/, ".$1ts$2");
  const candidates = /\.[cm]?[jt]sx?$/.test(target)
    ? [...new Set([target, mapped])]
    : [target, ...suffixes.map(suffix => target + suffix), ...suffixes.map(suffix => resolve(target, "index" + suffix))];
  for (const candidate of candidates) {
    try { if ((await stat(candidate)).isFile()) return await realpath(candidate); }
    catch (error) { if ((error as { code?: string }).code !== "ENOENT" && (error as { code?: string }).code !== "ENOTDIR") throw error; }
  }
}

/** Check all syntax, including imports that TypeScript erases and esbuild would tree-shake away. */
export async function coreViolations(file: string, text: string, root: string): Promise<string[]> {
  const source = parse(text, { sourceType: "module", plugins: /\.[jt]sx$/.test(file) ? ["typescript", "jsx"] : ["typescript"], createImportExpressions: true });
  const errors: string[] = [], imports: { node: AstNode; specifier: string }[] = [];
  const fail = (node: AstNode, message: string) => errors.push(`${file}:${node.loc?.start.line ?? 1}: ${message}`);
  const module = (node: AstNode, value: unknown) => {
    const literal = astNode(value);
    if (literal?.type === "StringLiteral" && typeof literal.value === "string") imports.push({ node, specifier: literal.value });
    else fail(node, "core imports must be string literals");
  };
  if (source.comments?.some(comment => comment.type === "CommentLine" && /^\/\s*<reference\b/.test(comment.value)))
    errors.push(`${file}: triple-slash references are not allowed in core`);
  const visit = (value: unknown) => {
    if (Array.isArray(value)) { for (const child of value) visit(child); return; }
    const node = astNode(value);
    if (!node) return;
    if (node.type === "ImportDeclaration" || (node.type === "ExportNamedDeclaration" || node.type === "ExportAllDeclaration") && node.source) module(node, node.source);
    if (node.type === "TSImportEqualsDeclaration") fail(node, "import assignments are not allowed in core");
    if (node.type === "TSImportType") module(node, node.argument);
    if (node.type === "ImportExpression") module(node, node.source);
    if (node.type === "CallExpression" && astNode(node.callee)?.type === "Import") module(node, (node.arguments as unknown[])[0]);
    if (node.type === "Identifier" && typeof node.name === "string" && NODE_GLOBALS.has(node.name)) fail(node, `${node.name} is not allowed in core`);
    const property = astNode(node.property);
    if ((node.type === "MemberExpression" || node.type === "OptionalMemberExpression") && node.computed && property?.type === "StringLiteral" && typeof property.value === "string" && NODE_GLOBALS.has(property.value))
      fail(node, `${property.value} is not allowed in core`);
    for (const child of Object.values(node)) visit(child);
  };
  visit(source);
  const realRoot = await realpath(root);
  for (const { node, specifier } of imports) {
    if (PURE_PACKAGES.has(specifier)) continue;
    if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
      fail(node, `disallowed core import: ${specifier}`);
      continue;
    }
    const found = await relativeModule(file, specifier);
    if (!found || !within(realRoot, found)) fail(node, `import leaves core or does not resolve: ${specifier}`);
  }
  return errors;
}

export async function coreFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Core modules must not be symlinks: ${path}`);
    if (entry.isDirectory()) files.push(...await coreFiles(path));
    else if (/\.[cm]?[jt]sx?$/.test(entry.name)) files.push(path);
  }
  return files.sort();
}

async function checkCore() {
  const root = fileURLToPath(new URL("../src/core/", import.meta.url));
  const files = await coreFiles(root);
  const errors = (await Promise.all(files.map(async file => coreViolations(file, await readFile(file, "utf8"), root)))).flat();
  if (errors.length) throw new Error(`Core boundary violations:\n${errors.join("\n")}`);
  await build({
    entryPoints: files.filter(file => !file.endsWith(".d.ts")),
    bundle: true, platform: "neutral", format: "esm", target: "es2024", write: false,
    outdir: "core-check", logLevel: "silent",
  });
  console.log(`Core boundary and neutral bundles passed (${files.length} modules)`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await checkCore();
