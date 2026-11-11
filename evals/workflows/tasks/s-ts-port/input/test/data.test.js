import assert from "node:assert/strict";
import { test } from "node:test";
import { closest, distance, escapeHtml, formatTable, parseCsv, plural, pluralize, render, toCsv } from "../src/index.js";

test("distance and closest", () => {
  assert.equal(distance("kitten", "sitting"), 3);
  assert.equal(closest("aple", ["apple", "maple", "ample"]), "apple");
});
test("plural", () => {
  assert.equal(plural("box"), "boxes");
  assert.equal(plural("Person"), "People");
  assert.equal(pluralize("mouse", 3, { inclusive: true }), "3 mice");
});
test("escape and render", () => {
  assert.equal(escapeHtml("<b>&</b>"), "&lt;b&gt;&amp;&lt;/b&gt;");
  assert.equal(render("Hi {{ name }}!", { name: "<Ada>" }), "Hi &lt;Ada&gt;!");
  assert.equal(render("Hi {{{ name }}}!", { name: "<Ada>" }), "Hi <Ada>!");
});
test("csv", () => {
  assert.deepEqual(parseCsv("a,b\n1,2"), [["a", "b"], ["1", "2"]]);
  assert.equal(toCsv([["a", "b, c"]]), 'a,"b, c"');
});
test("formatTable", () => {
  assert.equal(formatTable([{ name: "apple", qty: 3 }, { name: "kiwi", qty: 12 }]), "name  | qty\n------+----\napple | 3\nkiwi  | 12");
});
