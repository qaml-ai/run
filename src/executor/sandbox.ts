import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Rpc } from "../rpc.ts";

/** One execution's code child. `kill` may be called any number of times; `closed` settles once the child is gone and its state removed. */
export type Sandbox = { rpc: Rpc; pid?: number; kill(): void; readonly closed: Promise<unknown> };
/** Starts a fresh sandbox for every execution. Nothing is shared between two of them. */
export type SandboxLauncher = { readonly kind: "process" | "runsc"; launch(): Promise<Sandbox> };

const CHILD = fileURLToPath(new URL("./sandbox-child.ts", import.meta.url));
export const SANDBOX_HELPER = "/usr/local/libexec/agent-executor/sandbox";
// Covers the largest tool result, request or final result, JSON-escaped.
const MESSAGE_BYTES = 8 * 1024 * 1024;

/** AGENT_EXECUTOR_SANDBOX=runsc on executor hosts; the default, a plain child process, serves development and tests. */
export function sandboxLauncher(kind = "process", options: { runtime?: string; helper?: string } = {}): SandboxLauncher {
  if (kind === "process") return processLauncher(options.runtime);
  if (kind === "runsc") return runscLauncher(options.helper);
  throw new Error("AGENT_EXECUTOR_SANDBOX must be runsc or process");
}

/** A child process with a fixed PATH/HOME/TMPDIR and a private work directory. No isolation beyond that. */
export function processLauncher(runtime = process.execPath): SandboxLauncher {
  const flags = runtime.toLowerCase().includes("bun") ? [] : ["--experimental-strip-types", "--disable-warning=ExperimentalWarning"];
  return {
    kind: "process",
    async launch() {
      const directory = await mkdtemp(join(tmpdir(), "codemode-"));
      const child = spawn(runtime, [...flags, CHILD], {
        cwd: directory,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: directory, TMPDIR: directory },
        stdio: ["pipe", "pipe", "inherit"],
      });
      return stdioSandbox(child, () => child.kill("SIGKILL"), () => rm(directory, { recursive: true, force: true }));
    },
  };
}

/**
 * A fresh gVisor sandbox per execution, started by the root-owned helper
 * (infra/executor/sandbox.sh) that the executor's user may run through sudo and
 * nothing else. The helper alone decides what a sandbox sees: the image's
 * filesystem read-only, a tmpfs work directory, no network, cgroup limits. So an
 * executor process a guest has taken over cannot ask for more.
 */
export function runscLauncher(helper = SANDBOX_HELPER, sudo = process.getuid?.() !== 0): SandboxLauncher {
  const command = (args: string[], stdin: "pipe" | "ignore") => spawn(sudo ? "sudo" : helper, sudo ? ["-n", helper, ...args] : args, {
    env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" },
    stdio: [stdin, stdin, "inherit"],
  });
  return {
    kind: "runsc",
    async launch() {
      const id = randomUUID();
      const child = command(["run", id], "pipe");
      let killed = false;
      // The user cannot signal sudo (it runs as root), so the helper kills the sandbox on
      // request. Closing stdin also ends the child, and covers a kill that races the start.
      const kill = () => {
        if (killed) return;
        killed = true;
        child.stdin?.end();
        if (child.exitCode === null && child.signalCode === null) command(["kill", id], "ignore").on("error", () => {});
      };
      return stdioSandbox(child, kill, async () => {});
    },
  };
}

/** An Rpc over the child's stdin/stdout, one JSON message per line. */
function stdioSandbox(child: ChildProcess, kill: () => void, cleanup: () => Promise<unknown>): Sandbox {
  const rpc = new Rpc(message => {
    if (!child.stdin?.writable) throw new Error("Process disconnected");
    child.stdin.write(`${JSON.stringify(message)}\n`);
  });
  const fail = (reason: string) => { rpc.close(reason); kill(); };
  // A write racing the child's exit fails with EPIPE; the exit already closed the Rpc.
  child.stdin!.on("error", () => {});
  let buffered = "";
  child.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
    buffered += chunk;
    let newline;
    while ((newline = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      let message;
      try { message = JSON.parse(line); } catch { return fail("Sandbox sent an invalid message"); }
      void rpc.receive(message);
    }
    if (buffered.length > MESSAGE_BYTES) fail("Sandbox message exceeds size limit");
  });
  child.on("exit", (code, signal) => rpc.close(`Process exited (${signal ?? code})`));
  const closed = new Promise<void>(resolve => {
    child.once("close", () => resolve());
    // A child that never started emits no close.
    child.on("error", error => { rpc.close(error.message); if (child.pid === undefined) resolve(); });
  }).then(cleanup);
  return { rpc, pid: child.pid, kill, closed };
}
