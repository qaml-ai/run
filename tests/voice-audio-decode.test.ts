import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AUDIO_RATE, decodeAudio, MP3_SNIFF_BYTES, mp3Frame, Resampler, sniff } from "../src/voice/audio-decode.ts";

/** Audio files decoded for a call (src/voice/audio-decode.ts): MP3, Ogg Opus and WAV, to 24 kHz mono 16-bit. */

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/audio/${name}`, import.meta.url)));

/** `bytes` in pieces of `size`, as a download comes. */
async function* pieces(bytes: Uint8Array, size = 1_000) {
  for (let at = 0; at < bytes.length; at += size) yield bytes.subarray(at, at + size);
}

/** Decoded: seconds, peak, and the dominant frequency by zero crossings. */
async function decoded(bytes: Uint8Array, size?: number) {
  const chunks: Uint8Array[] = [];
  for await (const chunk of decodeAudio(pieces(bytes, size))) chunks.push(chunk);
  const all = Buffer.concat(chunks);
  const samples = new Int16Array(all.buffer, all.byteOffset, all.byteLength / 2);
  let peak = 0, crossings = 0;
  for (let i = 0; i < samples.length; i++) {
    peak = Math.max(peak, Math.abs(samples[i]));
    if (i && (samples[i - 1] < 0) !== (samples[i] < 0)) crossings++;
  }
  const seconds = samples.length / AUDIO_RATE;
  return { seconds, peak, hz: crossings / 2 / seconds };
}

/** A WAV file of a 440 Hz tone: `rate`, `channels`, 16-bit. */
function wav(seconds: number, rate: number, channels: number) {
  const frames = Math.round(seconds * rate);
  const data = Buffer.alloc(frames * channels * 2);
  for (let i = 0; i < frames; i++) for (let c = 0; c < channels; c++) data.writeInt16LE(Math.round(10_000 * Math.sin(2 * Math.PI * 440 * i / rate)), (i * channels + c) * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + data.length, 4); header.write("WAVE", 8);
  header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * channels * 2, 28); header.writeUInt16LE(channels * 2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(data.length, 40);
  // An extra chunk before data is skipped.
  const list = Buffer.concat([Buffer.from("LIST"), Buffer.from([4, 0, 0, 0]), Buffer.from("INFO")]);
  return new Uint8Array(Buffer.concat([header.subarray(0, 36), list, header.subarray(36), data]));
}

test("MP3 (with an ID3 tag, 44.1 kHz stereo; and MPEG 2.5 at 8 kHz) decodes the same in any pieces", async () => {
  const mp3 = fixture("tone-44k.mp3");
  assert.equal(sniff(mp3), "mp3");
  const whole = await decoded(mp3, mp3.length);
  const small = await decoded(mp3, 333);
  assert.ok(Math.abs(whole.seconds - 1) < 0.1, `about a second (${whole.seconds})`);
  assert.equal(small.seconds, whole.seconds);
  assert.ok(Math.abs(whole.hz - 440) < 10, `a 440 Hz tone (${whole.hz})`);
  assert.ok(whole.peak > 1_000);
  const low = await decoded(fixture("tone.mp3"));
  // Its encoder delay and padding are played (a LAME tag's gapless trim is not read): a few frames of silence.
  assert.ok(low.seconds >= 2 && low.seconds < 2.3, `about two seconds (${low.seconds})`);
  assert.ok(low.peak > 1_000);
});

test("Ogg Opus and WAV (8-bit at 8 kHz; 16-bit stereo at 44.1 kHz with an extra chunk) decode", async () => {
  const opus = fixture("tone.ogg");
  assert.equal(sniff(opus), "opus");
  const tone = await decoded(opus, 500);
  assert.ok(Math.abs(tone.seconds - 2) < 0.1, `about two seconds (${tone.seconds})`);
  assert.ok(tone.peak > 1_000);
  const u8 = await decoded(fixture("tone.wav"));
  assert.ok(Math.abs(u8.seconds - 2) < 0.01);
  const stereo = await decoded(wav(1.5, 44_100, 2), 777);
  assert.ok(Math.abs(stereo.seconds - 1.5) < 0.01, `${stereo.seconds}`);
  assert.ok(Math.abs(stereo.hz - 440) < 5, `${stereo.hz}`);
  assert.ok(Math.abs(stereo.peak - 10_000) < 600, `level kept (${stereo.peak})`);
});

test("what isn't MP3, Ogg Opus or WAV is refused, saying what is played", async () => {
  const refused = async (bytes: Uint8Array) => {
    try { for await (const _ of decodeAudio(pieces(bytes))) { /* none */ } }
    catch (error) { return error as { status: number; code: string; message: string }; }
    throw new Error("not refused");
  };
  for (const name of ["tone.flac", "tone.m4a", "tone.webm"]) {
    const error = await refused(fixture(name));
    assert.equal(error.status, 415, name);
    assert.equal(error.code, "AUDIO_UNSUPPORTED");
    assert.match(error.message, /MP3, Ogg Opus or WAV/);
  }
  // Ogg Vorbis: named as such.
  const vorbis = new Uint8Array(64);
  vorbis.set(Buffer.from("OggS"), 0);
  vorbis[26] = 1; vorbis[27] = 30;
  vorbis.set(Buffer.from("\x01vorbis"), 28);
  assert.match((await refused(vorbis)).message, /Vorbis isn't supported/);
  assert.equal((await refused(new TextEncoder().encode("<html>not found</html>"))).status, 415);
  // An MP3 with no frames after its tag.
  const empty = Buffer.concat([Buffer.from("ID3"), Buffer.from([4, 0, 0, 0, 0, 0, 0]), Buffer.alloc(20)]);
  assert.equal((await refused(new Uint8Array(empty))).status, 422);
});

/** Where the first frame after an MP3's ID3 tag starts. */
function firstFrame(mp3: Uint8Array) {
  const size = ((mp3[6] & 0x7f) << 21) | ((mp3[7] & 0x7f) << 14) | ((mp3[8] & 0x7f) << 7) | (mp3[9] & 0x7f);
  return 10 + size;
}

test("an MP3 stream joined mid-frame is told by two frames in a row, and decodes", async () => {
  // As a live stream can answer: from the middle of a frame, the first whole one further in.
  const mp3 = fixture("tone-44k.mp3");
  const first = firstFrame(mp3);
  const length = mp3Frame(mp3, first)!;
  assert.ok(length > 1 && mp3Frame(mp3, first + length), "the fixture's frames follow each other");
  const joined = mp3.subarray(first + length + Math.floor(length / 2));
  assert.ok(!(joined[0] === 0xff && mp3Frame(joined, 0)), "no frame at its first byte");
  assert.equal(sniff(joined), "mp3");
  const tone = await decoded(joined, 333);
  assert.ok(tone.seconds > 0.5 && tone.seconds < 1.1, `most of a second (${tone.seconds})`);
  // Counted over its length, and the frames first decoded are silent (the bytes they lean on were before the join).
  assert.ok(Math.abs(tone.hz - 440) < 30, `a 440 Hz tone (${tone.hz})`);
  assert.ok(tone.peak > 1_000);
  // The longest frames (320 kbps at 32 kHz: 1,440 bytes), joined one byte in: still inside what is looked at.
  const header = [0xff, 0xfb, 0xe8, 0x00];
  const frame = new Uint8Array(1440);
  frame.set(header);
  assert.equal(mp3Frame(frame, 0), 1440);
  const longest = new Uint8Array(Buffer.concat([Buffer.alloc(1439), frame, frame, frame]));
  assert.equal(sniff(longest.subarray(0, MP3_SNIFF_BYTES)), "mp3");
});

test("what only looks like an MP3 frame here and there is still refused", async () => {
  const header = [0xff, 0xfb, 0x90, 0x00];
  // A lone frame header, with nothing where its next frame would be.
  const lone = new Uint8Array(4096);
  lone.set(header, 100);
  assert.equal(sniff(lone), undefined);
  // Two frames in a row, but past what is looked at.
  const late = new Uint8Array(MP3_SNIFF_BYTES + 2048);
  const length = mp3Frame(new Uint8Array([...header]), 0)!;
  late.set(header, MP3_SNIFF_BYTES);
  late.set(header, MP3_SNIFF_BYTES + length);
  assert.equal(sniff(late), undefined);
  // A long page is no audio, however much of it is read.
  const page = new TextEncoder().encode(`<!doctype html><html><body>${"<p>not audio</p>".repeat(1_000)}</body></html>`);
  assert.ok(page.length > MP3_SNIFF_BYTES);
  assert.equal(sniff(page), undefined);
  const refused = await (async () => {
    try { for await (const _ of decodeAudio(pieces(page))) { /* none */ } }
    catch (error) { return error as { status: number; code: string }; }
    throw new Error("not refused");
  })();
  assert.deepEqual([refused.status, refused.code], [415, "AUDIO_UNSUPPORTED"]);
});

test("the resampler keeps a tone's pitch and level across blocks, filtering what is above the new rate", () => {
  const rate = 48_000;
  const resampler = new Resampler(rate);
  const out: number[] = [];
  for (let block = 0; block < 10; block++) {
    const input = new Float32Array(4_800);
    for (let i = 0; i < input.length; i++) {
      const n = block * input.length + i;
      // 1 kHz (kept) plus 20 kHz (above 12 kHz: filtered, not aliased to 4 kHz).
      input[i] = 0.5 * Math.sin(2 * Math.PI * 1_000 * n / rate) + 0.3 * Math.sin(2 * Math.PI * 20_000 * n / rate);
    }
    out.push(...resampler.push(input));
  }
  assert.ok(Math.abs(out.length - 24_000) <= 2, `${out.length} samples for a second`);
  // Correlate with 1 kHz and 4 kHz (where 20 kHz would alias).
  const level = (hz: number) => {
    let re = 0, im = 0;
    for (let i = 1_000; i < out.length; i++) { re += out[i] * Math.cos(2 * Math.PI * hz * i / AUDIO_RATE); im += out[i] * Math.sin(2 * Math.PI * hz * i / AUDIO_RATE); }
    return 2 * Math.hypot(re, im) / (out.length - 1_000);
  };
  assert.ok(Math.abs(level(1_000) - 0.5) < 0.05, `1 kHz kept (${level(1_000)})`);
  assert.ok(level(4_000) < 0.02, `20 kHz not aliased (${level(4_000)})`);
});
