/**
 * Speech-to-speech latency probe (docs/design/voice-lifelike.md): how soon a realtime speech-to-speech model answers
 * aloud after someone stops talking, beside the text step of our cascade, on the same clips. A research script: it
 * touches no production code path, setting or key; it calls each provider directly with the keys in the environment.
 *
 *   node --experimental-strip-types scripts/voice-s2s-latency.ts [--providers openai,gemini,cascade] [--repeat 3]
 *        [--clips <dir>] [--only id,id] [--tool] [--vad] [--out report.json]
 *
 * Keys: OPENAI_API_KEY (openai), GEMINI_API_KEY (gemini), OPENROUTER_API_KEY (cascade). A provider without its key is
 * skipped. Models: OPENAI_REALTIME_MODEL (default gpt-realtime-2.1), GEMINI_LIVE_MODEL (default
 * gemini-3.8-live), CASCADE_MODEL (default deepseek/deepseek-v4.1-flash, an OpenRouter id), and CASCADE_BODY: JSON
 * merged into the chat request (e.g. '{"reasoning":{"enabled":false}}').
 *
 * Clips: the voice bake-off's synthetic set (24 kHz mono s16 PCM cached in ~/.cache/camelrun-voice-bakeoff as
 * `<id>.clean.pcm`, made by `npm run bakeoff:voice`), or `--clips <dir>` of `<id>.wav` (24 kHz mono 16-bit) recorded
 * ones. Only clips that ask for something are used by default.
 *
 * What is measured, each from the end of speech (the clip's last frame over -45 dBFS), audio sent in real time as
 * 20 ms frames:
 *
 * - openai / gemini, default: the turn is ended by us at the end of speech (OpenAI `input_audio_buffer.commit` +
 *   `response.create`; Gemini `activityEnd`), the best case for a turn detector we run, as our cascade's commit is.
 *   `firstAudioMs` is the first audio delta of the answer. With `--vad`, the provider's own turn detection ends the turn
 *   instead (OpenAI semantic_vad at eagerness auto; Gemini automatic activity detection), and silence keeps streaming:
 *   the number then includes the provider's end-of-turn wait, comparable with our turnCommit + everything after it.
 * - `--tool`: the model is given one function (`lookup`) and told to call it before answering. `toolCallMs` is when the
 *   call's arguments are whole; the tool answers at once, and `firstAudioMs` is the spoken answer after it. This is the
 *   shape of a camel bot's turn (code runs, then it talks).
 * - cascade: our text step alone, on the clip's known words (as if STT were instant): `firstClauseMs`, the first
 *   clause of the reply (24 characters and a clause mark, or a sentence end; what voice-streaming speaks first), from an
 *   OpenRouter chat completion streamed. Add the measured STT and TTS stages (the report's `cascadeEstimateMs`) to
 *   compare: commit (smart end of turn, 500 ms after Smart Turn's call), STT after the commit, TTS first sound.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const RATE = 24_000;
const BYTES_PER_MS = 48;
const FRAME_BYTES = 20 * BYTES_PER_MS;

/** Clips that ask the bot for something (from scripts/voice-bakeoff/clips.ts). */
const ASKING = ["cmd-book", "names", "accent-spanish", "noise-cafe", "es", "fr", "pt-br", "code-switch", "disfluent", "cmd-volume"];

/**
 * Stages of our cascade that this probe does not run, in ms, so a cascade estimate sits next to the S2S numbers.
 * Sources: smart end-of-turn commit at defaults (docs/guides/voice-calls.md: 580 ms median after the last word on
 * 920 turns); batch gpt-transcribe after the commit (prod voice_turn_latency, 19 spoken turns on 2026-10-18: 742 ms
 * median); preemptive live STT (#262: text 729 ms after speech, against 960 at the cut); ElevenLabs Flash first sound
 * warm (bake-off, #248: 145 ms); playout (prod: about 60 ms first audio to first packet).
 */
const CASCADE_STAGES = { commitMs: 580, sttAfterCommitMs: 742, preemptiveSttTextMs: 729, ttsFirstSoundMs: 145, playoutMs: 60 };

type Clip = { id: string; pcm: Buffer; speechEndMs: number };
type Sample = { provider: string; clip: string; mode: string; firstAudioMs?: number; toolCallMs?: number; firstClauseMs?: number; firstTokenMs?: number; error?: string };

const SYSTEM = "You are a friendly voice assistant in a Discord voice call. Answer in one or two short spoken sentences.";
const TOOL_SYSTEM = `${SYSTEM} Before every answer, call the lookup function with the user's request, then answer using its result.`;
const LOOKUP = { name: "lookup", description: "Look up facts or perform the user's request. Always call it before answering.", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } };
const LOOKUP_RESULT = { ok: true, result: "Done. Everything the user asked for is set." };

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const now = () => performance.now();

function speechEnd(pcm: Buffer) {
  const threshold = 32768 * 10 ** (-45 / 20);
  let last = -1;
  for (let at = 0, index = 0; at + 2 <= pcm.length; at += FRAME_BYTES, index++) {
    let sum = 0, count = 0;
    for (let i = at; i + 1 < Math.min(pcm.length, at + FRAME_BYTES); i += 2) { const s = pcm.readInt16LE(i); sum += s * s; count++; }
    if (Math.sqrt(sum / Math.max(1, count)) > threshold) last = index;
  }
  return (last + 1) * 20;
}

function wavPcm(wav: Buffer) {
  let at = 12;
  while (at + 8 <= wav.length) {
    const id = wav.toString("ascii", at, at + 4), size = wav.readUInt32LE(at + 4);
    if (id === "data") return wav.subarray(at + 8, at + 8 + size);
    at += 8 + size + (size & 1);
  }
  throw new Error("WAV without data");
}

function loadClips(dir: string | undefined, only: string[]): Clip[] {
  if (dir) {
    return readdirSync(dir).filter(name => name.endsWith(".wav")).map(name => name.slice(0, -4)).filter(id => !only.length || only.includes(id)).map(id => {
      const pcm = wavPcm(readFileSync(join(dir, `${id}.wav`)));
      return { id, pcm, speechEndMs: speechEnd(pcm) };
    });
  }
  const cache = join(homedir(), ".cache", "camelrun-voice-bakeoff");
  const ids = only.length ? only : ASKING;
  return ids.filter(id => existsSync(join(cache, `${id}.clean.pcm`))).map(id => {
    // 250 ms of silence before, as the bake-off pads; the trailing silence is streamed by the probe itself.
    const pcm = Buffer.concat([Buffer.alloc(250 * BYTES_PER_MS), readFileSync(join(cache, `${id}.clean.pcm`))]);
    return { id, pcm, speechEndMs: speechEnd(pcm) };
  });
}

/** Clip text (for the cascade), from the bake-off's manifest. */
async function clipTexts(): Promise<Map<string, string>> {
  const { CLIPS } = await import("./voice-bakeoff/clips.ts");
  return new Map(CLIPS.map(spec => [spec.id, spec.text]));
}

/** Send the clip's frames in real time up to its end of speech (`onSpeechEnd`), then room tone until `silenceUntil` holds. */
async function stream(clip: Clip, send: (frame: Buffer) => void, opts: { silenceUntil?: () => boolean; maxSilenceMs?: number; onSpeechEnd?: (at: number) => void } = {}) {
  const start = now();
  const end = clip.speechEndMs * BYTES_PER_MS;
  let at = 0, frames = 0;
  while (at < end) {
    send(clip.pcm.subarray(at, Math.min(end, at + FRAME_BYTES)));
    at += FRAME_BYTES; frames++;
    const due = start + frames * 20 - now();
    if (due > 0) await sleep(due);
  }
  const speechEndAt = now();
  opts.onSpeechEnd?.(speechEndAt);
  if (opts.silenceUntil) {
    // Room tone at about -60 dBFS rather than digital zeros, as a real microphone sends.
    const silence = Buffer.alloc(FRAME_BYTES);
    let seed = 1;
    for (let i = 0; i + 1 < silence.length; i += 2) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; silence.writeInt16LE(Math.round(((seed / 0x7fffffff) * 2 - 1) * 33), i); }
    const until = speechEndAt + (opts.maxSilenceMs ?? 6_000);
    while (!opts.silenceUntil() && now() < until) {
      send(silence); frames++;
      const due = start + frames * 20 - now();
      if (due > 0) await sleep(due);
    }
  }
  return speechEndAt;
}

function socketText(data: unknown): Promise<string> | string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (typeof Blob !== "undefined" && data instanceof Blob) return data.text();
  return String(data);
}

function open(url: string, headers?: Record<string, string>): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, (headers ? { headers } : undefined) as never);
    socket.binaryType = "arraybuffer";
    socket.addEventListener("open", () => resolve(socket), { once: true });
    socket.addEventListener("error", event => reject(new Error(`WebSocket error: ${(event as ErrorEvent).message ?? "connect failed"}`)), { once: true });
  });
}

/** OpenAI Realtime (GA event names; the beta's `response.audio.delta` is accepted too). */
async function openaiTurn(clip: Clip, key: string, opts: { tool: boolean; vad: boolean }): Promise<Sample> {
  const model = process.env.OPENAI_REALTIME_MODEL ?? "gpt-realtime-2.1";
  const socket = await open(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`, { Authorization: `Bearer ${key}` });
  const sample: Sample = { provider: `openai/${model}`, clip: clip.id, mode: `${opts.vad ? "vad" : "commit"}${opts.tool ? "+tool" : ""}` };
  let speechEndAt = 0, answered = false;
  const done = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no audio within 20 s")), 20_000);
    socket.addEventListener("message", async event => {
      const message = JSON.parse(await socketText(event.data));
      if (message.type === "error") { clearTimeout(timer); reject(new Error(message.error?.message ?? "error")); return; }
      if (message.type === "response.function_call_arguments.done") {
        sample.toolCallMs ??= Math.round(now() - speechEndAt);
        socket.send(JSON.stringify({ type: "conversation.item.create", item: { type: "function_call_output", call_id: message.call_id, output: JSON.stringify(LOOKUP_RESULT) } }));
        socket.send(JSON.stringify({ type: "response.create" }));
      }
      if ((message.type === "response.output_audio.delta" || message.type === "response.audio.delta") && speechEndAt && sample.firstAudioMs === undefined) {
        sample.firstAudioMs = Math.round(now() - speechEndAt);
        answered = true; clearTimeout(timer); resolve();
      }
    });
  });
  socket.send(JSON.stringify({
    type: "session.update",
    session: {
      type: "realtime", model, instructions: opts.tool ? TOOL_SYSTEM : SYSTEM, output_modalities: ["audio"],
      audio: { input: { format: { type: "audio/pcm", rate: RATE }, turn_detection: opts.vad ? { type: "semantic_vad", eagerness: "auto", create_response: true, interrupt_response: true } : null } },
      ...(opts.tool ? { tools: [{ type: "function", ...LOOKUP }], tool_choice: "auto" } : {}),
    },
  }));
  const send = (frame: Buffer) => socket.send(JSON.stringify({ type: "input_audio_buffer.append", audio: frame.toString("base64") }));
  try {
    speechEndAt = await stream(clip, send, opts.vad ? { silenceUntil: () => answered, onSpeechEnd: at => { speechEndAt = at; } } : {});
    if (!opts.vad) {
      socket.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      socket.send(JSON.stringify({ type: "response.create" }));
    }
    await done;
  } catch (error) { sample.error = (error as Error).message; }
  finally { socket.close(); }
  return sample;
}

/** Gemini Live (BidiGenerateContent over WebSocket, v1beta). */
async function geminiTurn(clip: Clip, key: string, opts: { tool: boolean; vad: boolean }): Promise<Sample> {
  const model = process.env.GEMINI_LIVE_MODEL ?? "gemini-3.8-live";
  const socket = await open(`wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(key)}`);
  const sample: Sample = { provider: `gemini/${model}`, clip: clip.id, mode: `${opts.vad ? "vad" : "commit"}${opts.tool ? "+tool" : ""}` };
  let speechEndAt = 0, answered = false;
  let ready!: () => void;
  const setup = new Promise<void>(resolve => { ready = resolve; });
  const done = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no audio within 20 s")), 20_000);
    socket.addEventListener("close", event => { clearTimeout(timer); if (!answered) reject(new Error(`closed ${event.code} ${event.reason}`)); });
    socket.addEventListener("message", async event => {
      const message = JSON.parse(await socketText(event.data));
      if (process.env.S2S_DEBUG) console.error(`gemini +${Math.round(now() - speechEndAt)}ms`, JSON.stringify(message).slice(0, 300));
      if (message.setupComplete) { ready(); return; }
      if (message.toolCall?.functionCalls?.length) {
        sample.toolCallMs ??= Math.round(now() - speechEndAt);
        socket.send(JSON.stringify({ toolResponse: { functionResponses: message.toolCall.functionCalls.map((call: { id: string; name: string }) => ({ id: call.id, name: call.name, response: LOOKUP_RESULT })) } }));
      }
      const parts = message.serverContent?.modelTurn?.parts ?? [];
      if (speechEndAt && sample.firstAudioMs === undefined && parts.some((part: { inlineData?: { mimeType?: string } }) => part.inlineData?.mimeType?.startsWith("audio/"))) {
        sample.firstAudioMs = Math.round(now() - speechEndAt);
        answered = true; clearTimeout(timer); resolve();
      }
    });
  });
  socket.send(JSON.stringify({
    setup: {
      model: `models/${model}`, generationConfig: { responseModalities: ["AUDIO"] },
      systemInstruction: { parts: [{ text: opts.tool ? TOOL_SYSTEM : SYSTEM }] },
      ...(opts.vad ? {} : { realtimeInputConfig: { automaticActivityDetection: { disabled: true } } }),
      ...(opts.tool ? { tools: [{ functionDeclarations: [LOOKUP] }] } : {}),
    },
  }));
  try {
    await setup;
    if (!opts.vad) socket.send(JSON.stringify({ realtimeInput: { activityStart: {} } }));
    const send = (frame: Buffer) => socket.send(JSON.stringify({ realtimeInput: { audio: { data: frame.toString("base64"), mimeType: `audio/pcm;rate=${RATE}` } } }));
    speechEndAt = await stream(clip, send, opts.vad ? { silenceUntil: () => answered, onSpeechEnd: at => { speechEndAt = at; } } : {});
    if (!opts.vad) socket.send(JSON.stringify({ realtimeInput: { activityEnd: {} } }));
    await done;
  } catch (error) { sample.error = (error as Error).message; }
  finally { socket.close(); }
  return sample;
}

/** Our cascade's text step: an OpenRouter chat completion, streamed, to its first speakable clause. */
async function cascadeTurn(clip: Clip, text: string, key: string, opts: { tool: boolean }): Promise<Sample> {
  const model = process.env.CASCADE_MODEL ?? "deepseek/deepseek-v4.1-flash";
  const sample: Sample = { provider: `cascade/${model}`, clip: clip.id, mode: opts.tool ? "text+tool" : "text" };
  const started = now();
  const body = (messages: unknown[]) => JSON.stringify({ model, stream: true, messages, ...(process.env.CASCADE_BODY ? JSON.parse(process.env.CASCADE_BODY) : {}),...(opts.tool ? { tools: [{ type: "function", function: LOOKUP }] } : {}) });
  const messages: unknown[] = [{ role: "system", content: opts.tool ? TOOL_SYSTEM : SYSTEM }, { role: "user", content: text }];
  try {
    for (let round = 0; round < 2; round++) {
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: body(messages) });
      if (!response.ok || !response.body) throw new Error(`OpenRouter ${response.status}: ${(await response.text()).slice(0, 200)}`);
      let buffered = "", said = "";
      const calls: { id: string; name: string; args: string }[] = [];
      const decoder = new TextDecoder();
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        buffered += decoder.decode(chunk, { stream: true });
        let newline: number;
        while ((newline = buffered.indexOf("\n")) >= 0) {
          const line = buffered.slice(0, newline).trim(); buffered = buffered.slice(newline + 1);
          if (!line.startsWith("data:") || line === "data: [DONE]") continue;
          const delta = JSON.parse(line.slice(5)).choices?.[0]?.delta ?? {};
          for (const call of delta.tool_calls ?? []) {
            calls[call.index ?? 0] ??= { id: call.id ?? "", name: call.function?.name ?? "", args: "" };
            calls[call.index ?? 0]!.args += call.function?.arguments ?? "";
          }
          if (delta.content) {
            sample.firstTokenMs ??= Math.round(now() - started);
            said += delta.content;
            if (sample.firstClauseMs === undefined && (/[.!?](\s|$)/.test(said) || (said.length >= 24 && /[,;:—]/.test(said.slice(23))))) sample.firstClauseMs = Math.round(now() - started);
          }
        }
      }
      if (calls.length && round === 0) {
        sample.toolCallMs = Math.round(now() - started);
        messages.push({ role: "assistant", content: null, tool_calls: calls.map(call => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.args } })) });
        for (const call of calls) messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(LOOKUP_RESULT) });
        continue;
      }
      sample.firstClauseMs ??= sample.firstTokenMs !== undefined ? Math.round(now() - started) : undefined;
      break;
    }
  } catch (error) { sample.error = (error as Error).message; }
  return sample;
}

const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.floor(sorted.length / 2)] : undefined; };
const p90 = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))] : undefined; };

async function main(argv: string[]) {
  const flag = (name: string) => { const index = argv.indexOf(`--${name}`); return index >= 0 ? argv[index + 1] : undefined; };
  const providers = (flag("providers") ?? "openai,gemini,cascade").split(",");
  const repeat = Number(flag("repeat") ?? 1);
  const tool = argv.includes("--tool"), vad = argv.includes("--vad");
  const clips = loadClips(flag("clips"), (flag("only") ?? "").split(",").filter(Boolean));
  if (!clips.length) throw new Error("No clips: run `npm run bakeoff:voice` once with OPENAI_API_KEY (it caches them), or pass --clips <dir>");
  const texts = await clipTexts();
  const samples: Sample[] = [];
  for (let round = 0; round < repeat; round++) {
    for (const clip of clips) {
      for (const provider of providers) {
        let sample: Sample | undefined;
        if (provider === "openai" && process.env.OPENAI_API_KEY) sample = await openaiTurn(clip, process.env.OPENAI_API_KEY, { tool, vad });
        else if (provider === "gemini" && process.env.GEMINI_API_KEY) sample = await geminiTurn(clip, process.env.GEMINI_API_KEY, { tool, vad });
        else if (provider === "cascade" && process.env.OPENROUTER_API_KEY) sample = await cascadeTurn(clip, texts.get(clip.id) ?? "Hello?", process.env.OPENROUTER_API_KEY, { tool });
        if (!sample) continue;
        samples.push(sample);
        console.error(JSON.stringify(sample));
      }
    }
  }
  const groups = new Map<string, Sample[]>();
  for (const sample of samples) groups.set(`${sample.provider} ${sample.mode}`, [...(groups.get(`${sample.provider} ${sample.mode}`) ?? []), sample]);
  const s = CASCADE_STAGES;
  const rows = [...groups].map(([name, group]) => {
    const ok = group.filter(sample => !sample.error);
    const pick = (key: keyof Sample) => ok.map(sample => sample[key]).filter((v): v is number => typeof v === "number");
    const clause = median(pick("firstClauseMs"));
    return {
      name, n: group.length, errors: group.length - ok.length,
      firstAudioMs: { p50: median(pick("firstAudioMs")), p90: p90(pick("firstAudioMs")) },
      toolCallMs: { p50: median(pick("toolCallMs")) },
      firstClauseMs: { p50: clause, p90: p90(pick("firstClauseMs")) },
      // Our cascade end to end, from the end of speech, with this run's text step: today (commit, batch STT) and with #262's preemptive STT.
      ...(clause !== undefined ? { cascadeEstimateMs: { today: s.commitMs + s.sttAfterCommitMs + clause + s.ttsFirstSoundMs + s.playoutMs, preemptiveStt: Math.max(s.commitMs, s.preemptiveSttTextMs) + clause + s.ttsFirstSoundMs + s.playoutMs } } : {}),
    };
  });
  const report = { date: new Date().toISOString(), clips: clips.map(clip => clip.id), repeat, tool, vad, cascadeStages: CASCADE_STAGES, rows, samples };
  if (flag("out")) writeFileSync(flag("out")!, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(rows, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2)).then(() => process.exit(0), error => { console.error(error); process.exit(1); });
