import { test } from "node:test";
import assert from "node:assert/strict";
import OpusScript from "opusscript";
import { Opus, OpusError } from "../src/opus.ts";
import { Segmenter, type Cut } from "../src/voice-audio.ts";

/** 20 ms of a 440 Hz tone, 48 kHz stereo, at about -13 dBFS: frame `index` of a continuous one. */
function tone(index: number) {
  const pcm = Buffer.alloc(960 * 4);
  for (let i = 0; i < 960; i++) {
    const sample = Math.round(8_000 * Math.sin(2 * Math.PI * 440 * (index * 960 + i) / 48_000));
    pcm.writeInt16LE(sample, i * 4); pcm.writeInt16LE(sample, i * 4 + 2);
  }
  return pcm;
}
const rms = (pcm: Buffer) => { let sum = 0; for (let i = 0; i < pcm.length; i += 2) sum += pcm.readInt16LE(i) ** 2; return Math.sqrt(sum / (pcm.length / 2)); };
/** The tone through `encoder` and `decoder`, 20 frames: the last frame's level (the tone's is about 5,660). */
function roundTrip(encoder: { encode(pcm: Buffer, frameSize: number): Buffer }, decoder: { decode(packet: Buffer): Buffer }) {
  let last = Buffer.alloc(0);
  for (let index = 0; index < 20; index++) last = Buffer.from(decoder.decode(encoder.encode(tone(index), 960)));
  return rms(last);
}

test("codecs keep working with many alive at once, across the module's memory growing; packets are opusscript's", () => {
  const first = new Opus(48_000, 2, "audio"), firstDecoder = new Opus(48_000, 2, "audio");
  assert.ok(Math.abs(roundTrip(first, firstDecoder) - 5_660) < 300);
  // Enough codecs that the module's memory grows and allocations sit past half of it: where opusscript's own wrapper
  // views its buffers (twice the address), and so where every one of its calls trapped in production.
  const many = Array.from({ length: 400 }, () => new Opus(48_000, 2, "audio"));
  assert.ok(Math.abs(roundTrip(first, firstDecoder) - 5_660) < 300, "made before the growth");
  assert.ok(Math.abs(roundTrip(many.at(-1)!, many.at(-2)!) - 5_660) < 300, "made after it");
  // The same bitstream and PCM layout as opusscript's.
  const theirs = new OpusScript(48_000, 2, OpusScript.Application.AUDIO);
  assert.ok(Math.abs(roundTrip(new Opus(48_000, 2, "audio"), theirs) - 5_660) < 300);
  theirs.delete();
  for (const codec of many) codec.delete();
});

test("a codec that trapped is broken, not fatal: its calls throw OpusError, delete never throws, and new codecs work", () => {
  const codec = new Opus(16_000, 1, "voip");
  // A trap in the module, as production met it.
  (codec as any).handler._decode = () => { throw new WebAssembly.RuntimeError("memory access out of bounds"); };
  assert.throws(() => codec.decode(new Uint8Array([0x78, 1, 2, 3])), OpusError);
  assert.equal(codec.broken, true);
  assert.throws(() => codec.decode(new Uint8Array([0x78, 1, 2, 3])), /broken/);
  codec.delete(); codec.delete();
  const fresh = new Opus(48_000, 2, "audio");
  assert.ok(Math.abs(roundTrip(fresh, new Opus(48_000, 2, "audio")) - 5_660) < 300, "a new module serves new codecs");
  fresh.delete(); fresh.delete();
  assert.throws(() => fresh.encode(tone(0), 960), /deleted/);
});

test("a speaker whose decoder breaks: what they said so far is cut, and their next packet starts afresh; the silence timer never throws", async () => {
  const encoder = new Opus(48_000, 2, "audio");
  const packets = Array.from({ length: 40 }, (_, index) => encoder.encode(tone(index), 960));
  const cuts: Cut[] = [];
  let throwing = false;
  const segmenter = new Segmenter({ silenceMs: 50, minMs: 100, padMs: 20, cut: cut => { cuts.push(cut); if (throwing) throw new Error("a cut that fails"); } });
  for (const packet of packets.slice(0, 20)) segmenter.packet("person", packet);
  const decoder = (segmenter as any).speaking.get("person").decoder as Opus;
  (decoder as any).handler._decode = () => { throw new WebAssembly.RuntimeError("memory access out of bounds"); };
  segmenter.packet("person", packets[20]);
  assert.equal(cuts.length, 1); assert.equal(cuts[0].ended, "error");
  assert.equal(segmenter.open, 0);
  for (const packet of packets.slice(21)) segmenter.packet("person", packet);
  assert.equal(segmenter.open, 1, "a new decoder");
  // The silence timer's cut fails: logged, never thrown into the timer (which would end the process).
  throwing = true;
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(cuts.length, 2); assert.equal(segmenter.open, 0);
});
