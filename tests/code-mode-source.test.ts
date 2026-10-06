import { compiled } from "./compile-spy.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { executeCode } from "../src/codemode.ts";
import type { ToolBridge } from "../src/protocol.ts";

test("the runtime never hands guest code to its own V8: only v8-exec parses it, TypeScript included", async () => {
  const bridge: ToolBridge = {
    definitions: [{ name: "echo", description: "Echo", parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } }],
    call: async (_name, args) => args.value,
  };
  const run = async (code: string) => (await executeCode({ code, bridge })).output;
  // Plain JavaScript runs as it is; TypeScript without a "<" is found by V8 and stripped; with one it is stripped first.
  assert.deepEqual(await run('const guestMarker = 1; return await tools.echo({ value: "js" })'), ["js"]);
  assert.deepEqual(await run('const guestMarker: number = 1; return await tools.echo({ value: "ts" }) as string'), ["ts"]);
  assert.deepEqual(await run('const guestMarker = <T,>(x: T) => x; return guestMarker<string>(await tools.echo({ value: "generic" }))'), ["generic"]);
  await assert.rejects(run("const guestMarker = 1; return {"), /SyntaxError|expecting|unexpected/i);
  assert.deepEqual(compiled.filter(source => source.includes("guestMarker")), []);

  // The spy does see compilation on this thread.
  new (Object.getPrototypeOf(async function () {}).constructor)("return 'guestMarker'");
  assert.equal(compiled.filter(source => source.includes("guestMarker")).length, 1);
});
