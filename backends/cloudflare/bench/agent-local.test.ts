import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalWorker, unusedPort } from "../test/local-worker.ts";
import { main } from "./agent-runner.mjs";

test("benchmark wrapper: auth, 100 deterministic agents, SSE and journal replay", { timeout: 240_000 }, async t => {
  const folder = await mkdtemp(join(tmpdir(), "camelrun-proto-agent-"));
  const server = new LocalWorker(await unusedPort(), folder, "bench/agent-wrangler.local.jsonc");
  const previous = process.env.CAMELRUN_BENCH_API_TOKEN;
  process.env.CAMELRUN_BENCH_API_TOKEN = "local-integration-only-token-with-at-least-32-characters";
  try {
    await server.start();
    const report = await main(["measure", "--base-url", server.url, "--real-turns", "0", "--agents", "100", "--out", join(folder, "measure.json")]);
    assert.equal(report.deterministic.completeCount, 100);
    assert.equal(report.deterministic.distinctConstructedInstances, 100);
    assert.equal(report.realDispatchesInThisRun, 0);
    const state = join(folder, "replay.json");
    await main(["replay-prepare", "--base-url", server.url, "--out", state]);
    await server.stop(true);
    await server.start();
    const replay = await main(["replay-resume", "--base-url", server.url, "--state", state, "--out", join(folder, "replay-result.json")]);
    assert.equal(replay.reconstructed, true);
    assert.equal(replay.after.budget.reservedDispatches, 0);
    t.diagnostic(JSON.stringify({ deterministicConcurrentAgents: report.deterministic.completeCount,
      distinctInstances: report.deterministic.distinctConstructedInstances, elapsedMs: report.deterministic.elapsedMs,
      latencyMs: report.deterministic.totalMs, replayReconstructed: replay.reconstructed }));
  } finally {
    await server.stop();
    if (previous === undefined) delete process.env.CAMELRUN_BENCH_API_TOKEN;
    else process.env.CAMELRUN_BENCH_API_TOKEN = previous;
    await rm(folder, { recursive: true, force: true });
  }
});
