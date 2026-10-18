import { randomBytes } from "node:crypto";
import type { Server } from "node:http";
import { WebSocketServer } from "ws";
import { Opus } from "../src/opus.ts";
import { Accounts } from "../src/accounts.ts";
import { Tenants } from "../src/tenants.ts";
import { Ownership } from "../src/ownership.ts";
import { Transcriber, type Transcript } from "../src/transcription.ts";
import { Synthesizer, type SpeechInput } from "../src/speech.ts";
import type { UsageRecord } from "../src/client-sessions.ts";
import type { AudioHeader } from "../src/audio-header.ts";
import { VoiceSessions, type VoiceConnection, type VoiceCredentials, type VoiceHandlers, type VoiceSessionsOptions, type VoiceTransport } from "../src/voice-sessions.ts";
import { testDatabase } from "./database.ts";

type T = { after(fn: () => Promise<void> | void): void };
export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
/** The agent voiceCluster's tenants own. */
export const AGENT = `client_${"a".repeat(40)}`;

export async function until<V>(check: () => V | Promise<V>, what: string, timeoutMs = 10_000): Promise<Exclude<V, false | 0 | "" | null | undefined>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value as Exclude<V, false | 0 | "" | null | undefined>;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(20);
  }
}

/** A connection the fake transport made: what it was given, and the handlers a test drives it through. */
export type FakeConnection = {
  credentials: VoiceCredentials; handlers: VoiceHandlers; updates: VoiceCredentials[]; closed: boolean;
  /** The other users in the call, as the connection reports them (undefined: not known yet). */
  others?: string[];
  /** Speech it played: each playback's packets, as they went out (20 ms apart, as a player sends them). */
  played: Uint8Array[][];
  /** Whether a playback is going now. */
  playing: boolean;
};

/** A voice transport for tests: connections are records; nothing goes over the network. Playback sends a packet each `playEveryMs`. */
export function fakeTransport(playEveryMs = 2) {
  const connections: FakeConnection[] = [];
  const transport: VoiceTransport = {
    connect(credentials, handlers): VoiceConnection {
      const connection: FakeConnection = { credentials, handlers, updates: [], closed: false, played: [], playing: false };
      connections.push(connection);
      return {
        update: next => { connection.updates.push(next); connection.credentials = next; },
        others: () => connection.others,
        close: () => { connection.closed = true; },
        play(packets, started) {
          const out: Uint8Array[] = [];
          connection.played.push(out);
          connection.playing = true;
          let stopped = false;
          const done = (async () => {
            try {
              for await (const packet of packets) {
                if (stopped || connection.closed) break;
                if (!out.length) started();
                out.push(packet);
                await sleep(playEveryMs);
              }
              return stopped ? "stopped" as const : "done" as const;
            } catch { return stopped ? "stopped" as const : "error" as const; }
            finally { connection.playing = false; }
          })();
          return { done, stop: () => { stopped = true; } };
        },
      };
    },
    speaks: true,
  };
  return { transport, connections, open: () => connections.filter(connection => !connection.closed) };
}

/** An Opus packet's shape as Discord sends one, for transports that pass bytes on: TOC 0x78 (20 ms), its payload `fill`. */
export const opusPacket = (fill = 1) => Uint8Array.from([0x78, ...Array.from({ length: 40 }, () => fill)]);

/** Real Opus packets (48 kHz stereo, 20 ms): `loud` a 440 Hz tone at about -13 dBFS, else digital silence (encoded). */
const encoded = (() => {
  const encoder = new Opus(48_000, 2, "audio");
  const frame = (amplitude: number) => {
    const pcm = Buffer.alloc(960 * 2 * 2);
    for (let i = 0; i < 960; i++) {
      const sample = Math.round(amplitude * 32_767 * Math.sin(2 * Math.PI * 440 * i / 48_000));
      pcm.writeInt16LE(sample, i * 4);
      pcm.writeInt16LE(sample, i * 4 + 2);
    }
    return pcm;
  };
  const loud = Array.from({ length: 10 }, () => new Uint8Array(encoder.encode(frame(0.3), 960)));
  const quiet = Array.from({ length: 10 }, () => new Uint8Array(encoder.encode(frame(0), 960)));
  encoder.delete();
  return { loud, quiet };
})();
/** Speech: a loud packet (the nth of a few, as an encoder makes them in a row). */
export const speechPacket = (index = 0) => encoded.loud[index % encoded.loud.length];
/** Encoded silence: what a sender that never stops sends in its pauses. */
export const quietPacket = (index = 0) => encoded.quiet[index % encoded.quiet.length];
/** `seconds` of speech, packet by packet, into a connection from `speaker`. */
export function speak(connection: FakeConnection, speaker: string, seconds: number) {
  for (let index = 0; index < Math.round(seconds * 50); index++) connection.handlers.packet(speaker, speechPacket(index));
}

/**
 * Transcription without a provider: each call is recorded (the audio's header, the options) and answered by `respond`
 * (by default "heard N.N seconds"), billed per second at $0.006 a minute as the real one would be.
 */
export function fakeTranscriber(respond: (call: { header: AudioHeader; bytes: Uint8Array; index: number }) => string | Promise<string> = ({ header }) => `heard ${header.seconds!.toFixed(1)} seconds`) {
  const calls: { header: AudioHeader; bytes: Uint8Array; options: { language?: string; prompt?: string }; tenant?: string }[] = [];
  const transcriber = new Transcriber({
    provider: {
      id: "openai", model: "gpt-transcribe",
      async transcribe({ bytes, header }, options): Promise<Transcript> {
        calls.push({ header, bytes, options });
        const text = await respond({ header, bytes, index: calls.length - 1 });
        return { text, seconds: Math.ceil(header.seconds!), model: "gpt-transcribe", ...(options.language ? { language: options.language } : {}) };
      },
    },
    key: async () => ({ apiKey: "fixture-key", platform: true }),
    price: () => 6_000,
  });
  return { transcriber, calls };
}

/**
 * Speech without a provider: each request recorded, and answered with a tone of `seconds(text)` (default a tenth of
 * a second per character) as 24 kHz mono PCM, in 100 ms chunks every `chunkEveryMs`, as a stream would come.
 */
export function fakeSynthesizer(options: { seconds?: (text: string) => number; chunkEveryMs?: number; fail?: boolean } = {}) {
  const calls: { input: SpeechInput; apiKey: string }[] = [];
  const synthesizer = new Synthesizer({
    provider: {
      id: "openai", model: "gpt-4o-mini-tts",
      async *stream(input, credentials, signal) {
        calls.push({ input, apiKey: credentials.apiKey });
        if (options.fail) throw new Error("provider down");
        const total = Math.round((options.seconds?.(input.text) ?? input.text.length / 10) * 24_000);
        for (let at = 0; at < total; at += 2_400) {
          if (signal.aborted) throw signal.reason;
          const chunk = Buffer.alloc(Math.min(2_400, total - at) * 2);
          for (let i = 0; i < chunk.length / 2; i++) chunk.writeInt16LE(Math.round(8_000 * Math.sin(2 * Math.PI * 220 * (at + i) / 24_000)), i * 2);
          yield chunk;
          await sleep(options.chunkEveryMs ?? 1);
        }
      },
    },
    key: async () => ({ apiKey: "fixture-key", platform: true }),
    price: () => 15_000,
  });
  return { synthesizer, calls };
}

/** Nodes holding voice sessions over one database, each with its own heartbeat, sharing one fake transport and transcriber. */
export async function voiceCluster(t: T, options: Partial<VoiceSessionsOptions> & { ttlMs?: number; playEveryMs?: number } = {}) {
  const { db } = await testDatabase();
  const accounts = new Accounts({ tenants: new Tenants({ read: async () => JSON.stringify({ tenants: {} }) }), db, secretsKey: randomBytes(32).toString("hex") });
  const fake = fakeTransport(options.playEveryMs ?? 2);
  const transcription = fakeTranscriber();
  const speech = fakeSynthesizer({ chunkEveryMs: options.playEveryMs ?? 1 });
  const usage: { tenant: string; usage: UsageRecord }[] = [];
  const prompts: { agent: string; tenant: string; request: { id: string; method: string; params: Record<string, unknown> } }[] = [];
  const nodes: { name: string; ownership: Ownership; voice: VoiceSessions }[] = [];
  t.after(async () => { for (const node of nodes) { await node.voice.stop(1_000).catch(() => {}); await node.ownership.close().catch(() => {}); } });
  const node = async (name: string) => {
    const ownership = new Ownership(db, { node: name, ttlMs: options.ttlMs ?? 90_000 });
    await ownership.start();
    const voice = new VoiceSessions({
      db, accounts, node: name, ownership, transports: { discord: fake.transport },
      admit: async () => {}, agentOwned: async agent => agent === AGENT,
      transcriber: transcription.transcriber, synthesizer: speech.synthesizer, canTranscribe: async () => true,
      record: (tenant, record) => { usage.push({ tenant, usage: record }); },
      submit: async (agent, tenant, request) => { prompts.push({ agent, tenant, request }); return {}; },
      ...options,
    });
    nodes.push({ name, ownership, voice });
    return { name, ownership, voice };
  };
  // Webhook endpoints selecting the voice events, so they land in the outbox.
  await db.query("insert into webhook_endpoints (id, tenant, url, events, secret, created_at) values ('we_1', 'alice', 'https://example.test/hook', $1, '{}', 0)",
    [["voice.session.started", "voice.session.ended", "voice.session.error", "voice.utterance", "voice.speech.started", "voice.speech.ended"]]);
  const events = async (type?: string) => (await db.query("select body from webhook_deliveries where tenant = 'alice' order by created_at, id")).rows
    .map(row => row.body).filter(body => type === undefined || body.type === type);
  return { db, accounts, fake, transcription, speech, usage, prompts, node, events };
}

let counter = 0;
/** A create request's `discord`, as Discord's two dispatches would give it. */
export function discordGrant(overrides: Partial<VoiceCredentials> = {}) {
  counter++;
  return {
    guildId: "100000000000000001", channelId: "200000000000000002", userId: "300000000000000003",
    sessionId: `session${counter}`, endpoint: "c-test-1.discord.media:443", token: `token-${counter}`, ...overrides,
  };
}

/**
 * OpenAI's Realtime transcription, faked on `server` (wss://…/realtime?intent=transcription): each commit answers
 * `transcript()` after `delayMs`. Records the session it was configured with and the audio bytes of each commit.
 */
export function fakeRealtime(server: Server, transcript: () => string, delayMs = 0) {
  const sockets = new WebSocketServer({ noServer: true });
  const seen = { urls: [] as string[], auth: [] as string[], sessions: [] as any[], commits: [] as number[], clears: 0 };
  // Closing the server ends its sockets too: an upgraded one is not the server's to wait for, and a runtime still
  // holding it open would keep server.close() waiting a minute.
  const close = server.close.bind(server);
  server.close = (callback?: (error?: Error) => void) => {
    for (const ws of sockets.clients) ws.terminate();
    return close(callback);
  };
  server.on("upgrade", (req, socket, head) => {
    seen.urls.push(req.url ?? "");
    seen.auth.push(String(req.headers.authorization ?? ""));
    sockets.handleUpgrade(req, socket, head, ws => {
      let bytes = 0, item = 0;
      ws.on("message", data => {
        const event = JSON.parse(String(data));
        if (event.type === "session.update") seen.sessions.push(event.session);
        else if (event.type === "input_audio_buffer.append") bytes += Buffer.from(event.audio, "base64").length;
        else if (event.type === "input_audio_buffer.clear") { bytes = 0; seen.clears++; }
        else if (event.type === "input_audio_buffer.commit") {
          const id = `item_${++item}`;
          seen.commits.push(bytes);
          const seconds = bytes / 48_000;
          bytes = 0;
          ws.send(JSON.stringify({ type: "input_audio_buffer.committed", item_id: id }));
          setTimeout(() => ws.send(JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", item_id: id, content_index: 0, transcript: transcript(), usage: { type: "duration", seconds } })), delayMs);
        }
      });
    });
  });
  return seen;
}
