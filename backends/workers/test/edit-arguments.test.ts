import assert from "node:assert/strict";
import test from "node:test";
import { editArguments } from "../src/edit-arguments.ts";

test("edit takes the shapes models send: a top-level pair, one edit object, edits as a JSON string", () => {
  const edits = [{ oldText: "a", newText: "b" }];
  // Seen twice in camelCode's pilot runs (Sonnet 5.5 on /project/LEDGER.md): refused, then retried.
  assert.deepEqual(editArguments({ path: "/project/LEDGER.md", oldText: "a", newText: "b" }), { path: "/project/LEDGER.md", edits });
  assert.deepEqual(editArguments({ path: "f", edits: { oldText: "a", newText: "b" } }), { path: "f", edits });
  assert.deepEqual(editArguments({ path: "f", edits: JSON.stringify(edits) }), { path: "f", edits });
  assert.deepEqual(editArguments({ path: "f", edits: JSON.stringify(edits[0]) }), { path: "f", edits });
  // The documented shape, and what cannot be repaired, pass through for validation.
  assert.deepEqual(editArguments({ path: "f", edits }), { path: "f", edits });
  assert.deepEqual(editArguments({ path: "f", edits: "not json" }), { path: "f", edits: "not json" });
  assert.equal(editArguments(null), null);
});
