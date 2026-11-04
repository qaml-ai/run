import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { createAgentHost } from "../src/agent-host.ts";
import { openPiStorage } from "../src/pi-durable/storage.ts";
import { inlineSandboxes } from "./inline-sandbox.ts";
import { callableFromCode, declaredToModel, normalizeTool } from "../src/protocol.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { CATALOG_LIMITS } from "../src/limits.ts";
import { validateDefinitions, validateToolCall, signature } from "../src/tool-policy.ts";
import { compose, defaultExposure, valueServer } from "../src/tool-servers.ts";

const tool = (name: string, description: string) => ({ name, description, parameters: { type: "object", properties: {} } });

test("a tool signature describes arguments and invalid calls say what is wrong", async () => {
  const refund = { name: "billing__refund_invoice", description: "Refund an invoice", parameters: {
    type: "object", additionalProperties: false, required: ["invoiceId", "lines"],
    properties: { invoiceId: { type: "string" }, amount: { type: "integer" }, mode: { enum: ["full", "partial"] }, lines: { type: "array", items: { type: "object", properties: { sku: { type: "string" }, meta: { type: "object", properties: { a: { type: "string" } } } } } },
      receipt: { anyOf: [{ type: "string", format: "uri" }, { type: "object", required: ["$file"], properties: { $file: { type: "string" } } }] }, note: { type: ["string", "null"] } },
  } };
  const input = '{ invoiceId: string, amount?: number, mode?: "full" | "partial", lines: { sku?: string, meta?: {…} }[], receipt?: string | { $file: string }, note?: string | null }';
  assert.equal(signature(refund.parameters), input);
  assert.equal(signature({ type: "object" }), "object");
  assert.throws(() => validateToolCall([refund], refund.name, { invoice: "INV-1", lines: [] }),
    { message: `Invalid arguments for tool: billing__refund_invoice: arguments must have required properties invoiceId; arguments must not have additional properties (invoice). It takes ${input}` });
});

test("catalogs of thousands respect definition limits and the direct tool budget", async () => {
  const big = Array.from({ length: 4000 }, (_, index) => ({ ...tool(`src${Math.floor(index / 50)}__op_${index}`, `Operation ${index} of source ${Math.floor(index / 50)}`), parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } }));
  validateDefinitions(big);
  assert.throws(() => validateDefinitions(Array.from({ length: CATALOG_LIMITS.tools + 1 }, (_, index) => tool(`t${index}`, ""))), /Too many tool definitions/);

  // 200 small sources would each be offered directly; only the first 64 tools are.
  const servers = Array.from({ length: 200 }, (_, index) => valueServer(defaultExposure([tool(`s${index}__only`, "One tool")]), async () => null));
  const { tools } = await compose(servers);
  assert.equal(tools.length, 200);
  assert.equal(tools.filter(entry => declaredToModel(entry)).length, CATALOG_LIMITS.direct);
  assert.equal(tools.at(-1)!.exposure, "both");
  assert.ok(tools.every(callableFromCode));

});

test("callers separate compatibility exposure, approval and model advertisement", async () => {
  for (const exposure of [undefined, "direct", "both", "codemode"] as const) {
    const normalized = normalizeTool({ ...tool("lookup", "Lookup"), exposure });
    assert.deepEqual(normalized.callers, exposure === "codemode" ? ["tools"] : ["model", "tools"]);
    assert.equal(declaredToModel(normalized), exposure !== "codemode");
    assert.equal(declaredToModel(normalized, false), true);
    assert.ok(callableFromCode(normalized));
    assert.deepEqual(normalizeTool(normalized), normalized, "normalization is idempotent");
  }
  for (const metadata of [{ needsApproval: true }, { judged: true }]) {
    assert.ok(callableFromCode({ ...tool("approve", "Approval"), ...metadata }));
  }
  const onlyCode = normalizeTool({ ...tool("code", "Code"), callers: ["tools"] });
  assert.equal(declaredToModel(onlyCode, false), false, "codeMode:false respects explicit callers");
  const onlyModel = normalizeTool({ ...tool("control", "Control"), callers: ["model"] });
  assert.equal(callableFromCode(onlyModel), false);
  const entries = Array.from({ length: CATALOG_LIMITS.direct + 1 }, (_, i) => ({ ...tool(`t${i}`, "Tool"), exposure: "both" as const }));
  const { tools } = await compose([valueServer([...entries, { ...tool("preferred", "Preferred"), exposure: "direct" }], async () => null)]);
  assert.equal(declaredToModel(tools.at(-2)!), false);
  assert.equal(declaredToModel(tools.at(-1)!), true, "direct is never dropped by the budget");
  assert.ok(tools.every(callableFromCode));
});

test("a large catalog is discoverable from code without advertising every tool to the model", async t => {
  const directory = await mkdtemp(join(tmpdir(), "tool-callers-"));
  const faux = registerFauxProvider({ tokensPerSecond: 1_000_000 });
  const storage = await openPiStorage({ sessionId: "catalog", directory });
  const calls: unknown[] = [];
  const host = createAgentHost({
    emit() {}, cancelTools: async () => null, runLimit: async () => undefined,
    legacyLog: { empty: async () => true }, piStorage: async () => storage,
    file: async () => { throw new Error("no files"); }, fs: async () => { throw new Error("no files"); },
    modelAuth: async () => { throw new Error("no credentials"); }, codeSandbox: inlineSandboxes(),
    tool: async (name, args) => { calls.push([name, args]); return { ok: true }; },
  });
  t.after(async () => { await host.dispose(); await storage.close(BACKGROUND_CONTEXT); faux.unregister(); await rm(directory, { recursive: true, force: true }); });
  const catalog = Array.from({ length: 4000 }, (_, index) => ({
    ...tool(`src${Math.floor(index / 50)}__op_${index}`, `Operation ${index}`), callers: ["tools"] as ("tools")[],
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  }));
  await host.handle("init", { id: "catalog", directory, model: faux.getModel(), apiKey: "fixture", tools: catalog });
  let advertised: string[] = [];
  let output = "";
  faux.setResponses([
    context => {
      advertised = getCurrentTools(context.messages).map(tool => tool.name);
      return fauxAssistantMessage(fauxToolCall("codemode", { code: `
        const found = await searchTools("op_3999", { namespace: "src79", limit: 1 });
        const description = await describeTool("src79__op_3999");
        const source = await describeNamespace("src79");
        const called = await tools.src79__op_3999({ id: "x" });
        return { count: ALL_TOOLS.length, found: found.map(tool => tool.name), description, source, called, missing: typeof await describeTool("nope") };` }), { stopReason: "toolUse" });
    },
    context => {
      const result = context.messages.findLast(message => message.role === "toolResult") as any;
      output = result.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
      return fauxAssistantMessage("done");
    },
  ]);
  const run = await host.handle("prompt", { text: "Find and call operation 3999" });
  assert.equal(run.error, null);
  assert.match(output, /Script completed/);
  const value = JSON.parse(output.slice(output.indexOf("Output:\n") + "Output:\n".length).trim());
  assert.equal(value.count, 4000);
  assert.deepEqual(value.found, ["src79__op_3999"]);
  assert.match(value.description, /id: string/);
  assert.equal(value.source.tools.length, 50);
  assert.deepEqual(value.called, { ok: true });
  assert.equal(value.missing, "undefined");

  assert.deepEqual(advertised, ["codemode"]);
  assert.deepEqual(calls, [["src79__op_3999", { id: "x" }]]);
});
