import assert from "node:assert/strict";
import test from "node:test";
import { agentMediaTools, flushAgentMediaUsage, type AgentMediaScope } from "../src/agent-media.ts";
import { GENERATE_IMAGE, Imager, type ImageProvider } from "../src/media/images.ts";
import { pngBytes } from "../../../tests/file-fixtures.ts";

const scope: AgentMediaScope = { tenant: "tenant", agent: "agent", requestId: "run", builtins: ["generate_image"], mounts: [], budget: 1, identity: { subject: "person", context: { project: "fixture" } }, actor: "operator", keyScope: "keys" };
const execute = (tool: any, args: unknown) => tool.execute(args, { conversationId: "conversation", taskId: "task", callId: "call" }, { abortSignal: new AbortController().signal });
function setup(extra: any = {}, context: AgentMediaScope = scope) {
  const calls: any[] = [], saved: any[] = [], recorded: any[] = [], holds: string[] = [];
  const provider: ImageProvider = { id: "openai", model: "fixture", generate: async request => { calls.push(request); return { images: [{ bytes: pngBytes(32, 16), contentType: "image/png" }], tokens: { textInput: 4, imageInput: 0, output: 5 }, model: "fixture" }; } };
  const imager = new Imager({ provider, key: async () => ({ apiKey: "fake-only", platform: false }), price: () => ({ textInput: 1e6, imageInput: 1e6, output: 1e6 }) });
  const host = {
    imager: async () => imager, admit: async () => {},
    files: async () => ({ read: async () => pngBytes(4, 4), save: async (name: string, bytes: Uint8Array, contentType: string) => { saved.push({ name, bytes }); return { type: "file", path: "/workspace/" + name, size: bytes.length, contentType }; } }),
    record: async (context: any, usage: any) => { recorded.push({ context, usage }); },
    hold: () => async () => { holds.push("hold"); return { settle: async () => { holds.push("settle"); }, release: async () => { holds.push("release"); } }; },
    ...extra,
  };
  return { tools: agentMediaTools({} as never, async () => context, host), calls, saved, recorded, holds, imager };
}

test("image tool uses the source definition and is explicitly enabled", async () => {
  assert.deepEqual(await setup({}, { ...scope, builtins: [] }).tools, []);
  const [tool] = await setup().tools;
  assert.equal(tool.name, GENERATE_IMAGE.name);
  assert.deepEqual(tool.parameters, GENERATE_IMAGE.parameters);
  assert.equal(tool.replay, "unsafe");
});

test("image tool applies source options, reads edits, saves a file and settles usage", async () => {
  const h = setup(), [tool] = await h.tools;
  const value = await execute(tool, { prompt: "A small fixture", images: ["/workspace/input.png"], background: "transparent" });
  assert.equal(h.calls[0].images[0].width, 4);
  assert.equal(h.calls[0].options.quality, "medium");
  assert.equal(h.calls[0].options.background, "transparent");
  assert.deepEqual(value.structuredOutput, { path: "/workspace/image.png", contentType: "image/png", width: 32, height: 16, size: h.saved[0].bytes.length, costUsd: 0.000009 });
  assert.equal(JSON.parse(value.output[1].text).type, "file");
  assert.deepEqual(h.holds, ["hold", "settle"]);
  assert.equal(h.recorded.length, 1);
  assert.equal(h.recorded[0].context.identity.subject, "person");
  assert.equal(h.recorded[0].context.callId, "conversation:task:call");
});

test("invalid image arguments and exhausted budgets never reach a provider", async () => {
  const h = setup(), [tool] = await h.tools;
  await assert.rejects(execute(tool, { prompt: "x", unknown: true }), /Invalid generate_image/);
  const capped = setup({}, { ...scope, budget: 0 }), [limited] = await capped.tools;
  await assert.rejects(execute(limited, { prompt: "x" }), /more than.*spend limit/);
  assert.equal(h.calls.length + capped.calls.length, 0);
  assert.equal(h.recorded.length + capped.recorded.length, 0);
  assert.deepEqual(capped.holds, ["hold", "release"]);
});

test("made images remain billed if saving fails", async () => {
  const h = setup({ files: async () => ({ save: async () => { throw new Error("disk full"); } }) }), [tool] = await h.tools;
  await assert.rejects(execute(tool, { prompt: "x" }), /image was made but could not be saved/);
  assert.equal(h.recorded.length, 1);
  assert.deepEqual(h.holds, ["hold", "settle"]);
});

test("known image usage survives settlement failure and resumes without provider replay", async () => {
  const entries = new Map<string, unknown>();
  const storage = {
    async put(key: string, value: unknown) { entries.set(key, structuredClone(value)); },
    async delete(key: string) { entries.delete(key); },
    async list({ prefix }: { prefix: string }) { return new Map([...entries].filter(([key]) => key.startsWith(prefix))); },
  } as unknown as DurableObjectStorage;
  const h = setup({ storage, record: async () => { throw new Error("database unavailable"); } }), [tool] = await h.tools;
  await assert.rejects(execute(tool, { prompt: "A private prompt" }), /database unavailable/);
  assert.equal(h.calls.length, 1);
  assert.equal(entries.size, 1);
  const pending = [...entries][0];
  assert.doesNotMatch(JSON.stringify(pending), /private prompt|fake-only/);
  const committed = new Set<string>();
  let charges = 0;
  const record = async (receipt: any) => {
    assert.equal(receipt.scope.requestId, "run");
    assert.equal(receipt.scope.identity.subject, "person");
    if (!committed.has(receipt.scope.callId)) { committed.add(receipt.scope.callId); charges++; }
  };
  await flushAgentMediaUsage({} as never, storage, record);
  assert.equal(entries.size, 0);
  entries.set(...pending); // Crash after SQL commit and before DO acknowledgement.
  await flushAgentMediaUsage({} as never, storage, record);
  assert.equal(entries.size, 0);
  assert.equal(charges, 1);
  assert.equal(h.calls.length, 1);
});
