import { test } from "node:test";
import assert from "node:assert/strict";
import FakeTimers from "@sinonjs/fake-timers";
import { buffered } from "../src/voice-audio.ts";
import { sleep } from "./voice-fakes.ts";

/**
 * A provider's speech as 20 ms packets, `rate` times faster than they play (steadily, or in bursts of `burst` packets),
 * played by a player that takes one each 20 ms: when the first went out after the first came, and the silence heard
 * after the start (a packet late is a frame of silence). On fake time: on real time, a busy machine's late timers are
 * silence the buffer did not cause.
 */
async function play(rate: number, seconds: number, expectedMs?: number, burst = 1) {
  const time = FakeTimers.install({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  try {
    const played = playback(rate, seconds, expectedMs, burst);
    await time.runAllAsync();
    return await played;
  } finally { time.uninstall(); }
}

async function playback(rate: number, seconds: number, expectedMs: number | undefined, burst: number) {
  const total = Math.round(seconds * 50);
  let firstIn = 0;
  async function* provider() {
    for (let sent = 0; sent < total;) {
      if (!firstIn) firstIn = performance.now();
      for (let packet = 0; packet < burst && sent < total; packet++, sent++) yield sent;
      await sleep(20 * burst / rate);
    }
  }
  let firstOut = 0, next = 0, silentMs = 0, played = 0;
  for await (const _packet of buffered(provider(), expectedMs !== undefined ? { expectedMs } : {})) {
    const now = performance.now();
    if (!firstOut) { firstOut = now; next = now; }
    if (now > next + 5) silentMs += now - next;
    next = Math.max(next, now) + 20;
    played++;
    const wait = next - performance.now();
    if (wait > 0) await sleep(wait);
  }
  return { startMs: Math.round(firstOut - firstIn), silentMs: Math.round(silentMs), played };
}

test("with its length known, speech made a little faster than it plays starts at once, not after a second's lead, and plays without gaps", { timeout: 60_000 }, async () => {
  // Steadily, 1.25 times faster than real time: below the 1.5 an unknown length needs to start at once.
  const before = await play(1.25, 3);
  const after = await play(1.25, 3, 3_000);
  console.log(JSON.stringify({ type: "voice_first_packet", rate: 1.25, seconds: 3, startMs: { before: before.startMs, after: after.startMs }, silentMs: { before: before.silentMs, after: after.silentMs } }));
  assert.ok(before.startMs >= 600, `without its length it waited for a lead (${before.startMs} ms)`);
  assert.ok(after.startMs < 250, `with it, it started at once (${after.startMs} ms)`);
  assert.ok(after.silentMs < 60, `and played without gaps (${after.silentMs} ms of silence)`);
  assert.equal(after.played, 150);
});

test("with its length known, speech made slower than it plays waits for the lead it needs, then plays without gaps", { timeout: 60_000 }, async () => {
  // Slower than real time, in bursts of 100 ms (the first of which must not pass for a fast provider).
  const slow = await play(0.8, 2, 2_000, 5);
  console.log(JSON.stringify({ type: "voice_first_packet", rate: 0.8, seconds: 2, startMs: slow.startMs, silentMs: slow.silentMs }));
  assert.ok(slow.startMs >= 300, `it waited (${slow.startMs} ms)`);
  assert.ok(slow.silentMs < 150, `then played through (${slow.silentMs} ms of silence)`);
});
