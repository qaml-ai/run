import type { Playback, Player } from "../src/voice-speech.ts";
import { Floor, type AddressingPolicy } from "../src/voice/turns/floor.ts";
import { RealtimeBrain, type BrainHooks, type BrainOptions } from "../src/voice/realtime/brain.ts";
import { NO_USAGE, type RealtimeConfig, type RealtimeConnection, type RealtimeCredentials, type RealtimeEvents, type RealtimeProvider, type RealtimeUsage } from "../src/voice/realtime/provider.ts";
import type { Cut } from "../src/voice-audio.ts";

export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export async function until<V>(check: () => V | Promise<V>, what: string, timeoutMs = 5_000): Promise<Exclude<V, false | 0 | "" | null | undefined>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value as Exclude<V, false | 0 | "" | null | undefined>;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(5);
  }
}

/** What a fake realtime connection was asked, in order. */
export type Sent =
  | { type: "append"; bytes: number } | { type: "commit"; tag: string; ms: number } | { type: "discard" } | { type: "note"; text: string }
  | { type: "respond"; instructions?: string } | { type: "cancel" } | { type: "truncate"; response: string; heardMs: number } | { type: "tool_result"; callId: string; output: string } | { type: "close" };

/**
 * A realtime connection without a provider: it records what the brain asks (appends folded into one entry per run),
 * and the test plays the provider's part through `events` (a response's id, audio, tool calls, its end).
 */
export class FakeConnection implements RealtimeConnection {
  readonly sent: Sent[] = [];
  readonly events: RealtimeEvents;
  readonly config: RealtimeConfig;
  private bytes = 0;
  responses = 0;
  constructor(config: RealtimeConfig, events: RealtimeEvents) {
    this.config = config;
    this.events = config.model.startsWith("grok-") ? { ...events, audio: (id, pcm) => { events.meter?.(pcm.byteLength / 48_000, 0); events.audio(id, pcm); } } : events;
    queueMicrotask(() => events.ready());
  }
  get pendingMs() { return this.bytes / 48; }
  append(pcm: Uint8Array) {
    if (this.config.model.startsWith("grok-")) this.events.meter?.(pcm.byteLength / 48_000, 0);
    this.bytes += pcm.byteLength;
    const last = this.sent.at(-1);
    if (last?.type === "append") last.bytes += pcm.byteLength;
    else this.sent.push({ type: "append", bytes: pcm.byteLength });
  }
  commit(tag: string) {
    if (!this.bytes) return false;
    if (this.pendingMs < 100) { this.discard(); return false; }
    this.sent.push({ type: "commit", tag, ms: Math.round(this.pendingMs) });
    this.bytes = 0;
    return true;
  }
  discard() { if (this.bytes) { this.bytes = 0; this.sent.push({ type: "discard" }); } }
  note(text: string) { if (this.config.model.startsWith("grok-")) this.events.meter?.(0, 1); this.sent.push({ type: "note", text }); }
  respond(options: { instructions?: string } = {}) { this.responses++; this.sent.push({ type: "respond", ...(options.instructions ? { instructions: options.instructions } : {}) }); }
  cancel() { this.sent.push({ type: "cancel" }); }
  truncate(response: string, heardMs: number) { this.sent.push({ type: "truncate", response, heardMs: Math.round(heardMs) }); }
  toolResult(callId: string, output: string) { this.sent.push({ type: "tool_result", callId, output }); }
  close() { this.sent.push({ type: "close" }); }
  of<T extends Sent["type"]>(type: T) { return this.sent.filter((entry): entry is Extract<Sent, { type: T }> => entry.type === type); }

  /** The provider's response `id`: begun, `ms` of audio (in 20 ms chunks, `everyMs` apart), what it says, done with `usage`. */
  async answer(id: string, options: { ms?: number; everyMs?: number; said?: string; usage?: Partial<RealtimeUsage>; status?: "completed" | "cancelled"; tool?: { id: string; name: string; args?: Record<string, unknown> } } = {}) {
    this.events.responseStarted(id);
    if (options.said) this.events.said(id, options.said);
    for (let at = 0; at < (options.ms ?? 0); at += 20) {
      this.events.audio(id, tone(20));
      if (options.everyMs) await sleep(options.everyMs);
    }
    if (options.tool) this.events.toolCall({ response: id, id: options.tool.id, name: options.tool.name, args: options.tool.args ?? {} });
    this.events.responseDone(id, { status: options.status ?? "completed", usage: { ...NO_USAGE, ...options.usage } });
  }
}

/** `ms` of a 220 Hz tone, 24 kHz mono 16-bit. */
export function tone(ms: number, amplitude = 8_000) {
  const samples = ms * 24;
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) pcm.writeInt16LE(Math.round(amplitude * Math.sin(2 * Math.PI * 220 * i / 24_000)), i * 2);
  return pcm;
}

/** A realtime provider whose connections are FakeConnections. */
export function fakeRealtimeProvider() {
  const connections: FakeConnection[] = [];
  const provider: RealtimeProvider = {
    id: "openai", key: "openai", models: ["gpt-realtime-2.1", "gpt-realtime-2.1-mini"], defaultModel: "gpt-realtime-2.1",
    voices: ["alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "marin", "cedar"],
    connect(config, _credentials, events) {
      const connection = new FakeConnection(config, events);
      connections.push(connection);
      return connection;
    },
  };
  return { provider, connections, last: () => connections.at(-1)! };
}

/** A player that plays each packet of PCM (20 ms of it) every `everyMs`, and records what it played. */
export function fakePlayer(everyMs = 2) {
  const plays: { ms: number; stopped: boolean; paused: boolean; started: boolean }[] = [];
  const player: Player = {
    play(pcm, started): Playback {
      const record = { ms: 0, stopped: false, paused: false, started: false };
      plays.push(record);
      const done = (async () => {
        for await (const chunk of pcm) {
          if (record.stopped) break;
          while (record.paused && !record.stopped) await sleep(everyMs);
          if (record.stopped) break;
          if (!record.started) { record.started = true; started(); }
          record.ms += chunk.byteLength / 48;
          await sleep(everyMs);
        }
        return record.stopped ? "stopped" as const : "done" as const;
      })();
      return { done, stop: () => { record.stopped = true; }, pause: () => { record.paused = true; }, resume: () => { record.paused = false; } };
    },
  };
  return { player, plays, resume: () => { for (const play of plays) play.paused = false; } };
}

/** A brain over a fake provider and player, with hooks recording what it reports. */
export function testBrain(options: Partial<BrainOptions> & { addressing?: Partial<AddressingPolicy>; humans?: number; askAgent?: BrainHooks["askAgent"]; hold?: BrainHooks["hold"]; provider?: RealtimeProvider; credentials?: RealtimeCredentials; refuse?: boolean } = {}) {
  const realtime = fakeRealtimeProvider();
  const playback = fakePlayer();
  const usage: Parameters<BrainHooks["usage"]>[0][] = [];
  const heard: Parameters<BrainHooks["heard"]>[0][] = [];
  const spoke: Parameters<BrainHooks["spoke"]>[0][] = [];
  const logs: { type: string; fields?: Record<string, unknown> }[] = [];
  const turns: Parameters<BrainHooks["turn"]>[0][] = [];
  const budget: string[] = [];
  const names: Record<string, string> = { "1": "Ana", "2": "Ben", "3": "Cy" };
  const state = { humans: options.humans ?? 1 };
  const config: RealtimeConfig = { model: options.reference?.split("/").slice(1).join("/") ?? "gpt-realtime-2.1", voice: "marin", instructions: "Be nice.", tools: [], transcribe: options.transcribed ?? true, ...(options.bargeIn ? {} : { interruptible: false }) };
  const brain = new RealtimeBrain({
    session: "vs_000000000000000000000001", tenant: "alice", reference: options.reference ?? "openai/gpt-realtime-2.1", floor: new Floor(options.addressing ?? {}),
    speculative: options.speculative ?? false, transcribed: options.transcribed ?? true, ...(options.bargeIn ? { bargeIn: options.bargeIn } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.ownsTurns ? { ownsTurns: true } : {}),
    ...(options.wordsAfterAnswer ? { wordsAfterAnswer: true } : {}), ...(options.limits ? { limits: options.limits } : {}),
  }, {
    connect: events => (options.provider ?? realtime.provider).connect(config, options.credentials ?? { apiKey: "fixture" }, events),
    player: () => playback.player, resumeMedia: () => playback.resume(), humans: () => state.humans, name: speaker => names[speaker] ?? speaker,
    ...(options.askAgent ? { askAgent: options.askAgent } : {}),
    admit: async () => { if (options.refuse) throw Object.assign(new Error("No credit"), { status: 402 }); },
    hold: options.hold ?? (async () => undefined),
    budget: limit => { budget.push(limit); },
    usage: record => { usage.push(record); }, turn: turn => { turns.push(turn); }, heard: entry => { heard.push(entry); }, spoke: event => { spoke.push(event); },
    failed: () => {}, log: (type, fields) => { logs.push({ type, ...(fields ? { fields } : {}) }); },
  });
  return { brain, realtime, connection: () => realtime.last(), playback, usage, heard, spoke, logs, turns, budget, state };
}

/** A speaker's utterance: speech started, `ms` of their audio (in 20 ms frames), then (unless `open`) its cut. */
export async function utter(brain: RealtimeBrain, speaker: string, ms: number, options: { open?: boolean; frameEveryMs?: number } = {}) {
  brain.speechStart(speaker);
  const startedAt = Date.now();
  for (let at = 0; at < ms; at += 20) {
    brain.pcm(speaker, tone(20));
    if (options.frameEveryMs) await sleep(options.frameEveryMs);
  }
  if (!options.open) brain.cut(cut(speaker, startedAt, ms));
}
export function cut(speaker: string, startedAt: number, ms: number): Cut {
  return { speaker, packets: [], seconds: ms / 1_000, startedAt, endedAt: Date.now(), ended: "silence", live: true };
}
