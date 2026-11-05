/** Check that ported expectations still match the original public contract assertions. */
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { parse } from "@babel/parser";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const parseFile = text => parse(text, { sourceType: "module", plugins: ["typescript"] });
function assertions(node, text, found = []) {
  if (!node || typeof node !== "object") return found;
  if (node.type === "CallExpression" && node.callee.type === "MemberExpression" && node.callee.object?.name === "assert") found.push(text.slice(node.start, node.end));
  for (const [key, value] of Object.entries(node)) if (key !== "loc") {
    if (Array.isArray(value)) for (const child of value) assertions(child, text, found);
    else assertions(value, text, found);
  }
  return found;
}
const sources = new Set([
  "agents-upsert.test.ts", "agents.test.ts", "agents-list.test.ts", "history-pages.test.ts", "structured-output.test.ts",
  "agent-fork.test.ts", "agent-messaging.test.ts", "sdk-multi-agent.test.ts", "errors.test.ts", "human-input.test.ts", "schedule-api.test.ts", "stream-deltas.test.ts",
  "api.test.ts", "decisions-api.test.ts",
]);
const implementationOnly = expectation => expectation.startsWith("assert.ok(r.logs.some(") || expectation.startsWith("assert.ok(!r.logs.some(") || expectation.includes("mayAnswer(input,") || expectation.includes('r.db.query("select input from agent_inputs")');
// The decisions webhook is delivered to a local HTTP receiver instead of reading Node's SQL outbox.
const normalize = expectation => expectation.replace('url: "https://hooks.example.test/usage"', 'url: webhook + "/usage"');
let cases = 0, checked = 0;
for (const file of await readdir(resolve(root, "tests/contract/areas"))) {
  if (!file.endsWith(".contract.test.ts")) continue;
  const text = await readFile(resolve(root, "tests/contract/areas", file), "utf8");
  for (const statement of parseFile(text).program.body) {
    const call = statement.expression;
    if (call?.callee?.name !== "contractTest" || call.arguments[1]?.type !== "StringLiteral") continue;
    const source = call.arguments[1].value;
    const split = source.lastIndexOf(":"), path = source.slice(0, split), line = Number(source.slice(split + 1));
    if (!sources.has(path.replace(/^tests\//, "")) || !Number.isFinite(line)) continue;
    const original = await readFile(resolve(root, path), "utf8");
    const originalTest = parseFile(original).program.body.find(node => node.loc.start.line === line && node.expression?.callee?.name === "test");
    if (!originalTest) throw new Error(`${file}: missing source case ${source}`);
    const expected = assertions(originalTest.expression.arguments.at(-1), original).filter(value => !implementationOnly(value)).map(normalize);
    const actual = assertions(call.arguments[3], text);
    if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error(`${file}: assertions differ from ${source}`);
    cases++; checked += actual.length;
  }
}
console.log(`${cases} ported cases retain ${checked} original public assertions.`);
