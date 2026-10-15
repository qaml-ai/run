import { randomUUID } from "node:crypto";
import {
  EndBehaviorType, joinVoiceChannel, VoiceConnectionStatus,
  type DiscordGatewayAdapterCreator, type DiscordGatewayAdapterLibraryMethods, type VoiceConnection as DiscordConnection,
} from "@discordjs/voice";
import type { VoiceConnection, VoiceCredentials, VoiceHandlers, VoiceTransport } from "./voice-sessions.ts";
import { recordDaveRoster } from "./metrics.ts";

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
 * The DAVE group's members, checked against the call's (`RosterGuard`'s doc on the module). `members` reads the group
 * (undefined without one: a call without DAVE, or before it joined); `named` the members the voice gateway named.
 * `stranger` is called once per stranger seen past `graceMs`; a check that finds none clears what was pending.
 */
export class RosterGuard {
  private readonly options: { self: string; graceMs: number; members(): string[] | undefined; named(): Iterable<string> | undefined; stranger(strangers: string[]): void };
  private since?: number;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(options: RosterGuard["options"]) { this.options = options; }

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
  return { connect: (credentials, handlers) => new DiscordVoice(credentials, handlers, options.roster ?? {}) };
}

class DiscordVoice implements VoiceConnection {
  private credentials: VoiceCredentials;
  private readonly handlers: VoiceHandlers;
  private methods?: DiscordGatewayAdapterLibraryMethods;
  private readonly connection: DiscordConnection;
  private readonly listening = new Set<string>();
  /** Reconnects since the connection was last ready. */
  private rejoins = 0;
  /** Whether the voice server has told of the call's members yet: until it has, they are unknown, not none. */
  private membersKnown = false;
  private closed = false;
  private lost = false;
  private readonly roster: RosterGuard;
  /** When the connection last dropped for a stranger in its DAVE group. */
  private readonly rosterDrops: number[] = [];

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
      }
    });
    this.connection.on("error", error => handlers.diagnostic("error", { error: error.message.slice(0, 200) }));
    // Each transition of the DAVE group (a Welcome, a commit) may have changed its members.
    this.connection.on("transitioned", () => this.roster.check());
    const receiver = this.connection.receiver;
    receiver.speaking.on("start", userId => this.listen(userId));
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

  /** Each speaker's packets as they arrive; a stream that breaks (a packet that would not decrypt) is reopened on their next. */
  private listen(userId: string) {
    if (this.listening.has(userId) || this.closed) return;
    this.listening.add(userId);
    const stream = this.connection.receiver.subscribe(userId, { end: { behavior: EndBehaviorType.Manual } });
    stream.on("data", (packet: Buffer) => this.handlers.packet(userId, packet));
    stream.once("error", error => {
      this.handlers.diagnostic("stream_error", { error: error.message.slice(0, 200) });
      this.handlers.broken(userId);
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
    for (const stream of this.connection.receiver.subscriptions.values()) stream.destroy();
    this.connection.destroy();
  }
}
