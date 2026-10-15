import type { VoiceConnection, VoiceCredentials, VoiceHandlers, VoiceTransport } from "../src/voice-sessions.ts";

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

let counter = 0;
/** A create request's `discord`, as Discord's two dispatches would give it. */
export function discordGrant(overrides: Partial<VoiceCredentials> = {}) {
  counter++;
  return {
    guildId: "100000000000000001", channelId: "200000000000000002", userId: "300000000000000003",
    sessionId: `session${counter}`, endpoint: "c-test-1.discord.media:443", token: `token-${counter}`, ...overrides,
  };
}
