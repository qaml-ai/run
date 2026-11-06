import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { sha256Hex } from "../src/core/sha256.ts";

test("the shared sha-256 matches node:crypto on every padding boundary and on multi-byte text", () => {
  const samples = ["", "a", "abc", "héllo wörld ✓ 𝄞", "x".repeat(55), "x".repeat(56), "x".repeat(63), "x".repeat(64), "x".repeat(65), "k".repeat(1000), "the key: 42"];
  for (const text of samples) assert.equal(sha256Hex(text), createHash("sha256").update(text).digest("hex"), JSON.stringify(text.slice(0, 20)));
});
