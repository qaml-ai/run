import assert from "node:assert/strict";
import { test } from "node:test";
import { runInput } from "../src/run-input.ts";
import { attachmentInput } from "../src/attachment-markers.ts";

test("stateless inputs retain file parts and text order", () => {
  assert.deepEqual(runInput([
    { type: "text", text: "before" },
    { type: "file", url: "https://example.test/voice.ogg", transcribe: true },
    { type: "text", text: "after" },
  ], [{ path: "/workspace/notes.txt" }]), {
    text: "before\n\nafter",
    files: [{ url: "https://example.test/voice.ogg", transcribe: true }, { path: "/workspace/notes.txt" }],
  });
  assert.deepEqual(runInput([{ type: "file", url: "https://example.test/voice.ogg" }]).text, "");
  assert.throws(() => runInput([{ type: "text", text: " " }]), /some text/);
  assert.throws(() => runInput([{ type: "image", url: "https://example.test/image.png" }]), /text or file/);
});

test("an attachment-only prompt has no empty text block", () => {
  assert.deepEqual(attachmentInput("", []), []);
});
