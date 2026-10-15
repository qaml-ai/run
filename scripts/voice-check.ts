// A live check of Discord voice from wherever this runs (infra/voice-check.sh runs it as a one-off ECS task in the
// runtime's own subnets, security group and public IP): two test bots join one voice channel; one listens through the
// runtime's own Discord transport (src/voice-discord.ts) and segmenter (src/voice-audio.ts), the other plays three
// bursts of tone separated by encoded silence, as a bot playing a file does. PASS needs the listener to connect (the
// voice WebSocket, UDP IP discovery and DAVE), hear the speaker's packets (UDP in), and cut them into three utterances.
// Nothing is transcribed and nothing is stored.
//
//   VOICE_BOT_TOKEN=… SPEAKER_TOKEN=… GUILD=… CHANNEL=… node --experimental-strip-types scripts/voice-check.ts
//
// Use two test applications made for this (never a production bot's token): a second gateway session on a token in use
// would see its traffic. Both need Connect, Speak and View Channel in the channel. Exit code 0 on PASS, 1 on FAIL.
import { Readable } from "node:stream";
import OpusScript from "opusscript";
import {
  createAudioPlayer, createAudioResource, entersState, joinVoiceChannel, NoSubscriberBehavior, StreamType, VoiceConnectionStatus,
  type DiscordGatewayAdapterCreator, type DiscordGatewayAdapterLibraryMethods,
} from "@discordjs/voice";
import { discordVoice } from "../src/voice-discord.ts";
import { Segmenter, type Cut } from "../src/voice-audio.ts";
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
  listener.send({ op: 4, d: { guild_id: guildId, channel_id: channelId, self_mute: true, self_deaf: false } });
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
  const voice = joinVoiceChannel({ guildId, channelId, adapterCreator: speaker.adapterCreator(), selfDeaf: true, selfMute: false, group: "speaker" });
  await entersState(voice, VoiceConnectionStatus.Ready, 30_000);
  const sent = packets();
  const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
  voice.subscribe(player);
  player.play(createAudioResource(Readable.from(sent), { inputType: StreamType.Opus }));
  await new Promise(resolve => player.once("idle", resolve));
  await new Promise(resolve => setTimeout(resolve, 2_000));
  segmenter.flush("end");

  const failures: string[] = [];
  if (stats.packets < sent.length * 0.8) failures.push(`heard ${stats.packets} of ${sent.length} packets (UDP in, or DAVE)`);
  if (stats.broken) failures.push(`${stats.broken} receive streams broke (DAVE decryption)`);
  if (stats.lost.length) failures.push(`connection lost: ${stats.lost.join(", ")}`);
  if (stats.cuts.length !== 3) failures.push(`${stats.cuts.length} utterances, not 3`);
  log({ type: "summary", result: failures.length ? "FAIL" : "PASS", failures, sent: sent.length, heard: stats.packets, utterances: stats.cuts.map(cut => cut.seconds), dave: stats.dave });

  voice.destroy();
  connection.close();
  for (const gateway of [listener, speaker]) gateway.send({ op: 4, d: { guild_id: guildId, channel_id: null, self_mute: false, self_deaf: false } });
  await new Promise(resolve => setTimeout(resolve, 500));
  listener.close();
  speaker.close();
  process.exit(failures.length ? 1 : 0);
}

main().catch(error => { log({ type: "summary", result: "FAIL", failures: [String(error?.message ?? error)] }); process.exit(1); });
