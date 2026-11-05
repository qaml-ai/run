import { readdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import ts from "typescript";

const PURE_PACKAGES = new Set(["zod"]);
const NODE_GLOBALS = new Set(["Buffer", "process", "global", "NodeJS", "require", "__dirname", "__filename", "setImmediate", "clearImmediate"]);
const within = (root: string, path: string) => {
  const part = relative(root, path);
  return !isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`);
};

/** Check all syntax, including imports that TypeScript erases and esbuild would tree-shake away. */
export async function coreViolations(file: string, text: string, root: string): Promise<string[]> {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const errors: string[] = [], imports: { node: ts.Node; specifier: string }[] = [];
  const fail = (node: ts.Node, message: string) => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    errors.push(`${file}:${line + 1}: ${message}`);
  };
  const module = (node: ts.Node, value: ts.Node | undefined) => {
    if (value && ts.isStringLiteralLike(value)) imports.push({ node, specifier: value.text });
    else fail(node, "core imports must be string literals");
  };
  if (source.typeReferenceDirectives.length || source.referencedFiles.length || source.libReferenceDirectives.length)
    errors.push(`${file}: triple-slash references are not allowed in core`);
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) && node.moduleSpecifier) module(node, node.moduleSpecifier);
    if (ts.isImportEqualsDeclaration(node)) fail(node, "import assignments are not allowed in core");
    if (ts.isImportTypeNode(node)) module(node, ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) module(node, node.arguments[0]);
    if (ts.isIdentifier(node) && NODE_GLOBALS.has(node.text)) fail(node, `${node.text} is not allowed in core`);
    if (ts.isElementAccessExpression(node) && node.argumentExpression && ts.isStringLiteralLike(node.argumentExpression) && NODE_GLOBALS.has(node.argumentExpression.text))
      fail(node, `${node.argumentExpression.text} is not allowed in core`);
    ts.forEachChild(node, visit);
  };
  visit(source);
  const realRoot = await realpath(root);
  for (const { node, specifier } of imports) {
    if (PURE_PACKAGES.has(specifier)) continue;
    if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
      fail(node, `disallowed core import: ${specifier}`);
      continue;
    }
    const found = ts.resolveModuleName(specifier, file, { moduleResolution: ts.ModuleResolutionKind.Bundler }, ts.sys).resolvedModule;
    if (!found || !within(realRoot, await realpath(found.resolvedFileName))) fail(node, `import leaves core or does not resolve: ${specifier}`);
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
