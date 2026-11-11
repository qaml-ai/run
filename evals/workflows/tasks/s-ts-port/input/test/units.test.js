import assert from "node:assert/strict";
import { test } from "node:test";
import { formatBytes, formatDuration, ordinal, parseBytes, parseDuration } from "../src/index.js";

test("bytes", () => {
  assert.equal(formatBytes(1500), "1.5 kB");
  assert.equal(formatBytes(1536, { binary: true }), "1.5 KiB");
  assert.equal(parseBytes("2KiB"), 2048);
});
test("durations", () => {
  assert.equal(formatDuration(3_723_004), "1h 2m 3s 4ms");
  assert.equal(parseDuration("1h 30m"), 5_400_000);
});
test("ordinal", () => {
  assert.equal(ordinal(1), "1st");
  assert.equal(ordinal(12), "12th");
  assert.equal(ordinal(23), "23rd");
});
