import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Real people's speech for the eval's speakers (VOICE_EVAL_SPEAKERS=clips): WAV clips, each a turn that ends (complete)
 * or stops mid-thought (incomplete), as pipecat's Smart Turn test set has them (scripts/voice-turns-dataset.py writes
 * them with an index.json; tests/fixtures/voice-turns/ has four). A turn's last piece is a complete clip and a piece
 * before a pause an incomplete one, in the turn's language when there is one, so turn detection hears what it would.
 * The words a clip says are not the scenario's: the fake transcriber still answers the scenario's words, by frame.
 */

export type Clip = { file: string; language: string; complete: boolean; samples: Int16Array };

const LANGUAGES: Record<string, string> = { en: "eng", es: "spa", fr: "fra", pt: "por", hi: "hin", de: "deu", it: "ita", ja: "jpn", zh: "zho" };

/** 16-bit PCM WAV samples (mono, or the first channel) and their rate. */
export function wavSamples(bytes: Buffer): { rate: number; samples: Int16Array } {
  if (bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") throw new Error("not a WAV file");
  let at = 12, rate = 0, channels = 1, bits = 16;
  while (at + 8 <= bytes.length) {
    const id = bytes.toString("ascii", at, at + 4), size = bytes.readUInt32LE(at + 4);
    if (id === "fmt ") { channels = bytes.readUInt16LE(at + 10); rate = bytes.readUInt32LE(at + 12); bits = bytes.readUInt16LE(at + 22); }
    if (id === "data") {
      if (bits !== 16) throw new Error(`a ${bits}-bit WAV: 16-bit only`);
      const count = Math.floor(size / 2 / channels), samples = new Int16Array(count);
      for (let i = 0; i < count; i++) samples[i] = bytes.readInt16LE(at + 8 + i * 2 * channels);
      return { rate, samples };
    }
    at += 8 + size + (size & 1);
  }
  throw new Error("a WAV without data");
}

/** `samples` at `from` Hz as 24 kHz (linear), the rate the eval's speakers are made at (framesOf). */
function to24k(samples: Int16Array, from: number): Int16Array {
  if (from === 24_000) return samples;
  const out = new Int16Array(Math.floor(samples.length * 24_000 / from));
  for (let i = 0; i < out.length; i++) {
    const at = i * from / 24_000, low = Math.floor(at), high = Math.min(low + 1, samples.length - 1);
    out[i] = Math.round(samples[low]! + (samples[high]! - samples[low]!) * (at - low));
  }
  return out;
}

/** The clips in `dir`: its index.json ({file, language, complete}), else every `<lang>-<c|i>-<id>.wav`. */
export function loadClips(dir: string): Clip[] {
  if (!existsSync(dir)) throw new Error(`VOICE_EVAL_CLIPS: no directory ${dir} (scripts/voice-turns-dataset.py <dir> makes one)`);
  const index = existsSync(join(dir, "index.json"))
    ? (JSON.parse(readFileSync(join(dir, "index.json"), "utf8")) as Array<{ file: string; language: string; complete: boolean }>)
    : readdirSync(dir).flatMap(file => { const match = /^([a-z]{3})-([ci])-/.exec(file); return match && file.endsWith(".wav") ? [{ file, language: match[1]!, complete: match[2] === "c" }] : []; });
  const clips = index.map(entry => {
    const { rate, samples } = wavSamples(readFileSync(join(dir, entry.file)));
    return { ...entry, samples: to24k(samples, rate) };
  });
  if (!clips.some(clip => clip.complete)) throw new Error(`VOICE_EVAL_CLIPS: ${dir} has no complete clip`);
  return clips;
}

/**
 * The clip a turn's piece is said with, as 24 kHz mono 16-bit PCM bytes: complete for its last piece, incomplete for
 * one before a pause (complete when there is none), in its language when one is there, picked in turn by `seed`.
 */
export function clipFor(clips: Clip[], options: { language?: string; complete: boolean; seed: number }): Uint8Array {
  const language = LANGUAGES[options.language ?? "en"] ?? options.language ?? "eng";
  const kind = clips.filter(clip => clip.complete === options.complete);
  const pool = [kind.filter(clip => clip.language === language), kind, clips].find(list => list.length)!;
  const clip = pool[options.seed % pool.length]!;
  return new Uint8Array(clip.samples.buffer, clip.samples.byteOffset, clip.samples.byteLength);
}
