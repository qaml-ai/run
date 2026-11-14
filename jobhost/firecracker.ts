// The real launcher (docs/design/job-hosts-plan.md, slices 1 and 6): one Firecracker microVM per job, in Nitro Sandboxes
// direct mode, on a host built from infra/job-hosts/image. Plain KVM is supported with `kvm`. For each job it:
// - clones the base image (cp --reflink=always by default, or auto) and grows it to the job's disk;
// - makes the job slot's tap (network.ts), and writes the egress proxy's policy for the slot's guest address;
// - writes the Firecracker config (vm.ts firecrackerConfig) and starts `firecracker --no-api`;
// - connects to the guest agent over vsock (Firecracker's UDS: "CONNECT <port>"), the same NDJSON channel as fake mode.
// destroy() kills Firecracker and removes the clone, the tap, the policy and the socket. Booting needs a Nitro host
// or plain KVM with `kvm`; nothing here has run on one yet.
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { connect, type Socket } from "node:net";
import { open, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { DEFAULT_EGRESS, removePolicy, writePolicy } from "./egress-proxy.ts";
import { guestNetArgs, jobAddress, tapDown, tapUp, MAX_SLOTS } from "./network.ts";
import { boundedLines, firecrackerConfig, type GuestChannel, type GuestReply, type Vm, type VmLauncher, type VmShape } from "./vm.ts";

/** The guest agent's vsock port (the guest's init: socat VSOCK-LISTEN:5000 EXEC:camel-guest). */
export const GUEST_PORT = 5000;
/** How long a VM has to boot and answer on vsock. */
export const BOOT_DEADLINE_MS = 30_000;

export type FirecrackerOptions = {
  /** The pinned binary, the guest kernel and initrd, and the base root image (infra/job-hosts/image). */
  firecracker: string; kernel: string; initrd?: string; image: string;
  /** Where clones, configs, sockets and logs go (the host's NVMe). */
  work: string;
  /** Where the egress proxy reads job policies. */
  policyDir: string;
  /** Build hosts: dedicated vCPUs (no overcommit). */
  build?: boolean;
  /** Plain KVM (no Nitro Sandboxes): no enclave block. */
  kvm?: boolean;
  /** How the job's root disk is cloned: "always" (XFS reflink, the default) or "auto" (a copy where reflinks are missing). */
  reflink?: "always" | "auto";
  /** Opt in only for guest images whose init mounts the repo disk. */
  mountsRepo?: boolean;
  /** Names a job with internet may reach (DEFAULT_EGRESS), and the runtime's own host, always allowed then. */
  egress?: readonly string[];
  runtimeHost?: string;
  exec?: (file: string, args: string[]) => Promise<unknown>;
  /** Start Firecracker (tests swap it). */
  start?: (file: string, args: string[], log: string) => Promise<ChildProcess>;
  bootDeadlineMs?: number;
};

const run = (file: string, args: string[]) => promisify(execFile)(file, args);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * The guest channel over Firecracker's vsock UDS: connect, ask for the guest's port, then NDJSON as over stdio. Until
 * the guest is up, Firecracker refuses (or closes) the forward; it is tried again until the deadline.
 */
export async function vsockChannel(udsPath: string, port: number, deadlineMs: number): Promise<VsockChannel> {
  const until = Date.now() + deadlineMs;
  let last: unknown;
  while (Date.now() < until) {
    try { return await VsockChannel.open(udsPath, port, Math.max(500, until - Date.now())); }
    catch (error) { last = error; await sleep(50); }
  }
  throw new Error(`The VM did not answer on vsock in ${Math.round(deadlineMs / 1000)} s: ${last instanceof Error ? last.message : String(last)}`);
}

export class VsockChannel implements GuestChannel {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly socket: Socket;
  private readonly lines: AsyncIterator<string>;
  private constructor(socket: Socket, lines: AsyncIterator<string>) { this.socket = socket; this.lines = lines; }

  static open(udsPath: string, port: number, timeoutMs: number) {
    return new Promise<VsockChannel>((resolve, reject) => {
      const socket = connect(udsPath);
      const timer = setTimeout(() => { socket.destroy(); reject(new Error("vsock handshake timed out")); }, timeoutMs);
      socket.once("error", error => { clearTimeout(timer); reject(error); });
      socket.once("connect", () => {
        socket.write(`CONNECT ${port}\n`);
        const lines = boundedLines(socket);
        lines.next().then(({ value, done }) => {
          clearTimeout(timer);
          if (done || !/^OK \d+$/.test(String(value).trim())) { socket.destroy(); reject(new Error(`vsock refused: ${String(value ?? "closed").slice(0, 80)}`)); return; }
          resolve(new VsockChannel(socket, lines));
        }, error => { clearTimeout(timer); reject(error); });
      });
    });
  }

  request(request: Record<string, unknown>, onLog?: (stream: "stdout" | "stderr", data: string) => void) {
    const result = this.queue.then(async () => {
      this.socket.write(`${JSON.stringify(request)}\n`);
      for (;;) {
        const { value, done } = await this.lines.next();
        if (done) throw new Error("The guest stopped answering");
        const line = JSON.parse(value) as GuestReply & { event?: string; stream?: "stdout" | "stderr"; data?: string };
        if (line.event === "log") { onLog?.(line.stream!, line.data!); continue; }
        return line;
      }
    });
    this.queue = result.catch(() => {});
    return result;
  }
  close() { this.socket.destroy(); }
}

/** The real launcher. Slots are the job taps (network.ts): one VM per slot at a time. */
export function firecrackerLauncher(options: FirecrackerOptions): VmLauncher {
  const exec = options.exec ?? run;
  const vsockPath = (id: string) => join(options.work, `${id}.vsock`);
  const free = new Set(Array.from({ length: MAX_SLOTS }, (_, slot) => slot));
  const start = options.start ?? (async (file, args, log) => {
    const out = await open(log, "a");
    const child = spawn(file, args, { stdio: ["ignore", out.fd, out.fd], detached: false });
    child.once("exit", () => { void out.close(); });
    return child;
  });
  return {
    kind: "firecracker",
    mountsRepo: options.mountsRepo ?? false,
    vsockPath,
    async boot(id: string, shape: VmShape, boot: { internet?: boolean; repo?: string } = {}): Promise<Vm> {
      if (!/^[A-Za-z0-9._-]{1,96}$/.test(id)) throw new Error("Invalid job id");
      // A job disk is the base image grown by truncate + resize2fs; truncating below the filesystem corrupts it, so a
      // shape smaller than the base is refused before anything is allocated.
      const baseBytes = (await stat(options.image)).size;
      if (!Number.isSafeInteger(shape.diskMiB) || shape.diskMiB * 2 ** 20 < baseBytes)
        throw new Error(`invalid_request: job disk ${shape.diskMiB} MiB is smaller than the base image ${Math.ceil(baseBytes / 2 ** 20)} MiB`);
      const slot = [...free][0];
      if (slot === undefined) throw new Error("No free job slot on this host");
      free.delete(slot);
      const address = jobAddress(slot), internet = !!boot.internet;
      const disk = join(options.work, `${id}.ext4`), vsock = vsockPath(id), config = join(options.work, `${id}.json`), log = join(options.work, `${id}.log`);
      let child: ChildProcess | undefined, channel: VsockChannel | undefined, gone = false;
      const destroy = async () => {
        if (gone) return;
        gone = true;
        channel?.close();
        if (child && child.exitCode === null) {
          child.kill("SIGKILL");
          await new Promise(resolve => { const timer = setTimeout(resolve, 5_000); child!.once("exit", () => { clearTimeout(timer); resolve(undefined); }); });
        }
        await tapDown(address, exec);
        await removePolicy(options.policyDir, address.guestIp);
        await Promise.all([disk, vsock, config].map(file => rm(file, { force: true })));
        free.add(slot);
      };
      try {
        // The job's disk: a reflink clone of the base image (1.5 ms on XFS), grown to its size.
        await exec("cp", [`--reflink=${options.reflink ?? "always"}`, options.image, disk]);
        await exec("truncate", ["-s", `${shape.diskMiB}M`, disk]);
        await exec("resize2fs", ["-f", disk]);
        await tapUp(address, exec);
        // Its egress: the allowlist and the runtime with internet; nothing without (the proxy refuses a guest with no policy
        // entry it allows, and the host's rules give it no other way out).
        const allow = internet ? [...(options.egress ?? DEFAULT_EGRESS), ...(options.runtimeHost ? [options.runtimeHost] : [])] : [];
        await writePolicy(options.policyDir, address.guestIp, { job: id, allow });
        const base = firecrackerConfig({ id, kernel: options.kernel, initrd: options.initrd, disk, vsockPath: vsock, tap: address.tap, mac: address.mac }, shape, options.build, boot.repo, options.kvm);
        // RESTART uses the x86 i8042 reset port directly, even with the i8042 driver blacklisted.
        base["boot-source"].boot_args += ` reboot=k root=/dev/vda rw init=/sbin/camel-init ${guestNetArgs(address, internet)}`;
        if (boot.repo) base["boot-source"].boot_args += " camel.repo=/dev/vdb";
        await writeFile(config, JSON.stringify(base));
        await rm(vsock, { force: true });
        child = await start(options.firecracker, ["--no-api", "--config-file", config, "--id", id.slice(0, 64), "--level", "Warning"], log);
        const exited = new Promise<never>((_, reject) => child!.once("exit", code => reject(new Error(`Firecracker exited (${code}) before the guest answered; see ${log}`))));
        exited.catch(() => {}); // after boot, a Firecracker that exits shows up as the guest no longer answering
        channel = await Promise.race([vsockChannel(vsock, GUEST_PORT, options.bootDeadlineMs ?? BOOT_DEADLINE_MS), exited]);
        const ready = channel;
        return { id, request: (request, onLog) => ready.request(
          request.op === "camelfs_checkpoint" ? { ...request, legacyCheckpoint: true } : request, onLog), destroy };
      } catch (error) {
        await destroy().catch(() => {});
        throw error;
      }
    },
  };
}
