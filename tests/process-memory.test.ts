import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cgroupMemory } from "../src/process-memory.ts";
import { nodeConfig } from "../src/node-config.ts";

test("memory sampling supports both cgroup layouts and absent counters", async t => {
  const root = await mkdtemp(join(tmpdir(), "runtime-memory-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(await cgroupMemory(root), {});
  await mkdir(join(root, "memory"));
  await writeFile(join(root, "memory/memory.usage_in_bytes"), "1024\n");
  assert.deepEqual(await cgroupMemory(root), { cgroupMemoryBytes: 1024 });
  await writeFile(join(root, "memory/memory.max_usage_in_bytes"), "4096\n");
  assert.deepEqual(await cgroupMemory(root), { cgroupMemoryBytes: 1024, cgroupMemoryPeakBytes: 4096 });
  await writeFile(join(root, "memory.current"), "2048\n");
  await writeFile(join(root, "memory.peak"), "8192\n");
  assert.deepEqual(await cgroupMemory(root), { cgroupMemoryBytes: 2048, cgroupMemoryPeakBytes: 8192 });
  await writeFile(join(root, "memory.peak"), "max\n");
  assert.deepEqual(await cgroupMemory(root), { cgroupMemoryBytes: 2048 });
});

test("load sampling stays at a minute by default and rejects excessive frequency", () => {
  assert.equal(nodeConfig({}).loadIntervalMs, 60_000);
  assert.equal(nodeConfig({ AGENT_LOAD_INTERVAL_MS: "5000" }).loadIntervalMs, 5000);
  for (const value of ["0", "999", "NaN", "1000.5"]) {
    assert.throws(() => nodeConfig({ AGENT_LOAD_INTERVAL_MS: value }), /AGENT_LOAD_INTERVAL_MS/);
  }
});
