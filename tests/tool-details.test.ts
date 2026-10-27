import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createAgentHost, type HostIO } from "../src/agent-host.ts";
import { openPiStorage } from "../src/pi-durable/storage.ts";
import { journalMessages } from "./fixtures/journal-history.ts";

// Exercise the write boundary with native results, without a transport reshaping them first.
test("details caps count UTF-8 bytes, drop duplicate JSON, and survive missing or failed file writes", async t => {
  for (const mounted of [true, false]) await t.test(mounted ? "failed writer" : "no writable mount", async t => {
    const directory = await mkdtemp(join(tmpdir(), "tool-details-"));
    const faux = registerFauxProvider({ tokensPerSecond: 1_000_000 });
    const storage = await openPiStorage({ sessionId: "agent", directory });
    const writes: string[] = [];
    const values = [
      { content: [{ type: "text", text: "at limit" }], details: "x".repeat(16 * 1024 - 2) },
      { content: [{ type: "text", text: "over limit" }], details: "é".repeat(8192) },
      { content: [{ type: "text", text: "over file limit" }], details: "x".repeat(800_000) },
      { value: "duplicate" },
    ];
    const io: HostIO = {
      emit: () => {}, cancelTools: async () => null, runLimit: async () => undefined,
      legacyLog: { read: async () => [], empty: async () => true }, piStorage: async () => storage,
      tool: async () => values.shift(),
      file: async () => { throw new Error("no files"); }, modelAuth: async () => { throw new Error("no credentials"); },
      fs: async (_op, args) => { writes.push(String(args.path)); throw new Error("write failed"); },
    };
    const host = createAgentHost(io);
    t.after(async () => { await host.dispose(0); await storage.close(BACKGROUND_CONTEXT); faux.unregister(); await rm(directory, { recursive: true, force: true }); });
    await host.handle("init", { id: "agent", directory, model: faux.getModel(), apiKey: "fixture", mounts: mounted ? [{ path: "/workspace", volumeId: "fixture", mode: "rw" }] : [], tools: [
      { name: "content", description: "Content", parameters: { type: "object" }, exposure: "direct", resultFormat: "content" },
      { name: "json", description: "JSON", parameters: { type: "object" }, exposure: "direct" },
    ] });
    const sent: unknown[] = [];
    faux.setResponses([
      ...["content", "content", "content", "json"].map((name, index) => () => fauxAssistantMessage(fauxToolCall(name, {}, { id: `call_${index}` }), { stopReason: "toolUse" })),
      context => { sent.push(context.messages); return fauxAssistantMessage("Done."); },
    ]);
    const run = await host.handle("prompt", { text: "go" });
    assert.equal(run.error, null);
    const results = (await journalMessages({ sessionId: "agent", directory })).filter(message => message.role === "toolResult");
    assert.equal(results.length, 4);
    assert.equal(results[0].details, "x".repeat(16 * 1024 - 2));
    assert.deepEqual(results[1].details, { truncated: true });
    assert.deepEqual(results[2].details, { truncated: true });
    assert.equal(results[3].details, undefined);
    assert.deepEqual(results[3].content, [{ type: "text", text: '{"value":"duplicate"}' }]);
    assert.equal(writes.length, mounted ? 1 : 0, "only a complete JSON value that fits the file limit is offered to a writer");
    assert.ok(JSON.stringify(sent).includes('duplicate'));
  });
});
