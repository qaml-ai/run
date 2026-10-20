// Runs against the production image's pruned dependencies on both architectures, without provider calls.
import assert from "node:assert/strict";
import { startTurnModels, hostClient } from "../src/voice/turns/inference.ts";

const host = startTurnModels();
const client = hostClient(host);
try {
  await host.ready;
  const vad = await client.vad(new Float32Array(576), new Float32Array(256));
  assert.ok(vad.probability < 0.5, "Silence classified as speech");
  assert.ok(Number.isFinite(await client.endOfTurn(new Int16Array(16_000))));
} finally {
  client.close();
  await host.close();
}
