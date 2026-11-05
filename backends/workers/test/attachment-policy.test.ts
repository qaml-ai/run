import assert from "node:assert/strict";
import test from "node:test";
import { attachmentInputs, describeFile } from "../src/attachment-policy.ts";
import {
  attachmentInput,
  attachmentMessage,
  attachmentMessages,
  type AttachedFile,
} from "../src/attachment-markers.ts";

test("attachment input policy reuses source limits and filename rules", () => {
  assert.throws(
    () =>
      attachmentInputs(
        Array.from({ length: 21 }, () => ({ path: "/workspace/x" })),
      ),
    /At most 20/,
  );
  assert.throws(
    () => attachmentInputs([{ name: "x", data: "not base64!" }]),
    /\{path\}.*\{name, data/,
  );
  assert.throws(
    () =>
      attachmentInputs([
        {
          name: "x",
          data: Buffer.alloc(4 * 1024 * 1024 + 3).toString("base64"),
        },
      ]),
    /Inline files are limited/,
  );
  const checked = attachmentInputs([
    { name: "../../etc/shot.png", data: "eA==" },
    { name: "shot.png", data: "eA==" },
  ]);
  assert.deepEqual(
    checked.map((item) => ("name" in item ? item.name : undefined)),
    ["shot.png", "shot-2.png"],
  );
  assert.throws(
    () => attachmentInputs([{ path: "/workspace/x", transcribe: "yes" }]),
    /transcribe is true or false/,
  );
});

test("attachment markers round trip immutable references without binary data", () => {
  const ref: AttachedFile = {
    type: "file",
    volume: "vol_" + "a".repeat(24),
    path: "/workspace/report.txt",
    version: 3,
    size: 3,
    contentType: "text/plain",
    chunks: ["b".repeat(64)],
    key: "files/alice/volume/random/body",
    head: "a,b",
  };
  const internal = { role: "user", content: attachmentInput("Look", [ref]) };
  const visible = attachmentMessage(internal);
  assert.deepEqual(visible.content, [{ type: "text", text: "Look" }, ref]);
  assert.deepEqual(attachmentMessages([visible]), [internal]);
  assert.equal(
    describeFile(ref),
    "[File /workspace/report.txt (text/plain, 1 KB), beginning:\na,b]",
  );
});
