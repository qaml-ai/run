import { test } from "node:test";
import assert from "node:assert/strict";
import { MediaSession, type MediaEvents } from "../src/voice/media.ts";
import type { Cut } from "../src/voice-audio.ts";
import { discordGrant, fakeTransport, sleep, speak, until } from "./voice-fakes.ts";

/** A media session's events, recorded. */
function recorder() {
  const seen = { cuts: [] as Cut[], starts: [] as string[], pcm: 0, drops: 0, ready: 0, lost: [] as string[] };
  const events: MediaEvents = {
    ready: () => { seen.ready++; }, lost: reason => { seen.lost.push(reason); }, diagnostic: () => {},
    speechStart: speaker => { seen.starts.push(speaker); }, pcm: (_speaker, pcm) => { seen.pcm += pcm.byteLength; }, drop: () => { seen.drops++; },
    cut: cut => { seen.cuts.push(cut); },
  };
  return { seen, events };
}

/** 24 kHz mono PCM, `seconds` long, in 100 ms chunks every `everyMs`. */
async function* tone(seconds: number, everyMs = 1) {
  for (let at = 0; at < seconds * 10; at++) { yield Buffer.alloc(4_800, 1); await sleep(everyMs); }
}

test("a media session: its speakers cut into utterances (not the bot's, nor those ignored), live PCM, and close flushes before the connection closes", async () => {
  const fake = fakeTransport(2);
  const { seen, events } = recorder();
  const grant = discordGrant();
  const media = new MediaSession(fake.transport, grant, { silenceMs: 200, ignoreUserIds: ["500000000000000005"], bargeIn: true, live: true }, events);
  const [connection] = fake.connections;
  connection.handlers.ready();
  assert.equal(seen.ready, 1);
  speak(connection, grant.userId, 0.5);
  speak(connection, "500000000000000005", 0.5);
  speak(connection, "400000000000000004", 0.5);
  assert.deepEqual(seen.starts, ["400000000000000004"], "only a person listened to starts an utterance");
  assert.ok(seen.pcm > 0, "its audio streamed as it came");
  media.configure({ ignoreUserIds: [] });
  speak(connection, "500000000000000005", 0.5);
  await media.close("end");
  assert.deepEqual(seen.cuts.map(cut => [cut.speaker, cut.ended]).sort(), [["400000000000000004", "end"], ["500000000000000005", "end"]]);
  assert.ok(connection.closed);
  connection.handlers.ready();
  assert.equal(seen.ready, 1, "nothing is reported after close");
});

test("a media session plays PCM as Opus; a person starting to talk stops it there and then (barge-in), after the session hears", async () => {
  const fake = fakeTransport(20);
  const order: string[] = [];
  const { events } = recorder();
  const media = new MediaSession(fake.transport, discordGrant(), { silenceMs: 200, ignoreUserIds: [], bargeIn: true, live: false }, { ...events, speechStart: () => { order.push("session heard"); } });
  const [connection] = fake.connections;
  let started = 0;
  const playback = media.play(tone(2), () => { started++; });
  await until(() => connection.played[0]?.length >= 5, "speech playing");
  assert.equal(started, 1);
  assert.ok(connection.played[0].every(packet => packet.length > 3 && packet[0] !== 0), "Opus packets, 20 ms each");
  void playback.done.then(result => order.push(`playback ${result}`));
  speak(connection, "400000000000000004", 0.1);
  assert.equal(await playback.done, "stopped");
  assert.deepEqual(order, ["session heard", "playback stopped"]);
  await media.close("end");
});

test("music the bot plays goes on when a person talks over it (barge-in is for speech); close stops it", async () => {
  const fake = fakeTransport(20);
  const { events } = recorder();
  const media = new MediaSession(fake.transport, discordGrant(), { silenceMs: 200, ignoreUserIds: [], bargeIn: true, live: false }, events);
  const [connection] = fake.connections;
  const music = media.play(tone(2), () => {}, undefined, { music: true });
  await until(() => connection.played[0]?.length >= 5, "music playing");
  let result: string | undefined;
  void music.done.then(value => { result = value; });
  speak(connection, "400000000000000004", 0.1);
  await sleep(100);
  assert.equal(result, undefined, "still playing");
  const before = connection.played[0].length;
  await until(() => connection.played[0].length > before + 2, "more of it");
  await media.close("end");
  assert.equal(await music.done, "stopped");
});
