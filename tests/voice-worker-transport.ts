import { BroadcastChannel, threadId } from "node:worker_threads";
import type { VoiceConnection, VoiceCredentials, VoiceHandlers, VoiceTransport } from "../src/voice-sessions.ts";
import { Opus } from "../src/opus.ts";

/**
 * A voice transport for media workers in tests: built inside each worker (src/voice/media-worker.ts loads it by
 * module), driven from the test over a BroadcastChannel, which reaches every worker in the process. A command names its
 * connection by guild. People talk in real time from inside the worker (packets every 20 ms, encoded there), and a
 * connection can be made to fail as voice code has: a throw from a timer, a heap that runs out, a loop that never
 * yields. What it plays and how is reported back on the channel.
 */

export const CHANNEL = "camelrun-voice-test";
export type Command =
  | { guild: string; cmd: "ready" }
  | { guild: string; cmd: "talk"; speaker: string; seconds: number }
  | { guild: string; cmd: "send"; speaker: string; packets: Uint8Array[] }
  | { guild: string; cmd: "others"; users: string[] }
  | { guild: string; cmd: "crash" | "oom" | "hang" }
  /** Hold `mb` more MB of Buffers (as audio held by a connection is), reported by its `sizes()`. */
  | { guild: string; cmd: "hold"; mb: number };
export type Report =
  | { guild: string; event: "connected"; thread: number }
  | { guild: string; event: "played"; packets: number }
  | { guild: string; event: "closed" };

export function workerFakeTransport(options: { playEveryMs?: number } = {}): VoiceTransport {
  const channel = new BroadcastChannel(CHANNEL);
  channel.unref();
  const connections = new Map<string, { handlers: VoiceHandlers; others?: string[]; closed: boolean; held?: Buffer[] }>();
  const report = (message: Report) => channel.postMessage(message);
  // Real Opus packets: a tone, made once per worker.
  const encoder = new Opus(48_000, 2, "audio");
  const pcm = Buffer.alloc(960 * 4);
  for (let i = 0; i < 960; i++) { const sample = Math.round(0.3 * 32_767 * Math.sin(2 * Math.PI * 440 * i / 48_000)); pcm.writeInt16LE(sample, i * 4); pcm.writeInt16LE(sample, i * 4 + 2); }
  const loud = Array.from({ length: 10 }, () => new Uint8Array(encoder.encode(pcm, 960)));
  encoder.delete();
  channel.onmessage = (event: unknown) => {
    const command = (event as { data: Command }).data;
    const connection = connections.get(command.guild);
    if (!connection || connection.closed) return;
    switch (command.cmd) {
      case "ready": connection.handlers.ready(); return;
      case "others": connection.others = command.users; return;
      case "talk": {
        let sent = 0;
        const total = Math.round(command.seconds * 50);
        const timer = setInterval(() => {
          if (connection.closed || sent >= total) { clearInterval(timer); return; }
          connection.handlers.packet(command.speaker, loud[sent++ % loud.length]);
        }, 20);
        return;
      }
      case "send": {
        let sent = 0;
        const timer = setInterval(() => {
          if (connection.closed || sent >= command.packets.length) { clearInterval(timer); return; }
          connection.handlers.packet(command.speaker, command.packets[sent++]);
        }, 20);
        return;
      }
      // As the 2026-10-18 crash did: thrown from a timer, nothing catches it.
      case "crash": setTimeout(() => { throw new Error("voice test crash"); }, 0); return;
      case "oom": { const hoard: number[][] = []; for (;;) hoard.push(new Array(1_000_000).fill(1)); }
      case "hang": setTimeout(() => { for (;;) { /* never yields */ } }, 0); return;
      case "hold": { connection.held ??= []; for (let i = 0; i < command.mb; i++) connection.held.push(Buffer.alloc(1_048_576, 1)); return; }
    }
  };
  return {
    speaks: true,
    connect(credentials: VoiceCredentials, handlers: VoiceHandlers): VoiceConnection {
      const connection = { handlers, closed: false } as { handlers: VoiceHandlers; others?: string[]; closed: boolean; held?: Buffer[] };
      connections.set(credentials.guildId, connection);
      report({ guild: credentials.guildId, event: "connected", thread: threadId });
      return {
        update: () => {},
        others: () => connection.others,
        sizes: () => ({ heldMb: connection.held?.length ?? 0 }),
        close: () => { connection.closed = true; connections.delete(credentials.guildId); report({ guild: credentials.guildId, event: "closed" }); },
        play(packets, started) {
          let stopped = false, count = 0;
          const done = (async () => {
            try {
              for await (const packet of packets) {
                if (stopped || connection.closed) break;
                if (!count++) started();
                connection.handlers.played?.(packet);
                await new Promise(resolve => setTimeout(resolve, options.playEveryMs ?? 2));
              }
              return stopped ? "stopped" as const : "done" as const;
            } catch { return stopped ? "stopped" as const : "error" as const; }
            finally { report({ guild: credentials.guildId, event: "played", packets: count }); }
          })();
          return { done, stop: () => { stopped = true; } };
        },
      };
    },
  };
}

/** The test's end of the channel: commands out, reports in. */
export function workerFakes() {
  const channel = new BroadcastChannel(CHANNEL);
  const reports: Report[] = [];
  channel.onmessage = (event: unknown) => { reports.push((event as { data: Report }).data); };
  return {
    reports,
    send: (command: Command) => channel.postMessage(command),
    close: () => channel.close(),
  };
}
