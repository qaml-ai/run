import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { coreFiles, coreViolations } from "../scripts/check-core.ts";

test("core boundary checks erased imports, dynamic imports and Node globals", async () => {
  const directory = await mkdtemp(join(tmpdir(), "core-boundary-"));
  const root = join(directory, "core"), file = join(root, "entry.ts");
  try {
    await mkdir(root);
    await writeFile(join(root, "pure.ts"), "export type Value = string;");
    await mkdir(join(root, "group"));
    await writeFile(join(root, "group", "index.ts"), "export const value = 1;");
    await writeFile(join(directory, "host.ts"), "export type Value = string;");
    await symlink(join(directory, "host.ts"), join(root, "escape.ts"));
    assert.deepEqual(await coreViolations(file, 'import type { Value } from "./pure.ts"; import { z } from "zod";', root), []);
    assert.deepEqual(await coreViolations(file, 'import type { Value } from "./pure.js"; import "./group";', root), []);
    assert.deepEqual(await coreViolations(join(root, "entry.js"), 'import "./pure"; export const value = 1;', root), []);
    for (const name of ["entry.tsx", "entry.jsx"])
      assert.deepEqual(await coreViolations(join(root, name), 'import "./pure"; export const view = <div />;', root), []);
    for (const source of [
      'import type { Value } from "../host.ts";',
      'export type { Value } from "../host.ts";',
      'type Value = import("../host.ts").Value;',
      'import type { Value } from "./escape.ts";',
      'import "node:crypto";',
      'import "pg";',
      'import "zod/node";',
      `import ${JSON.stringify(join(directory, "host.ts"))};`,
      'import host = require("../host.ts");',
      'const host = import("../host.ts");',
      'const host = import(path);',
      'process.env.VALUE;',
      'Buffer.from("value");',
      'globalThis["process"];',
      '/// <reference types="node" />\nexport {};',
    ]) assert.ok((await coreViolations(file, source, root)).length > 0, source);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("core module discovery rejects symlink files and directories", async () => {
  const directory = await mkdtemp(join(tmpdir(), "core-symlink-"));
  const root = join(directory, "core"), outside = join(directory, "host");
  try {
    await mkdir(root);
    await mkdir(outside);
    await writeFile(join(outside, "host.ts"), "export const host = true;");
    for (const [target, name] of [[join(outside, "host.ts"), "escape.ts"], [outside, "escape"]]) {
      const link = join(root, name);
      await symlink(target, link);
      await assert.rejects(coreFiles(root), /must not be symlinks/);
      await rm(link);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
