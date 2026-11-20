import assert from "node:assert/strict";
import { test } from "node:test";
import { parseV1History } from "../worker/src/history-import.ts";

test("parseV1History repair mode preserves meta.v1 while tolerating legacy anomalies", () => {
  const messages = [
    {
      role: "user",
      content: [
        { type: "text", text: "see attached" },
        { type: "file", path: "/workspace/missing.png", size: 123, contentType: "image/png" },
      ],
      timestamp: 100,
    },
    {
      role: "assistant",
      content: [
        { type: "text", text: "calling tool" },
        { type: "toolCall", id: "call_1", name: "read", arguments: { path: "/workspace/a" } },
      ],
      timestamp: 200,
    },
    {
      role: "user",
      content: [
        { type: "text", text: "next turn before tool result" },
        { type: "image", data: "not-valid-base64-image", mimeType: "image/png" },
      ],
      timestamp: 300,
    },
    {
      role: "toolResult",
      toolCallId: "orphan_call",
      toolName: "read",
      content: [{ type: "text", text: "late output" }],
      timestamp: 400,
    },
  ];

  // Strict mode continues to reject historical anomalies.
  assert.throws(() => parseV1History({ source: "v1-agent", messages }), /matching pinned attachment/);

  // Repair mode imports all messages, preserves meta.v1, annotates unpinned files, and omits broken inline flags.
  const repaired = parseV1History({ source: "v1-agent", messages, repair: true });
  assert.equal(repaired.messages.length, 4);
  assert.deepEqual(repaired.messages[0]!.content.meta, { v1: messages[0] });
  assert.match(repaired.messages[0]!.content.text ?? "", /Historical workspace file: \/workspace\/missing\.png/);
  assert.equal(repaired.messages[1]!.content.toolCalls?.length, 1);
  assert.equal(repaired.messages[2]!.content.legacyInlineImages, undefined);
  assert.deepEqual(repaired.messages[2]!.content.meta, { v1: messages[2] });
  assert.equal(repaired.messages[3]!.role, "tool");
  assert.equal(repaired.messages[3]!.content.toolCallId, "orphan_call");
});
