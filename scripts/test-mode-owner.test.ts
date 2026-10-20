import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

test("trace ownership survives replaced child environments and changed working directories", () => {
  const dir = mkdtempSync(join(tmpdir(), "mode-owner-"));
  try {
    const cwd = join(dir, "elsewhere"); mkdirSync(cwd);
    const child = join(dir, "child.mjs");
    writeFileSync(child, 'console.log(JSON.stringify([process.env.TEST_MODE_OWNER, process.env.TEST_MODE_TRACE_DIR]));');
    const fixture = join(dir, "ownership.test.ts");
    writeFileSync(fixture, `
      import { test } from 'node:test';
      import assert from 'node:assert/strict';
      import { spawn } from 'node:child_process';
      test('child attribution', async () => {
        const child = spawn(process.execPath, [${JSON.stringify(child)}], { cwd: ${JSON.stringify(cwd)}, env: { PATH: process.env.PATH } });
        let output = ''; child.stdout.on('data', chunk => { output += chunk; });
        const status = await new Promise(resolve => child.on('close', resolve));
        assert.equal(status, 0);
        assert.deepEqual(JSON.parse(output), ['ownership.test.ts', ${JSON.stringify(dir)}]);
        // Inheriting NODE_OPTIONS must also work from a different directory.
        const inherited = spawn(process.execPath, [${JSON.stringify(child)}], { cwd: ${JSON.stringify(cwd)} });
        const inheritedStatus = await new Promise(resolve => inherited.on('close', resolve));
        assert.equal(inheritedStatus, 0);
      });
    `);
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "--test", fixture], {
      env: { ...process.env, NODE_TEST_CONTEXT: undefined, NODE_OPTIONS: `--import=${fileURLToPath(new URL("test-mode-owner.ts", import.meta.url))}`, TEST_MODE_TRACE_DIR: dir }, encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
