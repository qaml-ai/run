import { test } from "node:test";
import assert from "node:assert/strict";
import { HttpError } from "../src/http.ts";
import type { Playback, Player } from "../src/voice-speech.ts";
import { AUDIO_LIMITS, Jukebox, type JukeboxHooks } from "../src/voice/jukebox.ts";
import { sleep, until } from "./voice-realtime-fakes.ts";

/** Audio a voice session plays into its call (src/voice/jukebox.ts): a queue, paced playback, controls. */

/** A WAV file: `seconds` of a constant level (so volume shows as the level played). */
function wav(seconds: number, level = 10_000) {
  const data = Buffer.alloc(Math.round(seconds * 24_000) * 2);
  for (let i = 0; i < data.length; i += 2) data.writeInt16LE(i % 4 ? level : -level, i);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + data.length, 4); header.write("WAVE", 8);
  header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24_000, 24); header.writeUInt32LE(48_000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(data.length, 40);
  return new Uint8Array(Buffer.concat([header, data]));
}

/** A player that plays in real time (each chunk takes its length), recording what it played: ms, peak level, music. */
function realtimePlayer() {
  const plays: { ms: number; peak: number; stopped: boolean; music: boolean }[] = [];
  const player: Player = {
    play(pcm, started, _expectedMs, options): Playback {
      const record = { ms: 0, peak: 0, stopped: false, music: !!options?.music };
      plays.push(record);
      const done = (async () => {
        for await (const chunk of pcm) {
          if (record.stopped) break;
          if (!record.ms) started();
          const samples = new Int16Array(chunk.buffer, chunk.byteOffset, chunk.byteLength / 2);
          for (const sample of samples) record.peak = Math.max(record.peak, Math.abs(sample));
          const ms = chunk.byteLength / 48;
          record.ms += ms;
          await sleep(ms);
        }
        return record.stopped ? "stopped" as const : "done" as const;
      })();
      return { done, stop: () => { record.stopped = true; } };
    },
  };
  return { player, plays };
}

function testJukebox(options: { open?: JukeboxHooks["open"]; media?: { up: boolean } } = {}) {
  const { player, plays } = realtimePlayer();
  const events: Parameters<JukeboxHooks["event"]>[0][] = [];
  let active = 0;
  const jukebox = new Jukebox({
    player: () => options.media?.up === false ? undefined : player,
    open: options.open ?? (async source => (async function* () { if ("bytes" in source) yield source.bytes; })()),
    event: event => events.push(event), active: () => { active++; }, log: () => {},
  });
  return { jukebox, plays, events, active: () => active };
}

test("tracks play in order, each once it is its turn, at the volume set; their start and end are told", async () => {
  const { jukebox, plays, events, active } = testJukebox();
  const first = jukebox.add({ bytes: wav(0.3) }, { title: "First" });
  assert.equal(first.position, 0, "plays at once");
  const second = jukebox.add({ bytes: wav(0.3) }, { volume: 1 });
  assert.equal(second.position, 1);
  assert.deepEqual(jukebox.state().queue.map(track => track.id), [second.track.id]);
  await until(() => events.filter(event => event.type === "ended").length === 2, "both to end", 5_000);
  assert.deepEqual(events.map(event => [event.type, event.track.id]), [["started", first.track.id], ["ended", first.track.id], ["started", second.track.id], ["ended", second.track.id]]);
  const ended = events[1];
  assert.equal(ended.type === "ended" && ended.reason, "done");
  assert.ok(ended.type === "ended" && Math.abs(ended.seconds - 0.3) <= 0.1, `${ended.type === "ended" && ended.seconds}`);
  assert.equal(events[0].track.title, "First");
  assert.ok(plays.every(play => play.music), "played as music: barge-in leaves it be");
  assert.ok(Math.abs(plays[0].peak - 10_000) <= 1 || Math.abs(plays[1].peak - 10_000) <= 1, "volume 1: the level as it is");
  // The first was added before the volume changed, but plays after it: the volume is the jukebox's.
  assert.ok(active() >= 2);
  assert.equal(jukebox.state().playing, null);
});

test("the bot's speech holds the music, which goes on where it was heard to", async () => {
  const { jukebox, plays, events } = testJukebox();
  jukebox.add({ bytes: wav(1.2) });
  await until(() => plays[0]?.ms >= 400, "some of it to play");
  jukebox.duck(true);
  await until(() => plays[0].stopped, "the music to hold");
  const heard = jukebox.state().playing!.positionMs;
  assert.ok(heard >= 250 && heard < 900, `heard to ${heard} ms`);
  await sleep(100);
  assert.equal(plays.length, 1, "nothing while the bot speaks");
  jukebox.duck(false);
  await until(() => plays.length === 2, "the music back", 2_000);
  await until(() => events.some(event => event.type === "ended"), "the track to end", 5_000);
  const ended = events.find(event => event.type === "ended")!;
  assert.ok(ended.type === "ended" && Math.abs(ended.seconds - 1.2) < 0.25, `the whole track heard once (${ended.type === "ended" && ended.seconds})`);
  assert.equal(events.filter(event => event.type === "started").length, 1, "started once");
});

test("pause, resume, skip, stop and volume", async () => {
  const { jukebox, plays, events } = testJukebox();
  const a = jukebox.add({ bytes: wav(2) });
  const b = jukebox.add({ bytes: wav(2) });
  const c = jukebox.add({ bytes: wav(2) }, { next: true });
  assert.deepEqual(jukebox.state().queue.map(track => track.id), [c.track.id, b.track.id], "next goes first");
  await until(() => plays[0]?.ms >= 200, "a to play");
  assert.equal(jukebox.pause().paused, true);
  await until(() => plays[0].stopped, "a to pause");
  await sleep(50);
  assert.equal(plays.length, 1);
  jukebox.setVolume(0.25);
  jukebox.resume();
  await until(() => plays.length === 2 && plays[1].ms > 0, "a to go on");
  assert.ok(plays[1].peak <= 2_501, `at a quarter (${plays[1].peak})`);
  jukebox.skip();
  await until(() => events.some(event => event.type === "started" && event.track.id === c.track.id), "c to play");
  const skipped = events.find(event => event.type === "ended" && event.track.id === a.track.id)!;
  assert.equal(skipped.type === "ended" && skipped.reason, "skipped");
  const state = jukebox.stop();
  assert.equal(state.playing, null);
  assert.deepEqual(state.queue, []);
  assert.deepEqual(events.filter(event => event.type === "ended").map(event => event.type === "ended" && [event.track.id, event.reason]), [[a.track.id, "skipped"], [c.track.id, "stopped"], [b.track.id, "stopped"]]);
  assert.throws(() => jukebox.setVolume(2), /volume must be from 0 to 1/);
});

test("a long track holds only what is ahead of the listener, not what was heard", async () => {
  const { jukebox, plays } = testJukebox();
  jukebox.add({ bytes: wav(4) });
  await until(() => plays[0]?.ms >= 3_000, "most of it to play", 6_000);
  const held = (jukebox as unknown as { current: { cursor: { held: number } } }).current.cursor.held;
  assert.ok(held <= 15, `${held} chunks of 100 ms held, not the ${30} played`);
  jukebox.close();
});

test("a track that can't be read or decoded ends with why, and the next plays", async () => {
  const { jukebox, events } = testJukebox({
    open: async source => {
      if ("url" in source) throw new HttpError(400, "Could not fetch https://example.com/gone.mp3 (HTTP 404)");
      return (async function* () { yield source.bytes; })();
    },
  });
  jukebox.add({ url: "https://example.com/gone.mp3" });
  jukebox.add({ bytes: new TextEncoder().encode("<html>not audio</html>") });
  const good = jukebox.add({ bytes: wav(0.2) });
  await until(() => events.some(event => event.type === "ended" && event.track.id === good.track.id), "the good one to play", 5_000);
  const errors = events.filter(event => event.type === "ended" && event.reason === "error");
  assert.equal(errors.length, 2);
  assert.match(errors[0].type === "ended" ? errors[0].error! : "", /HTTP 404/);
  assert.match(errors[1].type === "ended" ? errors[1].error! : "", /MP3, Ogg Opus or WAV/);
  assert.equal(jukebox.stats.errors, 2);
});

test("while the call's media reconnects, audio waits for it, then plays", async () => {
  const media = { up: false };
  const { jukebox, plays, events } = testJukebox({ media });
  jukebox.add({ bytes: wav(0.2) });
  await sleep(300);
  assert.equal(plays.length, 0);
  media.up = true;
  await until(() => events.some(event => event.type === "ended"), "it to play once the media is back", 5_000);
  assert.equal(plays.length, 1);
});

test("limits: tracks waiting, an upload's size and the uploads held", () => {
  const { jukebox } = testJukebox({ open: async () => (async function* () { await new Promise(() => {}); })() });
  jukebox.add({ url: "https://example.com/a.mp3" });
  for (let i = 0; i < AUDIO_LIMITS.queue; i++) jukebox.add({ url: `https://example.com/${i}.mp3` });
  assert.throws(() => jukebox.add({ url: "https://example.com/more.mp3" }), (error: HttpError) => error.status === 429);
  jukebox.stop();
  assert.throws(() => jukebox.add({ bytes: new Uint8Array(AUDIO_LIMITS.uploadBytes + 1) }), (error: HttpError) => error.status === 413);
  jukebox.add({ url: "https://example.com/playing.mp3" });
  for (let i = 0; i < AUDIO_LIMITS.uploadsBytes / AUDIO_LIMITS.uploadBytes; i++) jukebox.add({ bytes: new Uint8Array(AUDIO_LIMITS.uploadBytes) });
  assert.throws(() => jukebox.add({ bytes: new Uint8Array(1) }), (error: HttpError) => error.status === 429 && /hold at most/.test(error.message));
  jukebox.close();
  assert.throws(() => jukebox.add({ bytes: new Uint8Array(1) }), (error: HttpError) => error.status === 409);
});
