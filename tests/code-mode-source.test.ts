import { compiled } from "./compile-spy.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { stripTypeScriptFromUserCode } from "../shared/code-mode-source.ts";
import { CodePool, executeCode } from "../src/codemode.ts";
import type { ToolBridge } from "../src/protocol.ts";

test("TypeScript is stripped from js_exec code, and plain JavaScript passes through untouched", async () => {
  for (const code of ['return await tools.echo({ value: "x" })', "const a = 1 > 0 ? [1, 2] : {}; return a?.[0] ?? null", "   "]) {
    assert.equal(await stripTypeScriptFromUserCode(code), code);
  }
  const strip = async (code: string) => (await stripTypeScriptFromUserCode(code)).replace(/\s+/g, " ").trim();
  assert.equal(await strip("const n: number = 1; return n as unknown"), "const n = 1; return n");
  assert.equal(await strip("const v = value!.x; return v"), "const v = value.x; return v");
  assert.equal(await strip("interface A { x: number } return 1"), "return 1");
  assert.equal(await strip("return id<number>(3)"), "return id(3)");
  // Neither language: left for the sandbox to report.
  assert.equal(await stripTypeScriptFromUserCode("return {"), "return {");
});

test("the runtime never hands guest code to V8's parser: only QuickJS and sucrase see it", async t => {
  const pool = new CodePool({ min: 1, max: 2 });
  t.after(() => pool.close());
  const bridge: ToolBridge = {
    definitions: [{ name: "echo", description: "Echo", parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } }],
    call: async (_name, args) => args.value,
  };
  const run = async (code: string) => (await executeCode({ code, bridge, pool })).output;
  // Plain JavaScript runs as it is; TypeScript without a "<" is found by QuickJS and stripped; with one it is stripped first.
  assert.deepEqual(await run('const guestMarker = 1; return await tools.echo({ value: "js" })'), ["js"]);
  assert.deepEqual(await run('const guestMarker: number = 1; return await tools.echo({ value: "ts" }) as string'), ["ts"]);
  assert.deepEqual(await run('const guestMarker = <T,>(x: T) => x; return guestMarker<string>(await tools.echo({ value: "generic" }))'), ["generic"]);
  await assert.rejects(run("const guestMarker = 1; return {"), /SyntaxError|expecting|unexpected/i);
  assert.deepEqual(compiled.filter(source => source.includes("guestMarker")), []);

  // The spy does see compilation on this thread.
  new (Object.getPrototypeOf(async function () {}).constructor)("return 'guestMarker'");
  assert.equal(compiled.filter(source => source.includes("guestMarker")).length, 1);
});
