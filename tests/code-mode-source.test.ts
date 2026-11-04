import { compiled } from "./compile-spy.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { PiV8Sandbox } from "../src/codemode-pi-launcher.ts";

test("the runtime never hands guest code to its own V8: only v8-exec parses it, TypeScript included", async t => {
  const sandbox = new PiV8Sandbox({ tools: [{ name: "echo", execute: args => (args as { value: string }).value }] });
  t.after(() => sandbox.close());
  const run = async (code: string) => {
    const result = await sandbox.execute(code);
    if (!result.ok) throw new Error(result.error.message);
    return [result.value];
  };
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
