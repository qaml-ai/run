// The hidden judge for s-ts-port. Never uploaded to the agent. It imports the library under test from
// STRKIT_ENTRY (the scorer points it at the ported src/index.ts) and holds more cases than the visible tests.
import assert from "node:assert/strict";
import { test } from "node:test";

const lib = await import(process.env.STRKIT_ENTRY);

test("splitWords", () => {
  assert.deepEqual(lib.splitWords("helloWorld"), ["hello", "World"]);
  assert.deepEqual(lib.splitWords("XMLHttpRequest"), ["XML", "Http", "Request"]);
  assert.deepEqual(lib.splitWords("snake_case-and kebab"), ["snake", "case", "and", "kebab"]);
  assert.deepEqual(lib.splitWords("  "), []);
  assert.deepEqual(lib.splitWords("v2Beta3"), ["v2", "Beta3"]);
});
test("case conversions", () => {
  assert.equal(lib.camelCase("Hello big world"), "helloBigWorld");
  assert.equal(lib.camelCase("XMLHttpRequest"), "xmlHttpRequest");
  assert.equal(lib.pascalCase("foo_bar-baz"), "FooBarBaz");
  assert.equal(lib.snakeCase("someHTTPValue"), "some_http_value");
  assert.equal(lib.kebabCase("Some Title Here"), "some-title-here");
  assert.equal(lib.constantCase("maxRetryCount"), "MAX_RETRY_COUNT");
  assert.equal(lib.camelCase(""), "");
});
test("slugify", () => {
  assert.equal(lib.slugify("Hello, World!"), "hello-world");
  assert.equal(lib.slugify("Crème brûlée & café"), "creme-brulee-and-cafe");
  assert.equal(lib.slugify("  --Already--Slugged--  "), "already-slugged");
  assert.equal(lib.slugify("a b c", { separator: "_" }), "a_b_c");
  assert.equal(lib.slugify("The quick brown fox", { maxLength: 10 }), "the-quick");
  assert.equal(lib.slugify("Hello World", { separator: "" }), "helloworld");
  assert.equal(lib.slugify("a.b", { separator: "." }), "a.b");
});
test("truncate", () => {
  assert.equal(lib.truncate("short", 10), "short");
  assert.equal(lib.truncate("The quick brown fox", 10), "The quick…");
  assert.equal(lib.truncate("The quick brown fox", 12, { wordBoundary: true }), "The quick…");
  assert.equal(lib.truncate("abcdefghij", 6, { ellipsis: "..." }), "abc...");
  assert.equal(lib.truncate("abc", 2, { ellipsis: "..." }), "...");
  assert.equal(lib.truncate("exactly10!", 10), "exactly10!");
});
test("wordWrap", () => {
  assert.equal(lib.wordWrap("the quick brown fox jumps", 10), "the quick\nbrown fox\njumps");
  assert.equal(lib.wordWrap("a\n\nb c", 3), "a\n\nb c");
  assert.equal(lib.wordWrap("supercalifragilistic word", 5), "supercalifragilistic\nword");
  assert.equal(lib.wordWrap("abcdefghij kl", 4, { hard: true }), "abcd\nefgh\nij\nkl");
  assert.equal(lib.wordWrap("one two", 3, { indent: "> " }), "> one\n> two");
  assert.throws(() => lib.wordWrap("x", 0), RangeError);
  assert.throws(() => lib.wordWrap("x", 2.5), RangeError);
});
test("distance", () => {
  assert.equal(lib.distance("kitten", "sitting"), 3);
  assert.equal(lib.distance("", "abc"), 3);
  assert.equal(lib.distance("abc", ""), 3);
  assert.equal(lib.distance("same", "same"), 0);
  assert.equal(lib.distance("flaw", "lawn"), 2);
});
test("closest", () => {
  assert.equal(lib.closest("aple", ["apple", "maple", "ample"]), "apple");
  assert.equal(lib.closest("APPLE", ["apple", "grape"]), "apple");
  assert.equal(lib.closest("APPLE", ["apple", "APPLY"], { caseSensitive: true }), "APPLY");
  assert.equal(lib.closest("zzz", ["apple"], { maxDistance: 2 }), undefined);
  assert.equal(lib.closest("x", []), undefined);
});
test("plural", () => {
  assert.equal(lib.plural("box"), "boxes");
  assert.equal(lib.plural("city"), "cities");
  assert.equal(lib.plural("day"), "days");
  assert.equal(lib.plural("knife"), "knives");
  assert.equal(lib.plural("Person"), "People");
  assert.equal(lib.plural("CHILD"), "CHILDREN");
  assert.equal(lib.plural("sheep"), "sheep");
  assert.equal(lib.plural("church"), "churches");
  assert.equal(lib.plural("cat"), "cats");
  assert.equal(lib.plural("constructor"), "constructors");
});
test("pluralize", () => {
  assert.equal(lib.pluralize("apple", 1), "apple");
  assert.equal(lib.pluralize("apple", 0), "apples");
  assert.equal(lib.pluralize("mouse", 3, { inclusive: true }), "3 mice");
  assert.equal(lib.pluralize("fish", 2, { inclusive: true }), "2 fish");
});
test("escapeHtml and unescapeHtml", () => {
  assert.equal(lib.escapeHtml(`<a href="x">Tom & 'Jerry'</a>`), "&lt;a href=&quot;x&quot;&gt;Tom &amp; &#39;Jerry&#39;&lt;/a&gt;");
  assert.equal(lib.unescapeHtml("&lt;b&gt; &amp;amp; &#39;"), "<b> &amp; '");
  assert.equal(lib.escapeHtml(42), "42");
  assert.equal(lib.unescapeHtml("&copy;"), "&copy;");
});
test("lookup", () => {
  const data = { user: { name: "Ada", address: { city: "London" } }, list: ["a", "b"] };
  assert.equal(lib.lookup(data, "user.address.city"), "London");
  assert.equal(lib.lookup(data, "list.1"), "b");
  assert.equal(lib.lookup(data, "user.phone.number"), undefined);
});
test("render", () => {
  assert.equal(lib.render("Hi {{ name }}!", { name: "<Ada>" }), "Hi &lt;Ada&gt;!");
  assert.equal(lib.render("Hi {{{ name }}}!", { name: "<Ada>" }), "Hi <Ada>!");
  assert.equal(lib.render("{{a.b}}-{{ c }}", { a: { b: 1 } }), "1-");
  assert.equal(lib.render("{{ x }}", {}, { missing: "?" }), "?");
  assert.equal(lib.render("{{ x }}", { x: "<i>" }, { escape: false }), "<i>");
  assert.equal(lib.render("{{ n }}", { n: 0 }), "0");
  assert.throws(() => lib.render("{{ x }}", {}, { strict: true }), /Missing value for x/);
});
test("parseCsv", () => {
  assert.deepEqual(lib.parseCsv("a,b\n1,2"), [["a", "b"], ["1", "2"]]);
  assert.deepEqual(lib.parseCsv('x,"y, z","say ""hi"""\r\n'), [["x", "y, z", 'say "hi"']]);
  assert.deepEqual(lib.parseCsv("a;b\n1;2", { delimiter: ";" }), [["a", "b"], ["1", "2"]]);
  assert.deepEqual(lib.parseCsv("name,age\nAda,36\nBob", { header: true }), [{ name: "Ada", age: "36" }, { name: "Bob", age: "" }]);
  assert.deepEqual(lib.parseCsv('"multi\nline",x'), [["multi\nline", "x"]]);
  assert.deepEqual(lib.parseCsv(""), []);
  assert.deepEqual(lib.parseCsv("a,\n"), [["a", ""]]);
  assert.throws(() => lib.parseCsv('"open'), SyntaxError);
});
test("toCsv", () => {
  assert.equal(lib.toCsv([["a", "b, c"], ['q"t', null]]), 'a,"b, c"\n"q""t",');
  assert.equal(lib.toCsv([["a;b", 1]], { delimiter: ";" }), '"a;b";1');
  assert.equal(lib.toCsv([]), "");
});
test("padding", () => {
  assert.equal(lib.padStart("7", 3, "0"), "007");
  assert.equal(lib.padEnd("ab", 5, "-="), "ab-=-");
  assert.equal(lib.padStart("long", 2), "long");
  assert.equal(lib.center("ab", 7, "*"), "**ab***");
  assert.equal(lib.center(5, 3), " 5 ");
});
test("formatTable", () => {
  const rows = [{ name: "apple", qty: 3 }, { name: "kiwi", qty: 12 }];
  assert.equal(lib.formatTable(rows), "name  | qty\n------+----\napple | 3\nkiwi  | 12");
  assert.equal(lib.formatTable(rows, { align: { qty: "right" } }), "name  | qty\n------+----\napple |   3\nkiwi  |  12");
  assert.equal(lib.formatTable(rows, { columns: ["qty"], align: { qty: "center" } }), "qty\n---\n 3\n12");
  assert.equal(lib.formatTable([{ a: null, b: "x" }]), "a | b\n--+--\n  | x");
  assert.equal(lib.formatTable([]), "");
});
test("formatBytes", () => {
  assert.equal(lib.formatBytes(0), "0 B");
  assert.equal(lib.formatBytes(999), "999 B");
  assert.equal(lib.formatBytes(1500), "1.5 kB");
  assert.equal(lib.formatBytes(1000), "1 kB");
  assert.equal(lib.formatBytes(1536, { binary: true }), "1.5 KiB");
  assert.equal(lib.formatBytes(1234567, { decimals: 2 }), "1.23 MB");
  assert.equal(lib.formatBytes(-2048, { binary: true }), "-2 KiB");
  assert.equal(lib.formatBytes(1e21), "1000000 PB");
  assert.throws(() => lib.formatBytes(Number.NaN), TypeError);
});
test("parseBytes", () => {
  assert.equal(lib.parseBytes("1.5 kB"), 1500);
  assert.equal(lib.parseBytes("2KiB"), 2048);
  assert.equal(lib.parseBytes("12"), 12);
  assert.equal(lib.parseBytes(" 3 MB "), 3_000_000);
  assert.equal(lib.parseBytes("1 GiB"), 1073741824);
  assert.throws(() => lib.parseBytes("lots"), SyntaxError);
});
test("formatDuration", () => {
  assert.equal(lib.formatDuration(0), "0ms");
  assert.equal(lib.formatDuration(3_723_004), "1h 2m 3s 4ms");
  assert.equal(lib.formatDuration(90_061_000, { largest: 2 }), "1d 1h");
  assert.equal(lib.formatDuration(1500.6), "1s 501ms");
  assert.throws(() => lib.formatDuration(-1), RangeError);
});
test("parseDuration", () => {
  assert.equal(lib.parseDuration("1h 30m"), 5_400_000);
  assert.equal(lib.parseDuration("2d"), 172_800_000);
  assert.equal(lib.parseDuration("1.5s"), 1500);
  assert.equal(lib.parseDuration("250ms"), 250);
  assert.equal(lib.parseDuration("1m5s"), 65_000);
  assert.throws(() => lib.parseDuration("soon"), SyntaxError);
  assert.throws(() => lib.parseDuration("5 minutes"), SyntaxError);
});
test("ordinal", () => {
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 101, 111, 112, 0].map(lib.ordinal), ["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "101st", "111th", "112th", "0th"]);
  assert.equal(lib.ordinal(-1), "-1st");
  assert.throws(() => lib.ordinal(1.5), TypeError);
});
test("index exports every function", () => {
  const names = ["splitWords", "camelCase", "pascalCase", "snakeCase", "kebabCase", "constantCase", "slugify", "truncate", "wordWrap", "distance", "closest", "plural", "pluralize", "escapeHtml", "unescapeHtml", "render", "lookup", "parseCsv", "toCsv", "padStart", "padEnd", "center", "formatTable", "formatBytes", "parseBytes", "formatDuration", "parseDuration", "ordinal"];
  for (const name of names) assert.equal(typeof lib[name], "function", name);
});
