// A job's VM, as the host agent drives it (docs/design/job-hosts-plan.md, slice 3): its disk is a copy-on-write clone,
// it boots, and the host talks to its guest agent (guest.ts) over one channel.
//
// - FakeVm (tests, sprites): the "disk" is a directory cloned from a base directory (cp --reflink=auto), and the guest
//   runs as a local process over stdio. No isolation: for the runtime's end-to-end tests only.
// - Firecracker (`firecrackerConfig`, and firecracker.ts's launcher): the configuration a real host boots with, in Nitro
//   Sandboxes direct mode, on the host image infra/job-hosts/image builds.
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { cp, mkdir, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export type GuestReply = { ok: boolean; error?: string; [key: string]: unknown };
export interface GuestChannel {
  /** One request, its answer; `onLog` hears the command's output while it runs. */
  request(request: Record<string, unknown>, onLog?: (stream: "stdout" | "stderr", data: string) => void): Promise<GuestReply>;
}
export interface Vm extends GuestChannel {
  readonly id: string;
  /** Stop the VM and drop its disk clone. Safe to call more than once. */
  destroy(): Promise<void>;
}
export type VmShape = { vcpus: number; memoryMiB: number; diskMiB: number };
export interface VmLauncher {
  readonly kind: "fake" | "firecracker";
  /** The guest mounts the repo disk before accepting commands. */
  readonly mountsRepo?: boolean;
  vsockPath?(id: string): string;
  /** `internet`: the job may reach its egress allowlist (a real host's proxy); without it, nothing. */
  boot(id: string, shape: VmShape, options?: { internet?: boolean; repo?: string }): Promise<Vm>;
}

/**
 * The longest line the host takes from a guest. The largest honest reply is a `run` with both streams at their cap,
 * base64 (2 × 8 MiB × 4/3, about 22 MiB); a guest is untrusted (root in its VM, it can replace camel-guest), so a line
 * past this ends the channel rather than growing the host agent's memory.
 */
export const GUEST_LINE_BYTES = 32 * 1024 * 1024;

/** Lines from a guest's stream, each at most `max` bytes: past it the stream is destroyed and the reader throws. */
export function boundedLines(input: NodeJS.ReadableStream & { destroy(error?: Error): void }, max = GUEST_LINE_BYTES): AsyncIterator<string> {
  const ready: string[] = [];
  let partial: Buffer[] = [], size = 0, ended = false, failure: Error | undefined;
  let wake: (() => void) | undefined;
  const notify = () => { const resume = wake; wake = undefined; resume?.(); };
  input.on("data", (chunk: Buffer | string) => {
    let data = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    for (let at = data.indexOf(10); at >= 0; at = data.indexOf(10)) {
      partial.push(data.subarray(0, at));
      ready.push(Buffer.concat(partial).toString("utf8").replace(/\r$/, ""));
      partial = []; size = 0; data = data.subarray(at + 1);
    }
    if (data.length) {
      size += data.length;
      if (size > max) { failure = new Error(`The guest sent a line over ${max} bytes`); partial = []; input.destroy(failure); notify(); return; }
      partial.push(data);
    }
    notify();
  });
  input.on("end", () => { ended = true; notify(); });
  input.on("close", () => { ended = true; notify(); });
  input.on("error", error => { failure ??= error as Error; notify(); });
  return {
    async next() {
      for (;;) {
        if (ready.length) return { value: ready.shift()!, done: false };
        if (failure) throw failure;
        if (ended) return { value: undefined, done: true };
        await new Promise<void>(resolve => { wake = resolve; });
      }
    },
  };
}

/** A guest channel over a child's stdio (newline-delimited JSON, guest.ts). */
class StdioChannel implements GuestChannel {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly lines: AsyncIterator<string>;
  private readonly child: ChildProcess;
  constructor(child: ChildProcess) {
    this.child = child;
    this.lines = boundedLines(child.stdout as never);
  }
  request(request: Record<string, unknown>, onLog?: (stream: "stdout" | "stderr", data: string) => void) {
    const result = this.queue.then(async () => {
      this.child.stdin!.write(`${JSON.stringify(request)}\n`);
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
}

const GUEST = fileURLToPath(new URL("./guest.ts", import.meta.url));

/** The fake launcher: a directory for a disk, the guest as a local process. `base` is cloned for each job when given. */
export function fakeLauncher(options: { base?: string; work?: string } = {}): VmLauncher {
  const work = options.work ?? join(tmpdir(), `jobhost-${randomUUID()}`);
  return {
    kind: "fake",
    mountsRepo: true,
    vsockPath: id => join(work, `${id}.vsock`),
    async boot(id, _shape, boot = {}) {
      const root = join(work, id);
      await rm(root, { recursive: true, force: true });
      if (options.base) await cp(options.base, root, { recursive: true, mode: constants.COPYFILE_FICLONE }); // a reflink where the filesystem has one
      else await mkdir(root, { recursive: true });
      if (boot.repo) {
        await rm(join(root, "repo"), { recursive: true, force: true });
        await symlink(boot.repo, join(root, "repo"));
      } else await mkdir(join(root, "repo"), { recursive: true });
      await mkdir(join(root, "out"), { recursive: true });
      const child = spawn(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", GUEST, "--root", root], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, CAMEL_VSOCK_UDS: join(work, `${id}.vsock`) } });
      const channel = new StdioChannel(child);
      let gone = false;
      return {
        id,
        request: (request, onLog) => channel.request(request, onLog),
        async destroy() {
          if (gone) return;
          gone = true;
          // The guest kills its command when its channel closes or it is told to stop; the command's group is also
          // killed here, from the file the guest wrote, in case the guest itself is already gone.
          const group = Number(await readFile(join(root, ".job.pgid"), "utf8").catch(() => ""));
          child.stdin?.end();
          child.kill("SIGTERM");
          if (Number.isInteger(group) && group > 1) try { process.kill(-group, "SIGKILL"); } catch { /* already gone */ }
          await new Promise(resolve => { const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(undefined); }, 2_000); child.once("exit", () => { clearTimeout(timer); resolve(undefined); }); });
          await rm(root, { recursive: true, force: true });
        },
      };
    },
  };
}

/**
 * The Firecracker v1.18 configuration for one job in Nitro Sandboxes direct mode (the 2026-11-11 spike's): the guest
 * kernel and initrd, its root disk (the job's reflink clone) with the Async I/O engine, its vCPUs and memory, the vsock
 * the guest agent listens on, and its tap. A build sandbox gets no CPU overcommit.
 */
export function firecrackerConfig(job: { id: string; kernel: string; initrd: string; disk: string; vsockPath: string; tap: string; mac: string }, shape: VmShape, build = false, repo?: string) {
  return {
    "boot-source": { kernel_image_path: job.kernel, initrd_path: job.initrd, boot_args: "console=ttyS0 panic=1 initcall_blacklist=i8042_init quiet" },
    drives: [{ drive_id: "root", path_on_host: job.disk, is_root_device: true, is_read_only: false, io_engine: "Async" },
      ...(repo ? [{ drive_id: "repo", path_on_host: repo, is_root_device: false, is_read_only: false, io_engine: "Async" }] : [])],
    "machine-config": { vcpu_count: shape.vcpus, mem_size_mib: shape.memoryMiB, smt: false },
    vsock: { guest_cid: 3, uds_path: job.vsockPath },
    "network-interfaces": [{ iface_id: "eth0", host_dev_name: job.tap, guest_mac: job.mac }],
    enclave: { direct_mode: true, cpu_overcommit: !build },
  };
}
