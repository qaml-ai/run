import assert from "node:assert/strict";
import { test } from "node:test";
import { camelCase, kebabCase, slugify, snakeCase, splitWords, truncate, wordWrap } from "../src/index.js";

test("splitWords", () => {
  assert.deepEqual(splitWords("helloWorld"), ["hello", "World"]);
  assert.deepEqual(splitWords("snake_case-and kebab"), ["snake", "case", "and", "kebab"]);
});
test("cases", () => {
  assert.equal(camelCase("Hello big world"), "helloBigWorld");
  assert.equal(snakeCase("someHTTPValue"), "some_http_value");
  assert.equal(kebabCase("Some Title Here"), "some-title-here");
});
test("slugify", () => {
  assert.equal(slugify("Hello, World!"), "hello-world");
  assert.equal(slugify("a b c", { separator: "_" }), "a_b_c");
});
test("truncate", () => {
  assert.equal(truncate("The quick brown fox", 10), "The quick…");
  assert.equal(truncate("abcdefghij", 6, { ellipsis: "..." }), "abc...");
});
test("wordWrap", () => {
  assert.equal(wordWrap("the quick brown fox jumps", 10), "the quick\nbrown fox\njumps");
  assert.throws(() => wordWrap("x", 0), RangeError);
});
