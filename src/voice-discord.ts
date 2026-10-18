import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import {
  AudioPlayerStatus, createAudioPlayer, createAudioResource, EndBehaviorType, joinVoiceChannel, NoSubscriberBehavior, StreamType, VoiceConnectionStatus,
  type AudioPlayer, type DiscordGatewayAdapterCreator, type DiscordGatewayAdapterLibraryMethods, type VoiceConnection as DiscordConnection,
} from "@discordjs/voice";
import type { VoiceConnection, VoiceCredentials, VoiceHandlers, VoiceTransport } from "./voice-sessions.ts";
import type { Playback } from "./voice-speech.ts";
import { buffered } from "./voice-audio.ts";
import { JitterBuffer } from "./voice/jitter.ts";
import { recordDaveRoster, safeError } from "./metrics.ts";

/**
 * Discord voice connections from forwarded credentials, on @discordjs/voice (and @snazzah/davey for DAVE, Discord's
 * end-to-end encryption). The library expects a gateway to join through: here the gateway is the tenant's app, which
 * already joined, so the adapter answers the library's OP 4 with the VOICE_STATE_UPDATE and VOICE_SERVER_UPDATE the app
 * forwarded, and the library opens the voice WebSocket and UDP socket from there. A leave (OP 4 without a channel) goes
 * nowhere: the app leaves.
 *
 * The library's own debug output is never turned on: it prints the voice gateway's packets, the token among them.
 *
 * DAVE's group must hold only the call's members. davey 0.1.12 accepts an MLS Welcome without checking its roster
 * against them (libdave's check, whose bug was CVE-2026-104480; davey skips it altogether), and @discordjs/voice could
 * not give it the members if it did. So each connection checks for itself (`RosterGuard`): after each transition of
 * the group, every member must be one the voice gateway named (Clients Connect) or the bot; one that stays a stranger
 * past a grace (the gateway's word can trail the Welcome) drops the connection, which joins again with a new group.
 *
 * A bot that speaks sends media its group can decrypt, so for it the check cannot wait out a grace. Two more guards:
 * - Each Welcome is checked as it is processed (`strictWelcome`, around @discordjs/voice's DAVESession): a group with a
 *   member the gateway has not named is refused at once, as libdave refuses it (the library then tells the voice server
 *   the Welcome was invalid, opcode 31, and the bot is welcomed again into a group of the call's members). Proposals to
 *   add members are already checked against the named members by davey (`processProposals`' recognized user ids).
 * - Speech goes out only while the group is ready and every member is named (`canSend`): never while a stranger is
 *   pending, and never unencrypted while DAVE re-forms (the library sends a packet as it is when its session is not
 *   ready).
 *
 * No audio at the start of an utterance is lost. The library maps an SSRC to its user from Speaking (op 5), which
 * Discord sends once per SSRC over the WebSocket, and drops UDP packets from an SSRC it cannot map yet: those that
 * outrun it, the first of each speaker's first utterance. So each connection sees the UDP packets before the library
 * does: one from an SSRC not yet mapped is held (a few per SSRC, a few SSRCs, briefly) and handed to the library once
 * Speaking maps it; one from a mapped SSRC first opens its speaker's stream, so it is the stream's first packet. A
 * speaker's stream stays open for the session (the segmenter cuts utterances), and closes when they leave the call.
 */

/** Voice gateway close codes after which these credentials will not work again: new ones must come (PATCH). */
const CREDENTIALS = new Set([4004, 4006, 4009, 4011]);
/** Close codes that mean the bot is out of the call: disconnected, kicked, moved, or the call ended. */
const KICKED = new Set([4014, 4022]);
/** Reconnects without reaching ready again before the connection gives up (`lost`, `error`). */
const MAX_REJOINS = 5;

/** How long a group member may go unnamed by the voice gateway before it counts as a stranger. */
const ROSTER_GRACE_MS = 5_000;
/** Drops for strangers within ROSTER_WINDOW_MS after which the connection gives up (`lost`, `error`). */
const MAX_ROSTER_DROPS = 3;
const ROSTER_WINDOW_MS = 5 * 60_000;

/**
 * Frames a speech may go without a packet (synthesis stalling, `canSend` holding it) before the player gives up: 30 s.
 * The player sends Discord's silence frame for each meanwhile.
 */
const MAX_MISSED_FRAMES = 1_500;

/**
 * Wrap a DAVE session's Welcome handling so a Welcome into a group with a member `named` does not hold (nor the bot,
 * `self`) is refused as an invalid transition, as libdave refuses it. Idempotent per session object.
 */
const strict = new WeakSet<object>();
export function strictWelcome(dave: any, self: string, named: () => Iterable<string> | undefined, refused: (strangers: number) => void) {
  if (!dave || strict.has(dave) || typeof dave.processWelcome !== "function") return;
  strict.add(dave);
  const original = dave.processWelcome;
  dave.processWelcome = function processWelcome(this: any, payload: Buffer) {
    const result = original.call(this, payload);
    if (!result?.success) return result;
    let members: string[] = [];
    try { members = this.session?.getUserIds() ?? []; } catch { members = []; }
    const known = new Set(named() ?? []);
    const strangers = members.filter(member => member !== self && !known.has(member));
    if (!strangers.length) return result;
    refused(strangers.length);
    // As the library handles a Welcome davey refused: tell the voice server (opcode 31) and start over.
    this.recoverFromInvalidTransition(result.transitionId);
    return { transitionId: result.transitionId, success: false };
  };
}

/** Discord's silence frame, and how many end each speech (Discord: "five frames of silence" when a sender stops). */
const SILENCE = Buffer.from([0xf8, 0xff, 0xfe]);
const SILENCE_FRAMES = 5;

/** RTP payload type of Discord's Opus audio (any other, video, is not listened to). */
const OPUS_PAYLOAD_TYPE = 120;
/** Packets held for an SSRC that Speaking has not mapped yet: its latest this many (a second of audio)... */
export const EARLY_PACKETS = 50;
/** ...for at most this many SSRCs (the oldest is dropped for a new one)... */
export const EARLY_SSRCS = 8;
/** ...and no older than this when Speaking comes. */
const EARLY_MS = 2_000;

/**
 * The DAVE group's members, checked against the call's (`RosterGuard`'s doc on the module). `members` reads the group
 * (undefined without one: a call without DAVE, or before it joined); `named` the members the voice gateway named.
 * `stranger` is called once per stranger seen past `graceMs`; a check that finds none clears what was pending.
 */
export class RosterGuard {
  private readonly options: { self: string; graceMs: number; members(): string[] | undefined; named(): Iterable<string> | undefined; stranger(strangers: string[]): void };
  private since?: number;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(options: RosterGuard["options"]) { this.options = options; }

  /** Whether a member is unnamed now, inside its grace. */
  get pending() { return this.since !== undefined; }

  check(now = Date.now()) {
    clearTimeout(this.timer);
    this.timer = undefined;
    const members = this.options.members();
    if (!members) { this.since = undefined; return; }
    const named = new Set(this.options.named() ?? []);
    const strangers = members.filter(member => member !== this.options.self && !named.has(member));
    if (!strangers.length) { this.since = undefined; return; }
    this.since ??= now;
    if (now - this.since >= this.options.graceMs) {
      this.since = undefined;
      this.options.stranger(strangers);
      return;
    }
    this.timer = setTimeout(() => this.check(), this.since + this.options.graceMs - now);
    this.timer.unref();
  }

  close() { clearTimeout(this.timer); }
}

/**
 * Discord voice connections. `roster` is for tests: the grace before a stranger in the DAVE group drops the connection,
 * and the group's members as they read (the real ones come from davey).
 */
export function discordVoice(options: { roster?: { graceMs?: number; members?: () => string[] | undefined } } = {}): VoiceTransport {
  return { speaks: true, connect: (credentials, handlers) => new DiscordVoice(credentials, handlers, options.roster ?? {}) };
}

export class DiscordVoice implements VoiceConnection {
  private credentials: VoiceCredentials;
  private readonly handlers: VoiceHandlers;
  private methods?: DiscordGatewayAdapterLibraryMethods;
  private readonly connection: DiscordConnection;
  private readonly listening = new Set<string>();
  /** UDP packets from SSRCs that Speaking has not mapped yet, oldest first, by SSRC. */
  private readonly early = new Map<number, { at: number; message: Buffer }[]>();
  /** The library's own handling of a UDP packet. */
  private readonly receive: (message: Buffer) => void;
  /** Each SSRC's packets in order (src/voice/jitter.ts), before the library decrypts them. */
  private readonly jitter: JitterBuffer<Buffer>;
  /** Packets lost before a speaker's next one, for its handler (the jitter buffer gave up on them). */
  private readonly lostBefore = new Map<string, number>();
  /** Reconnects since the connection was last ready. */
  private rejoins = 0;
  /** Whether the voice server has told of the call's members yet: until it has, they are unknown, not none. */
  private membersKnown = false;
  private closed = false;
  private lost = false;
  private readonly roster: RosterGuard;
  /** When the connection last dropped for a stranger in its DAVE group. */
  private readonly rosterDrops: number[] = [];
  /** The player speech goes out through, made with the first speech. */
  private player?: AudioPlayer;

  constructor(credentials: VoiceCredentials, handlers: VoiceHandlers, roster: { graceMs?: number; members?: () => string[] | undefined }) {
    this.credentials = credentials;
    this.handlers = handlers;
    this.roster = new RosterGuard({
      self: credentials.userId, graceMs: roster.graceMs ?? ROSTER_GRACE_MS,
      members: roster.members ?? (() => this.daveMembers()),
      named: () => this.named(),
      stranger: strangers => this.stranger(strangers),
    });
    const adapterCreator: DiscordGatewayAdapterCreator = methods => {
      this.methods = methods;
      return {
        // The library joins (and rejoins after a dropped socket) by sending OP 4: answer with what the app forwarded.
        sendPayload: payload => {
          if ((payload as { d?: { channel_id?: unknown } }).d?.channel_id) queueMicrotask(() => this.feed());
          return true;
        },
        destroy: () => { this.methods = undefined; },
      };
    };
    // A group of its own: the library keeps one connection per group and guild, and several bots may share a guild.
    this.connection = joinVoiceChannel({
      guildId: credentials.guildId, channelId: credentials.channelId, adapterCreator, group: `camelrun-${randomUUID()}`,
      selfDeaf: false, selfMute: true, debug: false,
    });
    this.connection.on("stateChange", (from, to) => {
      if (this.closed) return;
      if (to.status !== from.status) handlers.diagnostic("state", { from: from.status, to: to.status });
      if (to.status === VoiceConnectionStatus.Ready && from.status !== VoiceConnectionStatus.Ready) {
        this.rejoins = 0;
        const dave = (to.networking.state as { dave?: { protocolVersion?: number } }).dave;
        handlers.diagnostic("ready", { dave: dave?.protocolVersion ?? 0 });
        handlers.ready();
        this.roster.check();
      }
      if (to.status === VoiceConnectionStatus.Signalling && from.status !== VoiceConnectionStatus.Signalling && from.status !== VoiceConnectionStatus.Disconnected) {
        if (++this.rejoins > MAX_REJOINS) this.fail("error", "reconnects kept failing");
      }
      // The close code of each voice gateway socket the library opens, which its own states keep only for 4014.
      const networking = "networking" in to ? to.networking : undefined;
      if (networking && networking !== ("networking" in from ? from.networking : undefined)) {
        networking.once("close", (code: number) => this.closedWith(code));
        // Each DAVE session the library makes for this socket gets the strict Welcome check as it appears.
        const guard = (state: { dave?: unknown }) => strictWelcome(state.dave, credentials.userId, () => this.named(), strangers => {
          recordDaveRoster(strangers);
          handlers.diagnostic("dave_welcome_refused", { strangers });
        });
        guard(networking.state as { dave?: unknown });
        (networking as unknown as { on(event: "stateChange", listener: (previous: unknown, next: { dave?: unknown }) => void): void }).on("stateChange", (_previous, next) => guard(next));
      }
    });
    this.connection.on("error", error => handlers.diagnostic("error", { error: error.message.slice(0, 200) }));
    // Each transition of the DAVE group (a Welcome, a commit) may have changed its members.
    this.connection.on("transitioned", () => this.roster.check());
    // Each UDP socket the library opens is bound to `receiver.onUdpMessage` as it is then (none is open yet: it opens
    // once `feed` answers, a microtask from now), so every one comes here first.
    const receiver = this.connection.receiver;
    this.receive = receiver.onUdpMessage;
    this.jitter = new JitterBuffer<Buffer>((ssrc, message, lost) => {
      if (this.closed) return;
      const user = this.connection.receiver.ssrcMap.get(ssrc);
      if (lost && user) this.lostBefore.set(user.userId, (this.lostBefore.get(user.userId) ?? 0) + lost);
      this.receive(message);
    });
    receiver.onUdpMessage = message => this.udp(message);
    receiver.ssrcMap.on("create", ({ audioSSRC }) => this.mapped(audioSSRC));
    receiver.ssrcMap.on("delete", ({ userId, audioSSRC }) => this.left(userId, audioSSRC));
  }

  /** The two dispatches the app forwarded, as the library's adapter would have them from a gateway. */
  private feed() {
    const methods = this.methods;
    if (!methods || this.closed || this.lost) return;
    const { guildId, channelId, userId, sessionId, endpoint, token } = this.credentials;
    methods.onVoiceStateUpdate({
      guild_id: guildId, channel_id: channelId, user_id: userId, session_id: sessionId,
      deaf: false, mute: false, self_deaf: false, self_mute: true, self_video: false, suppress: false, request_to_speak_timestamp: null,
    } as Parameters<DiscordGatewayAdapterLibraryMethods["onVoiceStateUpdate"]>[0]);
    methods.onVoiceServerUpdate({ guild_id: guildId, endpoint, token } as Parameters<DiscordGatewayAdapterLibraryMethods["onVoiceServerUpdate"]>[0]);
  }

  private closedWith(code: number) {
    if (this.closed) return;
    this.handlers.diagnostic("socket_closed", { code });
    if (KICKED.has(code)) this.fail("kicked", `close ${code}`);
    else if (CREDENTIALS.has(code)) this.fail("credentials", `close ${code}`);
    // Anything else (the network, a voice server restarting) the library rejoins, through `feed`, with the same credentials.
  }

  private fail(reason: "kicked" | "credentials" | "error", detail: string) {
    if (this.lost || this.closed) return;
    this.lost = true;
    this.handlers.lost(reason, detail);
  }

  /**
   * A UDP packet, before the library has it. Audio from an SSRC Speaking has mapped opens its speaker's stream first
   * (the library hands a packet only to a stream already open); audio from one not mapped yet is held for when it is.
   */
  private udp(message: Buffer) {
    if (this.closed) return;
    if (message.length > 12 && message[0] >> 6 === 2 && (message[1] & 0x7f) === OPUS_PAYLOAD_TYPE) {
      const ssrc = message.readUInt32BE(8);
      const user = this.connection.receiver.ssrcMap.get(ssrc);
      if (!user) { this.hold(ssrc, message); return; }
      this.listen(user.userId);
      // In order, by its RTP sequence number: a packet in order goes on at once.
      this.jitter.push(ssrc, message.readUInt16BE(2), message);
      return;
    }
    this.receive(message);
  }

  private hold(ssrc: number, message: Buffer) {
    let held = this.early.get(ssrc);
    if (!held) {
      if (this.early.size >= EARLY_SSRCS) this.early.delete(this.early.keys().next().value!);
      this.early.set(ssrc, held = []);
    }
    held.push({ at: Date.now(), message });
    if (held.length > EARLY_PACKETS) held.shift();
  }

  /** Speaking mapped an SSRC to its user: what was held of it goes to the library now, in order, ahead of what follows. */
  private mapped(ssrc: number) {
    const held = this.early.get(ssrc);
    if (!held) return;
    this.early.delete(ssrc);
    const since = Date.now() - EARLY_MS;
    for (const { at, message } of held) if (at >= since) this.udp(message);
  }

  /** A speaker left the call (Client Disconnect): their stream closes, and anything held of their SSRC goes. */
  private left(userId: string, ssrc: number) {
    this.early.delete(ssrc);
    this.jitter.forget(ssrc);
    this.lostBefore.delete(userId);
    this.connection.receiver.subscriptions.get(userId)?.destroy();
  }

  /** For tests: the speakers with a stream open, and the packets held for SSRCs not mapped yet. */
  audio() {
    return { streams: [...this.listening].sort(), held: [...this.early.values()].reduce((sum, held) => sum + held.length, 0), heldSsrcs: this.early.size };
  }

  /**
   * A speaker's stream, open for the session: their packets as they arrive, cut into utterances by the segmenter. One
   * that breaks (a packet that would not decrypt) is reopened by their next packet.
   */
  private listen(userId: string) {
    if (this.listening.has(userId) || this.closed) return;
    this.listening.add(userId);
    const stream = this.connection.receiver.subscribe(userId, { end: { behavior: EndBehaviorType.Manual } });
    // Thrown from a stream's listener, an error would reach the process (uncaught) and end every session on the node:
    // a speaker's audio that cannot be handled is that speaker's alone.
    const guarded = (work: () => void) => {
      try { work(); }
      catch (error) { this.handlers.diagnostic("audio_failed", { error: safeError(error) }); }
    };
    stream.on("data", (packet: Buffer) => guarded(() => {
      const lost = this.lostBefore.get(userId) ?? 0;
      if (lost) this.lostBefore.delete(userId);
      this.handlers.packet(userId, packet, lost);
    }));
    stream.once("error", error => {
      this.handlers.diagnostic("stream_error", { error: error.message.slice(0, 200) });
      guarded(() => this.handlers.broken(userId));
    });
    stream.once("close", () => this.listening.delete(userId));
  }

  /** The DAVE group's members, as davey has them; undefined without a group. */
  private daveMembers(): string[] | undefined {
    const state = this.connection.state;
    if (state.status !== VoiceConnectionStatus.Ready) return undefined;
    const dave = (state.networking.state as { dave?: { session?: { getUserIds(): string[] } } }).dave;
    try { return dave?.session?.getUserIds(); } catch { return undefined; }
  }

  /** The members the voice gateway named (Clients Connect, less Client Disconnect). */
  private named(): Iterable<string> | undefined {
    const state = this.connection.state;
    if (state.status !== VoiceConnectionStatus.Ready) return undefined;
    return (state.networking.state as { connectionData?: { connectedClients?: Set<string> } }).connectionData?.connectedClients;
  }

  /** A stranger in the DAVE group: drop the connection and join again (a new group), or give up after a few. */
  private stranger(strangers: string[]) {
    if (this.closed || this.lost) return;
    const now = Date.now();
    while (this.rosterDrops.length && now - this.rosterDrops[0] > ROSTER_WINDOW_MS) this.rosterDrops.shift();
    this.rosterDrops.push(now);
    recordDaveRoster(strangers.length);
    this.handlers.diagnostic("dave_roster", { strangers: strangers.length, drops: this.rosterDrops.length });
    if (this.rosterDrops.length > MAX_ROSTER_DROPS) { this.fail("error", "dave_roster"); return; }
    // The two dispatches again: the library opens a new voice socket, identifies, and joins a new DAVE group.
    this.feed();
  }

  /**
   * Whether speech may go out now: the connection is ready, its DAVE group (if the call has one) is ready, and every
   * member of it is one the voice gateway named.
   */
  canSend() { return this.holding() === undefined; }

  /** Why speech is held back now (`canSend`): the connection, its DAVE group, or a member not named; undefined when it may go. */
  holding(): "connection" | "dave" | "roster" | undefined {
    const state = this.connection.state;
    if (this.closed || state.status !== VoiceConnectionStatus.Ready) return "connection";
    const dave = (state.networking.state as { dave?: { protocolVersion?: number; session?: { ready?: boolean } } }).dave;
    if (dave && dave.protocolVersion !== 0 && !dave.session?.ready) return "dave";
    return this.roster.pending ? "roster" : undefined;
  }

  /**
   * Play speech: `packets` (20 ms Opus at 48 kHz stereo) through the connection's player, each released only while
   * `canSend`. `started` is called as the first goes out. Done when they ran out (`done`), the playback was stopped
   * (another took its place, or `stop`), or it failed.
   */
  play(packets: AsyncIterable<Uint8Array>, started: () => void, expectedMs?: number): Playback {
    const player = this.player ??= createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause, maxMissedFrames: MAX_MISSED_FRAMES } });
    this.connection.subscribe(player);
    let stopped = false, failed = false, first = true;
    const self = this;
    // What happened to the speech, for its diagnostic: packets sent; how long each reason held them back; how long from
    // play to its first packet ready (the provider's first bytes and the start buffer: `startMs`); how long it waited
    // for packets after that (`waitedMs`, the jitter buffer refilling after a stall); and the silence the listener heard
    // between its first packet and its last (`gapMs`: the time between them, less the audio's length; the player takes
    // one packet a frame, and holds one at most, so a packet handed over late is a frame of silence).
    const stats = { packets: 0, heldMs: { connection: 0, dave: 0, roster: 0 }, startMs: 0, waitedMs: 0, gapMs: 0 };
    const asked = Date.now();
    let firstAt = 0, lastAt = 0;
    // A stop ends the speech at the next frame, even while it waits for the provider.
    let stopNow!: () => void;
    const stopping = new Promise<"stop">(resolve => { stopNow = () => resolve("stop"); });
    async function* gated() {
      // Through a jitter buffer: a provider that stalls mid-speech pauses it between phrases, not packet by packet.
      const iterator = buffered(packets, expectedMs !== undefined ? { expectedMs } : {})[Symbol.asyncIterator]();
      for (let waited = Date.now(); ;) {
        const next = await Promise.race([iterator.next(), stopping]);
        if (next === "stop" || next.done) {
          void iterator.return?.(undefined);
          // However it ends, five frames of Discord's silence follow the last of it (as Discord asks of a sender that
          // stops: the listener's decoder does not interpolate from a frame cut off mid-word), when any went out.
          if (firstAt && !self.closed) for (let frame = 0; frame < SILENCE_FRAMES; frame++) yield SILENCE;
          return;
        }
        if (firstAt) stats.waitedMs += Date.now() - waited;
        else stats.startMs = Date.now() - asked;
        for (let reason; (reason = self.holding());) {
          if (stopped || self.closed) return;
          const since = Date.now();
          await new Promise(resolve => setTimeout(resolve, 20));
          stats.heldMs[reason] += Date.now() - since;
        }
        if (stopped) continue;
        if (first) { first = false; firstAt = Date.now(); started(); }
        stats.packets++;
        lastAt = Date.now();
        yield Buffer.from(next.value);
        waited = Date.now();
      }
    }
    // One packet ahead of the player: the jitter buffer is the only buffer, so it sees a stall when the player would.
    const source = Readable.from(gated(), { objectMode: true, highWaterMark: 1 });
    const resource = createAudioResource(source, { inputType: StreamType.Opus });
    const done = new Promise<"done" | "stopped" | "error">(resolve => {
      const settle = () => {
        player.off("stateChange", changed);
        player.off("error", errored);
        const result = stopped ? "stopped" : failed ? "error" : "done";
        if (firstAt) stats.gapMs = Math.max(0, lastAt - firstAt - (stats.packets - 1) * 20);
        this.handlers.diagnostic("speech_played", { result, ...stats });
        resolve(result);
      };
      const changed = (_from: { status: string }, to: { status: string; resource?: unknown }) => {
        if (to.status === AudioPlayerStatus.Idle || (to.resource !== undefined && to.resource !== resource)) settle();
      };
      const errored = (error: { resource?: unknown; message: string }) => {
        if (error.resource !== resource) return;
        failed = true;
        this.handlers.diagnostic("speech_error", { error: error.message.slice(0, 200) });
      };
      player.on("stateChange", changed);
      player.on("error", errored);
    });
    player.play(resource);
    return {
      done, stats: () => ({ ...stats, heldMs: { ...stats.heldMs } }),
      stop: () => {
        if (stopped) return;
        stopped = true;
        // The speech ends at its next frame, with its silence frames, and the player goes idle after them.
        stopNow();
      },
    };
  }

  update(credentials: VoiceCredentials) {
    this.credentials = credentials;
    this.lost = false;
    this.rejoins = 0;
    this.feed();
  }

  others(): string[] | undefined {
    const state = this.connection.state;
    if (state.status !== VoiceConnectionStatus.Ready) return undefined;
    const members = (state.networking.state as { connectionData?: { connectedClients?: Set<string> } }).connectionData?.connectedClients;
    if (!members) return undefined;
    if (members.size) this.membersKnown = true;
    return this.membersKnown ? [...members] : undefined;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.roster.close();
    this.player?.stop(true);
    this.early.clear();
    this.jitter.close();
    for (const stream of this.connection.receiver.subscriptions.values()) stream.destroy();
    this.connection.destroy();
  }
}
