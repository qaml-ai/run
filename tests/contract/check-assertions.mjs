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
  "docs.test.ts", "webmcp.test.ts", "ops-mcp.test.ts", "admin-site.test.ts",
  "data-collection.test.ts", "judged-approval.test.ts", "reasoning.test.ts", "deepseek-replay.test.ts", "content-filter-fallback.test.ts", "runs-stall.test.ts", "runs-busy-limit.test.ts", "runs-messages-at-end.test.ts", "end-user-usage.test.ts",
  "workflows.test.ts", "default-model.test.ts", "model-endpoints.test.ts", "model-pricing-trust.test.ts", "inline-mcp-servers.test.ts", "mcp.test.ts", "virtual-models.test.ts",
  "agent-language.test.ts", "agent-lifetime.test.ts", "agent-links.test.ts", "agent-mcp.test.ts", "agent-progress.test.ts", "background-agents.test.ts", "attach.test.ts", "browser-tokens.test.ts", "builtins.test.ts", "context-reset.test.ts", "history-formats.test.ts", "history-none-ignored.test.ts", "idempotency.test.ts", "model-settings.test.ts", "multi-agent.test.ts", "prompt-options.test.ts", "run-limits.test.ts", "sender.test.ts", "tool-calls.test.ts", "tool-spawn.test.ts", "tool-streaming.test.ts", "tenant-reads.test.ts",
  "agents-upsert.test.ts", "agents.test.ts", "agents-list.test.ts", "history-pages.test.ts", "structured-output.test.ts",
  "agent-fork.test.ts", "agent-messaging.test.ts", "sdk-multi-agent.test.ts", "errors.test.ts", "human-input.test.ts", "schedule-api.test.ts", "stream-deltas.test.ts",
  "history-import.test.ts", "api.test.ts", "decisions-api.test.ts", "runs.test.ts", "request-wait.test.ts", "definitions.test.ts", "service-api.test.ts",
]);
// These checks observe implementation storage or pure Node policy, not the public HTTP contract.
const implementationOnly = expectation => [
  "r.logs.some(", "mayAnswer(input,", "r.db.query(", "slow.db.query(", "Number(cursor.reserved_cursor)",
  "await identity(", "await thinking(", "existsSync(", "assert.deepEqual(row,", "saved.config.initialMessages",
  "'requests' in saved", "readFile(join(f.root", "JSON.stringify(saved)", "header.tenant", "JSON.stringify(header)",
  "ignored(r.logs,", "rows.map((row: any) => row.child)", "Math.abs(row.budget", "kept.rows[0].count",
  "assert.deepEqual(rows,", "assert.equal(entries.length", "entries[0].model[0].content", "await owner()",
  "fallback?.From", "attemptRows.", "await holds()", "rows.map(row => [row.model", "assert.equal(superseded,",
  "assert.equal(usage[0].Model,",
].some(fragment => expectation.includes(fragment));
// The decisions webhook is delivered to a local HTTP receiver instead of reading Node's SQL outbox.
const normalize = expectation => expectation.replace('url: "https://hooks.example.test/usage"', 'url: webhook + "/usage"').replaceAll('saved.config.systemPrompt', 'saved.systemPrompt').replaceAll('saved.config.thinkingLevel', 'r.model.bodies.at(-1).reasoning?.effort').replaceAll('saved.definitions', 'saved.tools');
let cases = 0, checked = 0;
for (const file of await readdir(resolve(root, "tests/contract/areas"))) {
  if (!file.endsWith(".contract.test.ts")) continue;
  const text = await readFile(resolve(root, "tests/contract/areas", file), "utf8");
  for (const statement of parseFile(text).program.body) {
    const call = statement.expression;
    const direct = call?.callee?.name === "contractTest";
    const ported = call?.callee?.type === "CallExpression" && call.callee.callee?.name === "portedTest";
    if (!direct && !ported) continue;
    const sourceArgument = (direct ? call : call.callee).arguments[1];
    if (sourceArgument?.type !== "StringLiteral") continue;
    const source = sourceArgument.value;
    const split = source.lastIndexOf(":"), path = source.slice(0, split), line = Number(source.slice(split + 1));
    if (!sources.has(path.replace(/^tests\//, "")) || !Number.isFinite(line)) continue;
    const original = await readFile(resolve(root, path), "utf8");
    const originalTest = parseFile(original).program.body.find(node => node.loc.start.line === line && node.expression?.callee?.name === "test");
    if (!originalTest) throw new Error(`${file}: missing source case ${source}`);
    // This corruption-recovery case deliberately retains its original diagnostic-derived estimate checks.
    const keepDiagnostics = source === "tests/model-pricing-trust.test.ts:51";
    const expected = assertions(originalTest.expression.arguments.at(-1), original).filter(value => keepDiagnostics || !implementationOnly(value)).map(normalize);
    const actual = assertions(direct ? call.arguments[3] : call.arguments.at(-1), text);
    if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error(`${file}: assertions differ from ${source}`);
    cases++; checked += actual.length;
  }
}
console.log(`${cases} ported cases retain ${checked} original public assertions.`);
