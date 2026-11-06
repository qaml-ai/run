/**
 * Report (or, with --write, fix) ported cases whose source line moved: each case names `tests/<file>:<line>` and the
 * original test's title, so a moved test is found by its title. Cases whose source test is gone, or whose title is not
 * unique, are reported for a person to port.
 */
import { readFile, readdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { parse } from "@babel/parser";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const parseFile = text => parse(text, { sourceType: "module", plugins: ["typescript"] });
function calls(node, found = []) {
  if (!node || typeof node !== "object") return found;
  if (node.type === "CallExpression") found.push(node);
  for (const [key, value] of Object.entries(node)) if (key !== "loc") {
    if (Array.isArray(value)) for (const child of value) calls(child, found);
    else calls(value, found);
  }
  return found;
}
const title = (node, text) => node?.type === "StringLiteral" ? node.value : node?.type === "TemplateLiteral" && !node.expressions.length ? node.quasis[0].value.cooked : node && text.slice(node.start, node.end);
const write = process.argv.includes("--write");
const sources = new Map();
async function source(path) {
  if (!sources.has(path)) {
    const text = await readFile(resolve(root, path), "utf8").catch(() => undefined);
    sources.set(path, text === undefined ? undefined : calls(parseFile(text).program).filter(node => node.callee?.name === "test").map(node => ({ line: node.loc.start.line, name: title(node.arguments[0], text) })));
  }
  return sources.get(path);
}
let moved = 0, missing = 0;
for (const file of (await readdir(resolve(root, "tests/contract/areas"))).filter(name => name.endsWith(".test.ts"))) {
  const path = resolve(root, "tests/contract/areas", file);
  let text = await readFile(path, "utf8");
  const edits = [];
  for (const call of calls(parseFile(text).program)) {
    const direct = call?.callee?.name === "contractTest";
    const ported = call?.callee?.type === "CallExpression" && call.callee.callee?.name === "portedTest";
    if (!direct && !ported) continue;
    const args = (direct ? call : call.callee).arguments;
    const sourceArgument = args[1], nameArgument = direct ? args[2] : call.arguments[0];
    if (sourceArgument?.type !== "StringLiteral" || !/:\d+$/.test(sourceArgument.value)) continue;
    const name = title(nameArgument, text);
    const at = sourceArgument.value.lastIndexOf(":"), from = sourceArgument.value.slice(0, at), line = Number(sourceArgument.value.slice(at + 1));
    const tests = await source(from);
    if (!tests) { console.log(`MISSING FILE ${file}: ${sourceArgument.value} ${name}`); missing++; continue; }
    if (tests.some(test => test.line === line && (name === undefined || test.name === name))) continue;
    const named = tests.filter(test => test.name === name);
    if (named.length !== 1) { console.log(`MISSING ${file}: ${sourceArgument.value} ${JSON.stringify(name)}`); missing++; continue; }
    console.log(`MOVED ${file}: ${sourceArgument.value} -> ${named[0].line}`);
    moved++;
    edits.push({ start: sourceArgument.start, end: sourceArgument.end, text: JSON.stringify(`${from}:${named[0].line}`) });
  }
  if (write && edits.length) {
    for (const edit of edits.sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
    await writeFile(path, text);
  }
}
console.log(`${moved} moved, ${missing} missing${write ? " (moved ones relinked)" : ""}`);
