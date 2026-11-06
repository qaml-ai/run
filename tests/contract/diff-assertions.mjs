/** Show, for one ported case, the original's public assertions next to the port's: `node diff-assertions.mjs <area file> <tests/x.test.ts:line>`. */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { parse } from "@babel/parser";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const parseFile = text => parse(text, { sourceType: "module", plugins: ["typescript"] });
function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  visit(node);
  for (const [key, value] of Object.entries(node)) if (key !== "loc") {
    if (Array.isArray(value)) for (const child of value) walk(child, visit);
    else walk(value, visit);
  }
}
const assertions = (node, text) => { const found = []; walk(node, n => { if (n.type === "CallExpression" && n.callee.type === "MemberExpression" && n.callee.object?.name === "assert") found.push(text.slice(n.start, n.end)); }); return found; };
const [file, source] = process.argv.slice(2);
const portText = await readFile(resolve(root, "tests/contract/areas", file), "utf8");
let port;
walk(parseFile(portText).program, n => {
  if (n.type !== "CallExpression") return;
  const direct = n.callee?.name === "contractTest", ported = n.callee?.type === "CallExpression" && n.callee.callee?.name === "portedTest";
  if (!direct && !ported) return;
  if ((direct ? n : n.callee).arguments[1]?.value === source) port = direct ? n.arguments[3] : n.arguments.at(-1);
});
const at = source.lastIndexOf(":"), path = source.slice(0, at), line = Number(source.slice(at + 1));
const originalText = await readFile(resolve(root, path), "utf8");
let original;
walk(parseFile(originalText).program, n => { if (n.type === "CallExpression" && n.callee?.name === "test" && n.loc.start.line === line) original = n.arguments.at(-1); });
const a = assertions(original, originalText), b = assertions(port, portText);
for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) console.log(`#${i}\n  original: ${a[i]}\n  port:     ${b[i]}`);
