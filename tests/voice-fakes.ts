import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { Opus } from "../src/opus.ts";
import { Accounts } from "../src/accounts.ts";
import { Tenants } from "../src/tenants.ts";
import { Ownership } from "../src/ownership.ts";
import type { UsageRecord } from "../src/client-sessions.ts";
import type { AudioHeader } from "../src/audio-header.ts";
import { Transcriber, type Transcript } from "../src/transcription.ts";
import { VoiceSessions, type VoiceConnection, type VoiceCredentials, type VoiceHandlers, type VoiceSessionsOptions, type VoiceTransport } from "../src/voice-sessions.ts";
import { testDatabase } from "./database.ts";
import { fakeRealtimeProvider, type FakeConnection as ModelConnection } from "./voice-realtime-fakes.ts";

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
  /** Whether a playback is going now, and whether it is paused (barge-in deciding). */
  playing: boolean;
  paused: boolean;
};

/** A voice transport for tests: connections are records; nothing goes over the network. Playback sends a packet each `playEveryMs`. */
export function fakeTransport(playEveryMs = 2) {
  const connections: FakeConnection[] = [];
  const transport: VoiceTransport = {
    connect(credentials, handlers): VoiceConnection {
      const connection: FakeConnection = { credentials, handlers, updates: [], closed: false, played: [], playing: false, paused: false };
      connections.push(connection);
      return {
        update: next => { connection.updates.push(next); connection.credentials = next; },
        others: () => connection.others,
        close: () => { connection.closed = true; },
        play(packets, started) {
          const out: Uint8Array[] = [];
          connection.played.push(out);
          connection.playing = true;
          let stopped = false, paused = false;
          const done = (async () => {
            try {
              for await (const packet of packets) {
                while (paused && !stopped && !connection.closed) await sleep(playEveryMs);
                if (stopped || connection.closed) break;
                if (!out.length) started();
                out.push(packet);
                await sleep(playEveryMs);
              }
              return stopped ? "stopped" as const : "done" as const;
            } catch { return stopped ? "stopped" as const : "error" as const; }
            finally { connection.playing = false; connection.paused = false; }
          })();
          return {
            done, stop: () => { stopped = true; },
            pause: () => { paused = true; connection.paused = true; }, resume: () => { paused = false; connection.paused = false; },
          };
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
 * Nodes holding voice sessions over one database, each with its own heartbeat, sharing one fake transport and one fake
 * realtime provider (`realtime.connections`: a session's brain's, in the order they were opened). `asks` records what
 * ask_agent sent the agent, which answers `agentReply`.
 */
/**
 * Transcription without a provider, for listening sessions: each call is recorded (the audio's header, the options) and
 * answered by `respond` (by default "heard N.N seconds"), billed per second at $0.006 a minute as the real one would be.
 */
export function fakeTranscriber(respond: (call: { header: AudioHeader; bytes: Uint8Array; index: number }) => string | Promise<string> = ({ header }) => `heard ${header.seconds!.toFixed(1)} seconds`) {
  const calls: { header: AudioHeader; bytes: Uint8Array; options: { language?: string; prompt?: string } }[] = [];
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

export async function voiceCluster(t: T, options: Partial<VoiceSessionsOptions> & { ttlMs?: number; playEveryMs?: number; agentReply?: string } = {}) {
  const { db } = await testDatabase();
  const accounts = new Accounts({ tenants: new Tenants({ read: async () => JSON.stringify({ tenants: {} }) }), db, secretsKey: randomBytes(32).toString("hex") });
  const fake = fakeTransport(options.playEveryMs ?? 2);
  const realtime = fakeRealtimeProvider();
  const transcription = fakeTranscriber();
  const usage: { tenant: string; usage: UsageRecord }[] = [];
  const asks: { agent: string; tenant: string; request: { id: string; method: string; params: Record<string, unknown> } }[] = [];
  const nodes: { name: string; ownership: Ownership; voice: VoiceSessions }[] = [];
  t.after(async () => { for (const node of nodes) { await node.voice.stop().catch(() => {}); await node.ownership.close().catch(() => {}); } });
  const node = async (name: string) => {
    const ownership = new Ownership(db, { node: name, ttlMs: options.ttlMs ?? 90_000 });
    await ownership.start();
    const voice = new VoiceSessions({
      db, accounts, node: name, ownership, transports: { discord: fake.transport },
      admit: async () => {}, agentOwned: async agent => agent === AGENT,
      record: (tenant, record) => { usage.push({ tenant, usage: record }); },
      submitStreaming: async function* (agent, tenant, request) { asks.push({ agent, tenant, request }); yield options.agentReply ?? "The agent's answer."; },
      realtime: { providers: { openai: realtime.provider }, key: async () => ({ apiKey: "fixture-key", platform: true }) },
      transcriber: transcription.transcriber,
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
  return { db, accounts, fake, realtime, transcription, usage, asks, node, events };
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

/** What the fake OpenAI Realtime server sends for one response.create: `send` one event. */
export type RealtimeAnswer = (index: number, send: (event: Record<string, unknown>) => void) => void;
/** A response's events as OpenAI streams them: `ms` of audio (24 kHz mono), what it says, its usage. */
export function realtimeAnswer(id: string, options: { ms?: number; said?: string; usage?: Record<string, unknown> } = {}) {
  return [
    { type: "response.created", response: { id } },
    { type: "response.output_item.added", response_id: id, item: { id: `item_${id}`, type: "message", role: "assistant" } },
    ...options.said ? [{ type: "response.output_audio_transcript.delta", response_id: id, delta: options.said }] : [],
    ...Array.from({ length: Math.ceil((options.ms ?? 400) / 100) }, () => ({ type: "response.output_audio.delta", response_id: id, item_id: `item_${id}`, delta: Buffer.alloc(4_800, 0x11).toString("base64") })),
    { type: "response.done", response: { id, status: "completed", usage: options.usage ?? { input_token_details: { audio_tokens: 50, text_tokens: 500 }, output_token_details: { audio_tokens: 80, text_tokens: 10 } } } },
  ];
}

/**
 * OpenAI's Realtime API faked over WebSockets on a local server (AGENT_OPENAI_REALTIME_URL is `url`): it records the
 * sockets (`urls`, `auth`) and their events, answers session.update, acknowledges each commit (transcribed as
 * `transcript()`), and answers each response.create with `answer` (by default 0.4 s of audio saying "Hello!").
 */
export async function fakeOpenAIRealtime(t: T, options: { transcript?: () => string; answer?: RealtimeAnswer } = {}) {
  const server = createServer((_req, res) => { res.writeHead(404).end(); });
  const sockets = new WebSocketServer({ server });
  const seen = { urls: [] as string[], auth: [] as string[], apiKeys: [] as string[], events: [] as any[], responses: 0 };
  const answer: RealtimeAnswer = options.answer ?? ((index, send) => { for (const event of realtimeAnswer(`resp_${index}`, { said: "Hello!" })) send(event); });
  sockets.on("connection", (ws: WebSocket, req) => {
    seen.urls.push(req.url ?? "");
    seen.auth.push(String(req.headers.authorization ?? ""));
    seen.apiKeys.push(String(req.headers["api-key"] ?? ""));
    let items = 0;
    const send = (event: Record<string, unknown>) => ws.send(JSON.stringify(event));
    ws.on("message", data => {
      const event = JSON.parse(String(data));
      seen.events.push(event);
      if (event.type === "session.update") send({ type: "session.updated", session: event.session });
      else if (event.type === "input_audio_buffer.commit") {
        const id = `item_in_${++items}`;
        send({ type: "input_audio_buffer.committed", item_id: id });
        send({ type: "conversation.item.input_audio_transcription.completed", item_id: id, content_index: 0, transcript: options.transcript?.() ?? "Hello there.", usage: { type: "duration", seconds: 1 } });
      } else if (event.type === "response.create") answer(++seen.responses, send);
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => { for (const ws of sockets.clients) ws.terminate(); server.close(() => resolve()); }));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, seen, of: (type: string) => seen.events.filter(event => event.type === type) };
}

/** The model's ears, for tests that count utterances: every turn its connections commit is heard as `text`, until stopped. */
export function hearAll(t: T, connections: ModelConnection[], text = "some words") {
  const heard = new Map<ModelConnection, number>();
  const timer = setInterval(() => {
    for (const connection of connections) {
      const commits = connection.of("commit");
      for (let index = heard.get(connection) ?? 0; index < commits.length; index++) connection.events.heard(commits[index].tag, text, commits[index].ms / 1_000);
      heard.set(connection, commits.length);
    }
  }, 20);
  t.after(() => clearInterval(timer));
}
