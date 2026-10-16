// A live check of Discord voice from wherever this runs (infra/voice-check.sh runs it as a one-off ECS task in the
// runtime's own subnets, security group and public IP): two test bots join one voice channel; one listens through the
// runtime's own Discord transport (src/voice-discord.ts) and segmenter (src/voice-audio.ts), the other plays three
// bursts of tone separated by encoded silence, as a bot playing a file does. PASS needs the listener to connect (the
// voice WebSocket, UDP IP discovery and DAVE), hear the speaker's packets (UDP in), and cut them into three utterances.
//
// With OPENAI_API_KEY, the other way too: the listener speaks a sentence through the runtime's own speech pipeline
// (speech.ts streaming OpenAI's gpt-4o-mini-tts, voice-audio.ts encoding, the transport's player), and the speaker bot
// hears it, segments it and has it transcribed. PASS then also needs the sentence heard (UDP out, DAVE encryption) and
// recognized; it reports the speech's latency (asked → first audio out) and what it cost. Nothing is stored.
//
//   VOICE_BOT_TOKEN=… SPEAKER_TOKEN=… GUILD=… CHANNEL=… [OPENAI_API_KEY=…] node --experimental-strip-types scripts/voice-check.ts
//
// Use two test applications made for this (never a production bot's token): a second gateway session on a token in use
// would see its traffic. Both need Connect, Speak and View Channel in the channel. Exit code 0 on PASS, 1 on FAIL.
import { Readable } from "node:stream";
import OpusScript from "opusscript";
import {
  createAudioPlayer, createAudioResource, EndBehaviorType, entersState, joinVoiceChannel, NoSubscriberBehavior, StreamType, VoiceConnectionStatus,
  type DiscordGatewayAdapterCreator, type DiscordGatewayAdapterLibraryMethods,
} from "@discordjs/voice";
import { discordVoice } from "../src/voice-discord.ts";
import { oggOpus, opusFromPcm, Segmenter, type Cut } from "../src/voice-audio.ts";
import { Outbound } from "../src/outbound.ts";
import { openaiSpeech, Synthesizer } from "../src/speech.ts";
import { checkedAudio, openaiTranscription } from "../src/transcription.ts";
import type { VoiceCredentials } from "../src/voice-sessions.ts";

const required = (name: string) => process.env[name] || (console.error(`${name} is not set`), process.exit(2));
const log = (fields: Record<string, unknown>) => console.log(JSON.stringify({ at: new Date().toISOString(), ...fields }));
const GUILDS = 1 << 0, GUILD_VOICE_STATES = 1 << 7;

/** The least of a Discord gateway session a voice join needs: identify, heartbeat, OP 4, and the two voice dispatches. */
class Gateway {
  userId = "";
  private ws?: WebSocket;
  private seq: number | null = null;
  private beat?: ReturnType<typeof setInterval>;
  private readonly guilds = new Set<string>();
  private readonly waiting: ((dispatch: { t: string; d: any }) => void)[] = [];
  /** @discordjs/voice's adapter for this guild, when the library joins through this session (the speaker). */
  adapter?: DiscordGatewayAdapterLibraryMethods;

  private readonly token: string;
  private readonly name: string;
  constructor(token: string, name: string) { this.token = token; this.name = name; }

  connect() {
    return new Promise<void>((resolve, reject) => {
      const ws = this.ws = new WebSocket("wss://gateway.discord.gg/?v=10&encoding=json");
      ws.addEventListener("message", event => {
        const { op, d, s, t } = JSON.parse(String(event.data));
        if (s != null) this.seq = s;
        if (op === 10) {
          this.beat = setInterval(() => this.send({ op: 1, d: this.seq }), d.heartbeat_interval);
          this.send({ op: 2, d: { token: this.token, intents: GUILDS | GUILD_VOICE_STATES, properties: { os: "linux", browser: "camelrun-voice-check", device: "camelrun-voice-check" } } });
        } else if (op === 0) {
          if (t === "READY") { this.userId = d.user.id; resolve(); }
          if (t === "GUILD_CREATE") this.guilds.add(d.id);
          if (t === "VOICE_STATE_UPDATE" && d.user_id === this.userId) this.adapter?.onVoiceStateUpdate(d);
          if (t === "VOICE_SERVER_UPDATE") this.adapter?.onVoiceServerUpdate(d);
          for (const waiter of this.waiting.splice(0)) waiter({ t, d });
        } else if (op === 9) log({ type: "gateway_invalid_session", bot: this.name });
      });
      ws.addEventListener("close", event => {
        clearInterval(this.beat);
        if (!this.userId) reject(new Error(`${this.name}'s gateway closed before READY: ${event.code} (4004: bad token)`));
      });
    });
  }

  send(payload: unknown) { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(payload)); return this.ws?.readyState === WebSocket.OPEN; }

  /** The next dispatch `match` takes, within `ms`. */
  next<T>(match: (dispatch: { t: string; d: any }) => T | undefined, ms: number, what: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${this.name}: no ${what} within ${ms} ms`)), ms);
      const listen = (dispatch: { t: string; d: any }) => {
        const found = match(dispatch);
        if (found === undefined) { this.waiting.push(listen); return; }
        clearTimeout(timer);
        resolve(found);
      };
      this.waiting.push(listen);
    });
  }

  async guild(id: string) {
    if (!this.guilds.has(id)) await this.next(({ t, d }) => t === "GUILD_CREATE" && d.id === id ? true : undefined, 15_000, `guild ${id} (is the bot in that server?)`);
  }

  /** @discordjs/voice's adapterCreator on this session. */
  adapterCreator(): DiscordGatewayAdapterCreator {
    return methods => {
      this.adapter = methods;
      return { sendPayload: payload => this.send(payload), destroy: () => { this.adapter = undefined; } };
    };
  }

  close() { clearInterval(this.beat); this.ws?.close(1000); }
}

/** Opus packets (48 kHz stereo, 20 ms): a 440 Hz tone, or encoded digital silence. */
function packets() {
  const encoder = new OpusScript(48_000, 2, OpusScript.Application.AUDIO);
  const frame = (amplitude: number) => {
    const pcm = Buffer.alloc(960 * 4);
    for (let i = 0; i < 960; i++) {
      const sample = Math.round(amplitude * 32_767 * Math.sin(2 * Math.PI * 440 * i / 48_000));
      pcm.writeInt16LE(sample, i * 4);
      pcm.writeInt16LE(sample, i * 4 + 2);
    }
    return pcm;
  };
  // Three bursts of 1.5 s, each after and before 1.5 s of encoded silence: a sender that never stops.
  const out: Buffer[] = [];
  for (let burst = 0; burst < 3; burst++) {
    for (let i = 0; i < 75; i++) out.push(Buffer.from(encoder.encode(frame(0), 960)));
    for (let i = 0; i < 75; i++) out.push(Buffer.from(encoder.encode(frame(0.3), 960)));
  }
  for (let i = 0; i < 75; i++) out.push(Buffer.from(encoder.encode(frame(0), 960)));
  encoder.delete();
  return out;
}

async function main() {
  const guildId = required("GUILD"), channelId = required("CHANNEL");
  const listener = new Gateway(required("VOICE_BOT_TOKEN"), "listener");
  const speaker = new Gateway(required("SPEAKER_TOKEN"), "speaker");
  await Promise.all([listener.connect(), speaker.connect()]);
  await Promise.all([listener.guild(guildId), speaker.guild(guildId)]);
  log({ type: "gateways_ready", listener: listener.userId, speaker: speaker.userId });

  // The listener joins as an app would for a voice session: OP 4 on its own gateway, then the two answers.
  const state = listener.next(({ t, d }) => t === "VOICE_STATE_UPDATE" && d.user_id === listener.userId && d.channel_id === channelId ? d : undefined, 15_000, "VOICE_STATE_UPDATE");
  const server = listener.next(({ t, d }) => t === "VOICE_SERVER_UPDATE" && d.guild_id === guildId ? d : undefined, 15_000, "VOICE_SERVER_UPDATE");
  // Un-muted: it speaks in the second part.
  listener.send({ op: 4, d: { guild_id: guildId, channel_id: channelId, self_mute: false, self_deaf: false } });
  const [voiceState, voiceServer] = await Promise.all([state, server]);
  const credentials: VoiceCredentials = { guildId, channelId, userId: listener.userId, sessionId: voiceState.session_id, endpoint: voiceServer.endpoint, token: voiceServer.token };

  // Then the runtime's own transport and segmenter hold it, as a voice session's owner does.
  const started = Date.now();
  const stats = { packets: 0, broken: 0, lost: [] as string[], cuts: [] as Cut[], dave: undefined as unknown };
  const segmenter = new Segmenter({ silenceMs: 800, cut: cut => { stats.cuts.push(cut); log({ type: "utterance", speaker: cut.speaker, seconds: cut.seconds, ended: cut.ended }); } });
  const ready = Promise.withResolvers<void>();
  const connection = discordVoice().connect(credentials, {
    ready: () => ready.resolve(),
    packet: (user, packet) => { if (user === speaker.userId) { stats.packets++; segmenter.packet(user, packet); } },
    broken: user => { stats.broken++; segmenter.broken(user); },
    lost: (reason, detail) => { stats.lost.push(`${reason}${detail ? ` (${detail})` : ""}`); ready.reject(new Error(`voice connection lost: ${reason}`)); },
    diagnostic: (event, fields) => { if (event === "ready") stats.dave = fields.dave; log({ type: `voice_${event}`, ...fields }); },
  });
  const timeout = setTimeout(() => ready.reject(new Error("the voice connection was not ready within 30 s (UDP blocked?)")), 30_000);
  await ready.promise.finally(() => clearTimeout(timeout));
  log({ type: "listener_ready", ms: Date.now() - started, dave: stats.dave });

  // The speaker joins with @discordjs/voice on its own gateway and plays the bursts.
  // Not deafened: it listens in the second part.
  const voice = joinVoiceChannel({ guildId, channelId, adapterCreator: speaker.adapterCreator(), selfDeaf: false, selfMute: false, group: "speaker" });
  await entersState(voice, VoiceConnectionStatus.Ready, 30_000);
  const sent = packets();
  const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
  voice.subscribe(player);
  player.play(createAudioResource(Readable.from(sent), { inputType: StreamType.Opus }));
  await new Promise(resolve => player.once("idle", resolve));
  await new Promise(resolve => setTimeout(resolve, 2_000));
  segmenter.flush("end");

  const failures: string[] = [];
  const spoken = await speakAndHear(connection, voice, listener.userId, failures);
  if (stats.packets < sent.length * 0.8) failures.push(`heard ${stats.packets} of ${sent.length} packets (UDP in, or DAVE)`);
  if (stats.broken) failures.push(`${stats.broken} receive streams broke (DAVE decryption)`);
  if (stats.lost.length) failures.push(`connection lost: ${stats.lost.join(", ")}`);
  if (stats.cuts.length !== 3) failures.push(`${stats.cuts.length} utterances, not 3`);
  log({ type: "summary", result: failures.length ? "FAIL" : "PASS", failures, sent: sent.length, heard: stats.packets, utterances: stats.cuts.map(cut => cut.seconds), dave: stats.dave,
    spoken });

  voice.destroy();
  connection.close();
  for (const gateway of [listener, speaker]) gateway.send({ op: 4, d: { guild_id: guildId, channel_id: null, self_mute: false, self_deaf: false } });
  await new Promise(resolve => setTimeout(resolve, 500));
  listener.close();
  speaker.close();
  process.exit(failures.length ? 1 : 0);
}

/** What the listener says, and the speaker bot must hear. */
const SENTENCE = "The quick brown fox jumps over the lazy dog near the riverbank.";
const words = (text: string) => text.toLowerCase().replace(/[^a-z ]/g, " ").split(/\s+/).filter(Boolean);

/**
 * Without an OpenAI key: three seconds of a 330 Hz tone as OpenAI streams speech (24 kHz mono PCM), with its timing:
 * the first bytes after a second, then chunks of uneven sizes (odd ones too) in bursts.
 */
async function* tone() {
  await new Promise(resolve => setTimeout(resolve, 1_000));
  const total = 3 * 24_000 * 2;
  for (let at = 0, index = 0; at < total; index++) {
    const size = Math.min(total - at, [4_096, 1_999, 8_191, 333, 16_384][index % 5]);
    const chunk = Buffer.alloc(size);
    for (let byte = 0; byte + 1 < size; byte += 2) chunk.writeInt16LE(Math.round(9_000 * Math.sin(2 * Math.PI * 330 * ((at + byte) >> 1) / 24_000)), byte);
    at += size;
    yield chunk;
    if (index % 7 === 6) await new Promise(resolve => setTimeout(resolve, 150));
  }
}

/**
 * PCM as it arrives, timed: when its first byte came (ms after `asked`), how many bytes, and when the last came; each
 * chunk's arrival ([ms, bytes]); and `zeroGapStartMs`, the earliest playback could have started and never run dry
 * (each chunk must arrive before the audio before it has played).
 */
function timed(pcm: AsyncIterable<Uint8Array>, asked: number) {
  const timing = { firstByteMs: -1, bytes: 0, lastByteMs: -1, chunks: 0, zeroGapStartMs: 0, arrivals: [] as [number, number][] };
  async function* tap() {
    for await (const chunk of pcm) {
      if (timing.firstByteMs < 0) timing.firstByteMs = Date.now() - asked;
      timing.zeroGapStartMs = Math.max(timing.zeroGapStartMs, Date.now() - asked - Math.floor(timing.bytes / 48));
      timing.arrivals.push([Date.now() - asked, chunk.byteLength]);
      timing.bytes += chunk.byteLength;
      timing.chunks++;
      timing.lastByteMs = Date.now() - asked;
      yield chunk;
    }
  }
  return { pcm: tap(), timing };
}

/**
 * The listener speaks through the runtime's speech pipeline: SENTENCE made by OpenAI with OPENAI_API_KEY, else a tone.
 * The speaker bot (its own @discordjs/voice connection, not deafened) hears it and cuts it with the runtime's segmenter;
 * with the key, it has it transcribed too. Adds to `failures`.
 */
async function speakAndHear(listening: ReturnType<ReturnType<typeof discordVoice>["connect"]>, voice: ReturnType<typeof joinVoiceChannel>, botUser: string, failures: string[]) {
  const outbound = new Outbound();
  const apiKey = process.env.OPENAI_API_KEY;
  const synthesizer = new Synthesizer({ provider: openaiSpeech({ outbound }), key: async () => apiKey ? { apiKey, platform: false } : undefined, price: () => 15_000 });
  const heard: Buffer[] = [];
  const cuts: Cut[] = [];
  const segmenter = new Segmenter({ silenceMs: 800, cut: cut => cuts.push(cut) });
  const stream = voice.receiver.subscribe(botUser, { end: { behavior: EndBehaviorType.Manual } });
  stream.on("data", (packet: Buffer) => { heard.push(packet); segmenter.packet(botUser, packet); });
  let made = 0, sent = 0, firstAudioMs = -1;
  const asked = Date.now();
  async function* counted(packets: AsyncIterable<Uint8Array>) { for await (const packet of packets) { sent++; yield packet; } }
  const source = timed(apiKey ? synthesizer.stream({ text: SENTENCE, voice: "alloy" }, { apiKey }, AbortSignal.timeout(60_000)) : tone(), asked);
  const playback = listening.play!(counted(opusFromPcm(source.pcm, count => { made += count; })), () => { firstAudioMs = Date.now() - asked; });
  const result = await playback.done;
  const playedMs = Date.now() - asked;
  await new Promise(resolve => setTimeout(resolve, 2_000));
  segmenter.flush("end");
  stream.destroy();
  const seconds = Math.round(made / 24_000 * 100) / 100;
  let transcript = "";
  if (cuts.length && apiKey) {
    const packets = cuts.flatMap(cut => cut.packets);
    const bytes = oggOpus(packets);
    const transcribed = await openaiTranscription({ outbound }).transcribe({ bytes, header: checkedAudio(bytes) }, { language: "en" }, { apiKey }, AbortSignal.timeout(60_000));
    transcript = transcribed.text;
  }
  const expected = words(SENTENCE), got = new Set(words(transcript));
  const recall = expected.filter(word => got.has(word)).length / expected.length;
  if (result !== "done") failures.push(`the speech ended ${result}`);
  if (heard.filter(packet => packet.length > 3).length < sent * 0.8) failures.push(`the speaker heard ${heard.filter(packet => packet.length > 3).length} of the ${sent} packets spoken (UDP out, or DAVE)`);
  if (made < (apiKey ? 2 : 3) * 24_000) failures.push(`only ${seconds} s of speech was made`);
  if (apiKey && recall < 0.8) failures.push(`the speech was heard as ${JSON.stringify(transcript)}`);
  if (!apiKey && cuts.length !== 1) failures.push(`the tone was heard as ${cuts.length} utterances, not 1`);
  // What the speaker heard that was speech (Discord's 3-byte silence frames are not).
  const audible = heard.filter(packet => packet.length > 3).length;
  // Silence the listener heard inside the speech: the playback's gaps (the jitter buffer running dry).
  const stats = playback.stats?.();
  const gapMs = stats?.gapMs ?? Math.max(0, playedMs - firstAudioMs - sent * 20);
  if (gapMs > 300) failures.push(`the speech had ${gapMs} ms of gaps (its making was slower or burstier than the start buffer covered)`);
  const facts = { sent, heard: heard.length, audible, utterances: cuts.length, seconds, firstAudioMs, playedMs, gapMs, pcm: source.timing, playback: stats };
  const report = apiKey
    ? { speech: "openai", ...facts, costUsd: synthesizer.cost(seconds), transcript, recall: Math.round(recall * 100) / 100 }
    : { speech: "tone, timed as OpenAI streams (no OPENAI_API_KEY)", ...facts };
  log({ type: "spoken", ...report });
  return report;
}

main().catch(error => { log({ type: "summary", result: "FAIL", failures: [String(error?.message ?? error)] }); process.exit(1); });
