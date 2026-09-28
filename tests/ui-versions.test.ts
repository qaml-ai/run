import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path: string) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));

test("the SDK and the frontend packages are one release train: one version, and exact dependencies on the core", () => {
  const core = read("sdk/package.json");
  for (const name of ["react", "vue", "svelte", "solid", "create-agent-app"]) {
    const manifest = read(`packages/${name}/package.json`);
    assert.equal(manifest.version, core.version, `${manifest.name} is at the core's version`);
    if (manifest.dependencies?.["@camelai/agent-runtime"] !== undefined) assert.equal(manifest.dependencies["@camelai/agent-runtime"], core.version, `${manifest.name} depends on exactly this core`);
  }
  // The shadcn registry installs exactly this train.
  for (const item of read("packages/registry/registry.json").items) {
    for (const dependency of item.dependencies ?? []) {
      if (!dependency.startsWith("@camelai/")) continue;
      assert.equal(dependency.slice(dependency.lastIndexOf("@") + 1), core.version, `${item.name}: ${dependency}`);
    }
  }
  // The core exports what the frontend packages import.
  for (const path of ["./server", "./chat", "./markdown", "./watch", "./ai-sdk"]) assert.ok(core.exports[path], path);
});
