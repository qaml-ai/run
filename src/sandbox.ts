import { spawn } from "node:child_process";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { frames } from "./sandbox-wire.ts";

/**
 * Where agent-launcher (sandbox/launcher.c) takes requests for confined processes: AGENT_SANDBOX_DIR,
 * which it sets for the runtime it starts. Without it (macOS, tests, not root) this process starts
 * them itself, unconfined.
 */
export const sandboxDir = () => process.env.AGENT_SANDBOX_DIR || undefined;

/** The programs that parse what tenants and models supply: v8-exec for js_exec, parse-job.ts for files. */
export type SandboxKind = "v8" | "parse";

/** How a process ended: its exit code or signal when known, or why it could not be started. */
export type Ended = { code: number | null; signal: string | null; error?: string };

/**
 * One process for one job, exchanging length-prefixed JSON frames (sandbox-wire.ts) on its stdin and
 * stdout. Under agent-launcher it is the launcher's child, reached over a connection to its socket
 * for `kind`, which is the process's stdin and stdout: its own uid, no environment, no_new_privs and
 * a seccomp filter. Closing the connection kills it, and the launcher sends how it ended as a last
 * frame. Without the launcher it is this process's child, started with `local`, with an empty
 * environment and only its pipes. Everything it sends is untrusted.
 */
export class Confined {
  /** The process's pid, for a process of this one's own. */
  readonly pid?: number;
  private ended?: Ended;
  private onMessage: (message: unknown) => void = () => {};
  private onClose?: (ended: Ended) => void;
  private readonly write: (message: unknown) => void;
  private readonly stop: () => void;

  constructor(kind: SandboxKind, local: { command: string; args: string[]; stderr?: "inherit" }) {
    const dir = sandboxDir();
    if (dir) {
      const socket = connect(join(dir, `${kind}.sock`));
      let exit: Ended | undefined;
      let failure: NodeJS.ErrnoException | undefined;
      let connected = false;
      socket.once("connect", () => { connected = true; });
      socket.on("error", error => { failure ??= error; });
      this.write = frames(socket, (message: any) => {
        // The launcher's, after the process's last: how it ended (the process could forge one too, which would only misreport it).
        if (message?.type === "exit") exit = { code: Number.isInteger(message.code) ? message.code : null, signal: typeof message.signal === "string" ? message.signal.slice(0, 16) : null };
        else this.onMessage(message);
      });
      socket.once("close", () => this.finish(exit ?? { code: null, signal: null, ...(failure && !connected ? { error: failure.code ?? failure.message } : {}) }));
      this.stop = () => socket.destroy();
      return;
    }
    const child = spawn(local.command, local.args, { stdio: ["pipe", "pipe", local.stderr ?? "ignore"], env: {} });
    this.pid = child.pid;
    child.stdin!.on("error", () => {});
    child.once("error", error => this.finish({ code: null, signal: null, error: (error as NodeJS.ErrnoException).code ?? error.message }));
    child.once("close", (code, signal) => this.finish({ code, signal }));
    this.write = frames(child.stdout as Socket, message => this.onMessage(message), undefined, child.stdin as Socket);
    this.stop = () => { child.kill("SIGKILL"); };
  }

  /** Whether the process has ended (or could not be started). */
  get closed() { return this.ended !== undefined; }

  /** Take its messages, and how it ended, once: at once if it already has. */
  listen(onMessage: (message: unknown) => void, onClose: (ended: Ended) => void) {
    this.onMessage = onMessage;
    if (this.ended) onClose(this.ended);
    else this.onClose = onClose;
  }

  /** Send a frame; throws if it is over the frame limit. */
  send(message: unknown) { this.write(message); }

  kill() { this.stop(); }

  private finish(ended: Ended) {
    if (this.ended) return;
    this.ended = ended;
    this.onClose?.(ended);
  }
}
