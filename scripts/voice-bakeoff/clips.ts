import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SpeechCredentials, SpeechProvider } from "../../src/speech.ts";

/**
 * The bake-off's audio: a fixed set of clips, each 24 kHz mono 16-bit PCM with the words said in it.
 *
 * The built-in set is SYNTHETIC: made with text to speech (OpenAI's gpt-4o-mini-tts, which takes instructions for
 * accent, pace and tone), then mixed for noise and overlap. Synthetic speech is cleaner and more regular than people,
 * so it flatters every provider; it is labelled `synthetic` in every report. For real speech, pass a directory of
 * recorded clips (`--clips`): `<id>.wav` (24 kHz mono 16-bit) with `<id>.txt` (the words)
 * and optionally `<id>.json` ({language, category}). Common Voice and FLEURS have accented and non-English speech under
 * licenses that allow it.
 */

export const RATE = 24_000;
export const BYTES_PER_MS = 48;

export type Category = "short" | "command" | "names" | "numbers" | "accent" | "pace" | "quiet" | "noise" | "overlap" | "non-english" | "code-switch" | "long" | "disfluent";

/** A clip as the manifest describes it: what is said, in what language, and how it is made. */
export type ClipSpec = {
  id: string; category: Category; language: string; text: string;
  /** Text to speech: the voice and how to say it. */
  voice?: string; instructions?: string;
  /** Mixed in after: white noise or babble (other clips) at an SNR (dB), a second speaker, a gain (dB). */
  noise?: { kind: "white" | "babble"; snrDb: number };
  overlap?: { text: string; voice: string; atFraction: number; gainDb: number };
  gainDb?: number;
};

export type Clip = ClipSpec & { pcm: Buffer; source: "synthetic" | "recorded" | "fake"; speechStartMs: number; speechEndMs: number };

export const CLIPS: ClipSpec[] = [
  { id: "short-yes", category: "short", language: "en", text: "Yes.", voice: "alloy" },
  { id: "short-stop", category: "short", language: "en", text: "Stop.", voice: "ash", instructions: "Firm, a little loud." },
  { id: "short-wait", category: "short", language: "en", text: "Wait, hold on.", voice: "coral" },
  { id: "cmd-volume", category: "command", language: "en", text: "Turn the music up a bit.", voice: "verse" },
  { id: "cmd-book", category: "command", language: "en", text: "Book a table for four at seven thirty tomorrow night.", voice: "sage" },
  { id: "names", category: "names", language: "en", text: "Can you ask Miguel and Illiana to review the camelRun pull request before Friday?", voice: "ballad" },
  { id: "numbers", category: "numbers", language: "en", text: "My order number is 4815162342 and the total was 37 dollars and 50 cents.", voice: "echo" },
  { id: "accent-indian", category: "accent", language: "en", text: "I would like to change my delivery address to the office, please.", voice: "shimmer", instructions: "Speak English with a strong Indian accent." },
  { id: "accent-scottish", category: "accent", language: "en", text: "We're heading out to the loch this weekend if the weather holds.", voice: "ash", instructions: "Speak English with a strong Scottish accent." },
  { id: "accent-nigerian", category: "accent", language: "en", text: "Please send me the invoice again, the first one did not arrive.", voice: "onyx", instructions: "Speak English with a Nigerian accent." },
  { id: "accent-spanish", category: "accent", language: "en", text: "Sorry, can you repeat the last part? I did not understand the price.", voice: "nova", instructions: "Speak English with a heavy Spanish accent." },
  { id: "pace-fast", category: "pace", language: "en", text: "Okay so first we deploy staging then we run the smoke tests and if those pass we ship it.", voice: "verse", instructions: "Speak very fast, like an excited engineer." },
  { id: "quiet", category: "quiet", language: "en", text: "I think we should keep this between us for now.", voice: "fable", instructions: "Speak softly, almost whispering.", gainDb: -12 },
  { id: "noise-cafe", category: "noise", language: "en", text: "Could you remind me to call the dentist at three?", voice: "coral", noise: { kind: "babble", snrDb: 5 } },
  { id: "noise-fan", category: "noise", language: "en", text: "The meeting moved to the big conference room upstairs.", voice: "sage", noise: { kind: "white", snrDb: 10 } },
  { id: "overlap", category: "overlap", language: "en", text: "Let's push the launch to next Tuesday so we have time to test.", voice: "alloy", overlap: { text: "No wait, Monday works better for me.", voice: "onyx", atFraction: 0.55, gainDb: -6 } },
  { id: "es", category: "non-english", language: "es", text: "¿Puedes recordarme llamar a mi madre mañana a las cinco?", voice: "nova" },
  { id: "fr", category: "non-english", language: "fr", text: "Est-ce que tu peux mettre la réunion à jeudi après-midi ?", voice: "shimmer" },
  { id: "de", category: "non-english", language: "de", text: "Kannst du bitte die Rechnung noch einmal an meine Adresse schicken?", voice: "onyx" },
  { id: "pt-br", category: "non-english", language: "pt", text: "Você pode me mandar o link da reunião de amanhã?", voice: "coral", instructions: "Brazilian Portuguese." },
  { id: "hi", category: "non-english", language: "hi", text: "क्या आप कल सुबह दस बजे मीटिंग रख सकते हैं?", voice: "sage" },
  { id: "ja", category: "non-english", language: "ja", text: "明日の午後三時に会議を入れてもらえますか。", voice: "alloy" },
  { id: "code-switch", category: "code-switch", language: "en", text: "Okay so the meeting es mañana a las diez, right?", voice: "nova", instructions: "A bilingual speaker switching between English and Spanish naturally." },
  { id: "disfluent", category: "disfluent", language: "en", text: "Um, so, I was, uh, thinking we could maybe move it to Friday?", voice: "ballad", instructions: "Hesitant, with natural pauses and fillers." },
  { id: "long", category: "long", language: "en", text: "So here's the plan for the quarter. We finish the voice work first, because people are already using it every day. Then we look at the billing dashboard, which a lot of customers asked for. Anything else waits until we have measured how both of those land.", voice: "echo" },
];

/** Where speech is in a clip: the first and last 20 ms frames louder than -45 dBFS. */
export function speechBounds(pcm: Buffer) {
  const frame = 20 * BYTES_PER_MS, threshold = 32768 * 10 ** (-45 / 20);
  let first = -1, last = -1;
  for (let at = 0, index = 0; at + 2 <= pcm.length; at += frame, index++) {
    let sum = 0, count = 0;
    for (let i = at; i + 1 < Math.min(pcm.length, at + frame); i += 2) { const sample = pcm.readInt16LE(i); sum += sample * sample; count++; }
    if (Math.sqrt(sum / Math.max(1, count)) > threshold) { if (first < 0) first = index; last = index; }
  }
  return first < 0 ? { speechStartMs: 0, speechEndMs: pcm.length / BYTES_PER_MS } : { speechStartMs: first * 20, speechEndMs: (last + 1) * 20 };
}

const gain = (pcm: Buffer, db: number) => {
  const out = Buffer.alloc(pcm.length), factor = 10 ** (db / 20);
  for (let i = 0; i + 1 < pcm.length; i += 2) out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(pcm.readInt16LE(i) * factor))), i);
  return out;
};
const rms = (pcm: Buffer) => { let sum = 0; for (let i = 0; i + 1 < pcm.length; i += 2) sum += pcm.readInt16LE(i) ** 2; return Math.sqrt(sum / Math.max(1, pcm.length / 2)); };

/** `extra` added into `base` from `atBytes` on (lengthening it if needed). */
export function mix(base: Buffer, extra: Buffer, atBytes = 0) {
  const at = atBytes & ~1;
  const out = Buffer.alloc(Math.max(base.length, at + extra.length));
  base.copy(out);
  for (let i = 0; i + 1 < extra.length; i += 2) out.writeInt16LE(Math.max(-32768, Math.min(32767, out.readInt16LE(at + i) + extra.readInt16LE(i))), at + i);
  return out;
}

/** Noise at `snrDb` under the clip's speech: white (a deterministic generator), or babble from other clips. */
export function addNoise(pcm: Buffer, kind: "white" | "babble", snrDb: number, babble: Buffer[] = []) {
  const level = rms(pcm) / 10 ** (snrDb / 20);
  let noise = Buffer.alloc(pcm.length);
  if (kind === "white" || !babble.length) {
    let seed = 12345;
    for (let i = 0; i + 1 < noise.length; i += 2) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; noise.writeInt16LE(Math.round(((seed / 0x7fffffff) * 2 - 1) * level * 1.7), i); }
  } else {
    for (const [index, other] of babble.entries()) noise = mix(noise, other.subarray(0, pcm.length), (index * 7919 * 2) % Math.max(2, pcm.length / 3));
    noise = gain(noise.subarray(0, pcm.length), 20 * Math.log10(level / Math.max(1, rms(noise.subarray(0, pcm.length)))));
  }
  return mix(pcm, noise);
}

/** 250 ms of silence each side, as a person's audio has around what they say. */
const padded = (pcm: Buffer) => Buffer.concat([Buffer.alloc(250 * BYTES_PER_MS), pcm, Buffer.alloc(250 * BYTES_PER_MS)]);

/**
 * The built-in clips, made with `tts` (cached in `cache` as `<id>.pcm`, so they are made once and every run hears the
 * same audio). Needs a key for the provider (OpenAI's by default).
 */
export async function syntheticClips(specs: ClipSpec[], tts: { provider: SpeechProvider; credentials: SpeechCredentials }, cache: string): Promise<Clip[]> {
  mkdirSync(cache, { recursive: true });
  const say = async (key: string, text: string, voice: string, instructions?: string) => {
    const file = join(cache, `${key}.pcm`);
    if (existsSync(file)) return readFileSync(file);
    const chunks: Buffer[] = [];
    for await (const chunk of tts.provider.stream({ text, voice, ...(instructions ? { instructions } : {}) }, tts.credentials, AbortSignal.timeout(60_000))) chunks.push(Buffer.from(chunk));
    const pcm = Buffer.concat(chunks);
    writeFileSync(file, pcm);
    return pcm;
  };
  const clean = new Map<string, Buffer>();
  for (const spec of specs) clean.set(spec.id, await say(`${spec.id}.clean`, spec.text, spec.voice ?? "alloy", spec.instructions));
  const clips: Clip[] = [];
  for (const spec of specs) {
    let pcm = clean.get(spec.id)!;
    if (spec.gainDb) pcm = gain(pcm, spec.gainDb);
    if (spec.overlap) {
      const other = await say(`${spec.id}.overlap`, spec.overlap.text, spec.overlap.voice);
      pcm = mix(pcm, gain(other, spec.overlap.gainDb), Math.round(pcm.length * spec.overlap.atFraction));
    }
    if (spec.noise) pcm = addNoise(pcm, spec.noise.kind, spec.noise.snrDb, [...clean.entries()].filter(([id]) => id !== spec.id && id.startsWith("accent")).map(([, audio]) => audio));
    pcm = padded(pcm);
    clips.push({ ...spec, pcm, source: "synthetic", ...speechBounds(pcm) });
  }
  return clips;
}

/** Recorded clips from a directory: `<id>.wav` (24 kHz mono 16-bit PCM WAV) and `<id>.txt`, `<id>.json` optional. */
export function recordedClips(directory: string): Clip[] {
  return readdirSync(directory).filter(name => name.endsWith(".wav")).sort().map(name => {
    const id = name.slice(0, -4);
    const wav = readFileSync(join(directory, name));
    const { pcm, rate, channels } = wavPcm(wav);
    if (rate !== RATE || channels !== 1) throw new Error(`${name} is ${rate} Hz, ${channels} channel(s): the bake-off takes 24 kHz mono (ffmpeg -i in.wav -ar 24000 -ac 1 -sample_fmt s16 out.wav)`);
    const text = readFileSync(join(directory, `${id}.txt`), "utf8").trim();
    const meta = existsSync(join(directory, `${id}.json`)) ? JSON.parse(readFileSync(join(directory, `${id}.json`), "utf8")) : {};
    return { id, category: meta.category ?? "accent", language: meta.language ?? "en", text, pcm, source: "recorded" as const, ...speechBounds(pcm) };
  });
}

/** For a dry run: each clip as tone (speech) with silence around it, about as long as its text takes to say. */
export function fakeClips(specs: ClipSpec[]): Clip[] {
  return specs.map(spec => {
    const speechMs = Math.max(300, Math.min(8_000, spec.text.length * 60));
    const tone = Buffer.alloc(speechMs * BYTES_PER_MS);
    for (let i = 0; i + 1 < tone.length; i += 2) tone.writeInt16LE(Math.round(6000 * Math.sin(2 * Math.PI * 220 * (i / 2) / RATE)), i);
    const pcm = padded(tone);
    return { ...spec, pcm, source: "fake" as const, ...speechBounds(pcm) };
  });
}

/** A WAV's PCM (16-bit only). */
export function wavPcm(wav: Buffer) {
  if (wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") throw new Error("not a WAV file");
  let at = 12, rate = 0, channels = 0, bits = 0;
  while (at + 8 <= wav.length) {
    const id = wav.toString("ascii", at, at + 4), size = wav.readUInt32LE(at + 4);
    if (id === "fmt ") { channels = wav.readUInt16LE(at + 10); rate = wav.readUInt32LE(at + 12); bits = wav.readUInt16LE(at + 22); }
    if (id === "data") {
      if (bits !== 16) throw new Error("only 16-bit WAV is taken");
      return { pcm: wav.subarray(at + 8, at + 8 + size), rate, channels };
    }
    at += 8 + size + (size & 1);
  }
  throw new Error("WAV without data");
}

/** PCM as a WAV file (24 kHz mono 16-bit), for batch transcription. */
export function wavFile(pcm: Buffer) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii"); header.writeUInt32LE(36 + pcm.length, 4); header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii"); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24); header.writeUInt32LE(RATE * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii"); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
