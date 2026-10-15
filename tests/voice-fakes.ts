import { randomBytes } from "node:crypto";
import { Accounts } from "../src/accounts.ts";
import { Tenants } from "../src/tenants.ts";
import { Ownership } from "../src/ownership.ts";
import { Transcriber, type Transcript } from "../src/transcription.ts";
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
};

/** A voice transport for tests: connections are records; nothing goes over the network. */
export function fakeTransport() {
  const connections: FakeConnection[] = [];
  const transport: VoiceTransport = {
    connect(credentials, handlers): VoiceConnection {
      const connection: FakeConnection = { credentials, handlers, updates: [], closed: false };
      connections.push(connection);
      return {
        update: next => { connection.updates.push(next); connection.credentials = next; },
        others: () => connection.others,
        close: () => { connection.closed = true; },
      };
    },
  };
  return { transport, connections, open: () => connections.filter(connection => !connection.closed) };
}

/** An Opus packet as Discord sends one: 20 ms of hybrid full-band audio (TOC 0x78), its payload `fill`. */
export const opusPacket = (fill = 1) => Uint8Array.from([0x78, ...Array.from({ length: 40 }, () => fill)]);
/** `seconds` of speech, packet by packet, into a connection from `speaker`. */
export function speak(connection: FakeConnection, speaker: string, seconds: number) {
  for (let index = 0; index < Math.round(seconds * 50); index++) connection.handlers.packet(speaker, opusPacket());
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

/** Nodes holding voice sessions over one database, each with its own heartbeat, sharing one fake transport and transcriber. */
export async function voiceCluster(t: T, options: Partial<VoiceSessionsOptions> & { ttlMs?: number } = {}) {
  const { db } = await testDatabase();
  const accounts = new Accounts({ tenants: new Tenants({ read: async () => JSON.stringify({ tenants: {} }) }), db, secretsKey: randomBytes(32).toString("hex") });
  const fake = fakeTransport();
  const transcription = fakeTranscriber();
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
      transcriber: transcription.transcriber, canTranscribe: async () => true,
      record: (tenant, record) => { usage.push({ tenant, usage: record }); },
      submit: async (agent, tenant, request) => { prompts.push({ agent, tenant, request }); return {}; },
      ...options,
    });
    nodes.push({ name, ownership, voice });
    return { name, ownership, voice };
  };
  // Webhook endpoints selecting the voice events, so they land in the outbox.
  await db.query("insert into webhook_endpoints (id, tenant, url, events, secret, created_at) values ('we_1', 'alice', 'https://example.test/hook', $1, '{}', 0)",
    [["voice.session.started", "voice.session.ended", "voice.utterance"]]);
  const events = async (type?: string) => (await db.query("select body from webhook_deliveries where tenant = 'alice' order by created_at, id")).rows
    .map(row => row.body).filter(body => type === undefined || body.type === type);
  return { db, accounts, fake, transcription, usage, prompts, node, events };
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
