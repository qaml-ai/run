import { test } from "node:test";
import assert from "node:assert/strict";
import { Rpc } from "../src/rpc.ts";
import type { WireMessage } from "../src/protocol.ts";

test("an end that was closed acts on no request still queued from its host: its handler never runs, and nothing answers", async () => {
  const sent: WireMessage[] = [];
  const handled: string[] = [];
  const rpc = new Rpc(message => { sent.push(message); });
  rpc.handler = async method => { handled.push(method); return "done"; };
  await rpc.receive({ type: "request", id: "1", method: "pi-storage", params: {} });
  assert.deepEqual(handled, ["pi-storage"]);
  assert.deepEqual(sent, [{ type: "response", id: "1", result: "done" }]);
  // The host is stopped: what it sent before then is still delivered, and refused without a word.
  const pending = rpc.request("status");
  rpc.close("Agent stopped");
  await assert.rejects(pending, /Agent stopped/);
  sent.length = 0;
  await rpc.receive({ type: "request", id: "2", method: "pi-storage", params: {} });
  await rpc.receive({ type: "request", id: "3", method: "tool", params: {} });
  assert.deepEqual(handled, ["pi-storage"]);
  assert.deepEqual(sent, []);
});
