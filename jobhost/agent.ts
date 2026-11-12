// The job host agent (docs/design/job-hosts-plan.md, slices 3 and 4). It enrolls (an attestation of who it is, for a
// short-lived credential bound to that host id), dials out to the runtime over one WebSocket (no inbound ports) with
// the credential as its first message, enrolls again before the credential ends, says how many jobs it takes, and runs the jobs the runtime sends: a VM per job from
// a copy-on-write clone (vm.ts), the job's files synced in, its command run under its limits by the guest agent
// (guest.ts), its outputs collected and sent back, the VM destroyed. A job the runtime cancels is destroyed at once.
// While the socket is down, jobs keep running and their results wait to be sent when it is back.
//
//   node --experimental-strip-types jobhost/agent.ts --runtime https://run.example --attestor aws --slots 8 --firecracker
//   node … --attestor test --name host-1 --fake      (JOB_HOST_TEST_SECRET from the environment: tests only)
import { hostname } from "node:os";
import { createHash } from "node:crypto";
import { frames, Frames, type HostMessage, type RuntimeMessage, type WireJob, type WireResult } from "../shared/job-host-protocol.ts";
import { signGetCallerIdentity, type Attestation } from "../shared/job-host-attest.ts";
import { fakeLauncher, type Vm, type VmLauncher } from "./vm.ts";
import { firecrackerLauncher } from "./firecracker.ts";
import { camelfsdClient, serveImportProxy, type Camelfsd, type CamelfsMount } from "./camelfsd.ts";

export const AGENT_VERSION = "0.2.0";
/** Less free disk than this before the command fails the job `disk_low`, as a container job does. */
const DISK_LOW_BYTES = 2 * 1024 * 1024 * 1024;

export type AgentOptions = {
  /** Proves who this host is, for each enrollment: AWS (awsAttestor) on a real host, a test secret in tests. */
  runtime: string; attest: (audience: string) => Promise<Attestation>; slots: number; vcpus: number; memoryMiB: number;
  /** The pool this host serves (build or test: the image's POOL); placement sends it only that pool's jobs. */
  pool?: "build" | "test";
  camelfsd?: Camelfsd;
  launcher: VmLauncher; heartbeatMs?: number; diskLowBytes?: number; log?: (line: Record<string, unknown>) => void;
};

export class HostAgent {
  private socket?: WebSocket;
  private readonly frames = new Frames();
  private readonly running = new Map<string, { vm?: Vm; cancelled: boolean }>();
  private readonly outbox: HostMessage[] = [];
  private closed = false;
  private registered = Promise.withResolvers<void>();
  private readonly options: AgentOptions;
  /** The host id the runtime bound this host's credential to (the attestation's, not one it chose). */
  name = "";
  constructor(options: AgentOptions) { this.options = options; }

  /** Enroll: the attestation for this runtime, a credential back (shared/job-host-attest.ts, hosts.ts). */
  private async enroll() {
    const audience = `camelrun-job-host:${this.options.runtime.replace(/\/+$/, "")}`;
    const response = await fetch(`${this.options.runtime.replace(/\/+$/, "")}/v1/internal/job-hosts/enroll`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ attestation: await this.options.attest(audience) }), signal: AbortSignal.timeout(30_000),
    });
    const body = await response.json().catch(() => ({})) as { host?: string; credential?: string; expiresAt?: number; error?: string };
    if (!response.ok || !body.host || !body.credential || !body.expiresAt) throw new Error(`Enrollment refused: ${response.status} ${body.error ?? ""}`.trim());
    return body as { host: string; credential: string; expiresAt: number };
  }
  private log(line: Record<string, unknown>) { (this.options.log ?? (value => console.log(JSON.stringify(value))))(line); }

  /** Connect, and keep connecting until `close()`. Resolves once the runtime has registered this host. */
  start() { void this.connectLoop(); return this.registered.promise; }
  async close() {
    this.closed = true;
    this.socket?.close();
    await Promise.all([...this.running.values()].map(job => job.vm?.destroy()));
  }

  private async connectLoop() {
    for (let delay = 500; !this.closed; delay = Math.min(delay * 2, 30_000)) {
      try { await this.connectOnce(); delay = 500; }
      catch (error) { this.log({ type: "jobhost_connect_failed", error: error instanceof Error ? error.message.slice(0, 200) : "unknown" }); }
      if (!this.closed) await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  private async connectOnce() {
    const enrolled = await this.enroll();
    this.name = enrolled.host;
    return new Promise<void>((resolve, reject) => {
      const url = `${this.options.runtime.replace(/^http/, "ws")}/v1/internal/job-hosts/connect?host=${encodeURIComponent(enrolled.host)}`;
      const socket = new WebSocket(url);
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      // Before the credential ends: close, and the loop enrolls again and reconnects (jobs keep running meanwhile).
      const left = enrolled.expiresAt - Date.now();
      const renew = setTimeout(() => socket.close(1000, "Renewing"), Math.max(30_000, left - Math.min(60_000, left / 5)));
      socket.addEventListener("open", () => {
        this.socket = socket;
        // The credential is the first message, not part of the URL: a URL lands in access logs.
        socket.send(JSON.stringify({ type: "auth", credential: enrolled.credential }));
        // Its free slots as they are: jobs in flight across a reconnect still hold theirs.
        this.send({ type: "hello", host: enrolled.host, slots: this.options.slots, free: this.options.slots - this.running.size, vcpus: this.options.vcpus, memoryMiB: this.options.memoryMiB, version: AGENT_VERSION, ...(this.options.camelfsd && this.options.launcher.mountsRepo ? { features: ["camelfs"] } : {}), ...(this.options.pool ? { pool: this.options.pool } : {}) });
        heartbeat = setInterval(() => this.send({ type: "heartbeat", running: [...this.running.keys()], free: this.options.slots - this.running.size }), this.options.heartbeatMs ?? 10_000);
      });
      socket.addEventListener("message", event => {
        let message: RuntimeMessage | undefined;
        try { message = this.frames.add(String(event.data)) as RuntimeMessage | undefined; }
        catch (error) { this.log({ type: "jobhost_frame_invalid", error: String(error).slice(0, 200) }); return; }
        if (message) this.receive(message);
      });
      socket.addEventListener("close", () => {
        clearInterval(heartbeat);
        clearTimeout(renew);
        if (this.socket === socket) this.socket = undefined;
        resolve();
      });
      socket.addEventListener("error", () => reject(new Error("WebSocket error")));
    });
  }

  private send(message: HostMessage) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      // Results and starts wait for the next connection (a start is when a job's charge begins); heartbeats and hellos
      // are made again then.
      if (message.type === "result" || message.type === "started") this.outbox.push(message);
      return;
    }
    for (const frame of frames(message)) this.socket.send(frame);
  }

  private receive(message: RuntimeMessage) {
    if (message.type === "registered") {
      this.log({ type: "jobhost_registered", host: message.host });
      for (const pending of this.outbox.splice(0)) this.send(pending);
      this.registered.resolve();
    } else if (message.type === "job") void this.run(message.id, message.spec);
    else if (message.type === "cancel") void this.cancel(message.id);
  }

  private async cancel(id: string) {
    const job = this.running.get(id);
    if (!job) return;
    job.cancelled = true;
    await job.vm?.destroy();
  }

  /** One job, start to stop. Every outcome is a result; the VM is destroyed whatever happened. */
  async run(id: string, spec: WireJob) {
    if (this.running.has(id)) return;
    if (this.running.size >= this.options.slots) { this.send({ type: "result", id, result: { ok: false, code: "start_failed", message: "This host has no free slot" } }); return; }
    const job: { vm?: Vm; cancelled: boolean } = { cancelled: false };
    this.running.set(id, job);
    const began = Date.now();
    let result: WireResult;
    let mounted: CamelfsMount | undefined;
    let mountAttempted = false;
    // Set once its VM has started: every result from then on says when (its charge, if its `started` report was lost).
    let startMs: number | undefined;
    try {
      if (spec.camelfs) {
        if (!this.options.camelfsd) throw new Error("This host has no camelFS daemon");
        if (!this.options.launcher.mountsRepo) throw new Error("This host cannot attach a camelFS repo disk yet");
        // A failed request may still have created a lease in the daemon.
        mountAttempted = true;
        mounted = await this.options.camelfsd.mount({ jobId: id, lineage: spec.camelfs.lineage, tree: spec.camelfs.tree, vsock: this.options.launcher.vsockPath?.(id) ?? "" });
        if (job.cancelled) throw new Stopped();
      }
      const shape = { vcpus: Math.max(1, Math.ceil(spec.limits.cpus ?? 1)), memoryMiB: spec.limits.memoryMiB ?? 2048, diskMiB: spec.limits.diskMiB ?? 8192 };
      const vm = job.vm = await this.options.launcher.boot(id, shape, { internet: spec.internet, ...(mounted ? { repo: mounted.image } : {}) });
      if (job.cancelled) throw new Stopped();
      this.send({ type: "started", id, at: Date.now() });
      startMs = Date.now() - began;
      let applyMs = 0;
      if (mounted) {
        const applied = await vm.request({ op: "camelfs_apply", jobId: id, timeoutMs: 600_000 });
        if (!applied.ok) { result = { ok: false, code: "sync_failed", message: "camelFS apply failed: " + String(applied.error) }; return; }
        applyMs = Number(applied.applyMs);
      }
      const synced = spec.files.length ? await vm.request({ op: "files", files: spec.files }) : { ok: true, syncMs: 0 };
      if (!synced.ok) { result = { ok: false, code: "sync_failed", message: String(synced.error ?? "sync failed") }; return; }
      if (spec.sync && !spec.camelfs) {
        try { synced.syncMs = Number(synced.syncMs ?? 0) + await pullFiles(vm, spec.sync); }
        catch (error) { result = { ok: false, code: "sync_failed", message: error instanceof Error ? error.message.slice(0, 300) : "sync failed" }; return; }
      }
      const free = await vm.request({ op: "free" });
      if (free.ok && Number(free.freeBytes) < (this.options.diskLowBytes ?? DISK_LOW_BYTES)) {
        result = { ok: false, code: "disk_low", message: `Under ${Math.round((this.options.diskLowBytes ?? DISK_LOW_BYTES) / 2 ** 30)} GiB free before the command` };
        return;
      }
      // A pid cap is the guest's to apply only where the guest owns the machine (a VM): a fake guest shares the host.
      const pids = this.options.launcher.kind === "firecracker" ? spec.limits.pids : undefined;
      const ran = await vm.request({ op: "run", command: spec.command, timeoutSeconds: spec.timeoutSeconds, ...(pids ? { pids } : {}), ...(spec.secretEnv ? { env: spec.secretEnv } : {}) });
      if (job.cancelled) throw new Stopped();
      if (!ran.ok) { result = { ok: false, code: "container_failed", message: String(ran.error ?? "the command could not run") }; return; }
      const collected = await vm.request({ op: "collect", outputs: spec.outputs });
      result = {
        ok: true, exitCode: ran.exitCode as number | null, timedOut: ran.timedOut as boolean, stdout: ran.stdout as never, stderr: ran.stderr as never,
        outputs: (collected.outputs ?? {}) as never, missing: (collected.missing ?? spec.outputs) as string[],
        timings: { startMs, syncMs: Number(synced.syncMs ?? 0), commandMs: Number(ran.commandMs ?? 0), collectMs: Number(collected.collectMs ?? 0), totalMs: Date.now() - began },
        pids: pids ? "enforced" : "unenforced",
        ...(mounted ? { camelfs: { warm: mounted.warm, mountMs: mounted.mountMs, applyMs } } : {}),
      };
      if (spec.camelfs?.commit && result.camelfs && collected.ok) {
        const cfs = result.camelfs;
        if (ran.exitCode !== 0 || ran.timedOut) cfs.checkpointError = "not checkpointed: the command did not exit 0";
        else {
          const [daemon, guest] = await Promise.allSettled([
            Promise.resolve().then(() => {
              if (!this.options.camelfsd!.checkpoint) throw new Error("This host has no camelFS checkpoint adapter");
              return this.options.camelfsd!.checkpoint(id, 600_000);
            }),
            Promise.resolve().then(() => vm.request({ op: "camelfs_checkpoint", jobId: id, timeoutMs: 600_000 })),
          ]);
          const reason = (error: unknown) => error instanceof Error ? error.message : String(error);
          let error = guest.status === "rejected" ? `guest: ${reason(guest.reason)}`
            : !guest.value.ok ? `guest: ${guest.value.error}`
            : daemon.status === "rejected" ? `daemon: ${reason(daemon.reason)}` : undefined;
          error = error?.slice(0, 300);
          try {
            const confirmed = await vm.request({ op: "camelfs_checkpointed", ...(error ? { error } : { tree: daemon.status === "fulfilled" ? daemon.value.tree : undefined }) });
            if (!error && !confirmed.ok) error = `guest: ${confirmed.error}`.slice(0, 300);
          } catch (failure) { error ??= `guest: ${reason(failure)}`.slice(0, 300); }
          if (error) cfs.checkpointError = error;
          else if (daemon.status === "fulfilled" && guest.status === "fulfilled") {
            const d = daemon.value, g = guest.value;
            cfs.tree = d.tree; cfs.root = d.root; cfs.checkpointMs = d.checkpointMs;
            cfs.checkpoint = { walkMs: Number(g.walkMs), streamMs: Number(g.streamMs), freezeMs: Number(g.freezeMs), files: Number(g.files), bytes: Number(g.bytes), skipped: Number(g.skipped),
              changedChunks: d.changedChunks, uploadedChunks: d.uploadedChunks, changedBytes: d.changedBytes, reflinkMs: d.reflinkMs, fiemapMs: d.fiemapMs, hashMs: d.hashMs, uploadMs: d.uploadMs };
          }
        }
        result.timings.totalMs = Date.now() - began;
      }
    } catch (error) {
      result = job.cancelled || error instanceof Stopped ? { ok: false, code: "stopped", message: "The job was stopped" }
        : { ok: false, code: job.vm ? "container_failed" : "start_failed", message: error instanceof Error ? error.message.slice(0, 300) : "The VM failed" };
    } finally {
      await job.vm?.destroy().catch(() => {});
      if (mountAttempted) await this.options.camelfsd!.release(id).catch(() => this.log({ type: "jobhost_camelfs_release_failed", id }));
      this.running.delete(id);
      const final: WireResult = result! ?? { ok: false, code: "container_failed", message: "No result" };
      this.send({ type: "result", id, result: !final.ok && startMs !== undefined ? { ...final, timings: { startMs, totalMs: Date.now() - began } } : final });
    }
  }
}
/** A piece of a large file written into the VM per request: under the host's line cap once in base64. */
export const SYNC_PIECE_BYTES = 4 * 1024 * 1024;

/**
 * Host-side sync (a tree too large to cross inline): each file fetched from the runtime with the job's token, its size
 * and sha256 checked as it streams, and written into the VM in pieces. The token never reaches the VM. Returns the ms it
 * took.
 */
export async function pullFiles(vm: Pick<Vm, "request">, sync: NonNullable<WireJob["sync"]>, fetcher: typeof fetch = fetch) {
  const began = Date.now();
  // The whole sync is bounded by the job's own deadline (`until`): past it, every fetch in flight is aborted.
  const controller = new AbortController(), signal = controller.signal;
  let timedOut = false;
  const deadline = setTimeout(() => { timedOut = true; controller.abort(new Error("Host-side sync ran past the job's deadline")); }, Math.max(1, (sync.until ?? began + 10 * 60_000) - began));
  const one = async (index: number) => {
    const file = sync.files[index]!;
    const response = await fetcher(`${sync.url}/${index}`, { headers: { authorization: `Bearer ${sync.token}` }, signal });
    if (!response.ok || !response.body) throw new Error(`${file.path}: the runtime answered ${response.status}`);
    const hash = createHash("sha256"), reader = response.body.getReader();
    let size = 0, first = true, chunks: Uint8Array[] = [], held = 0;
    // A piece of at most SYNC_PIECE_BYTES per write (a stream's chunks can be any size), joined once per piece.
    const write = async (last: boolean) => {
      while (held >= SYNC_PIECE_BYTES || (last && (held || first))) {
        const all = Buffer.concat(chunks, held), piece = all.subarray(0, SYNC_PIECE_BYTES), rest = all.subarray(piece.length);
        chunks = rest.length ? [rest] : []; held = rest.length;
        const wrote = await vm.request({ op: "files", files: [{ path: file.path, data: piece.toString("base64"), ...(first ? {} : { append: true }) }] });
        if (!wrote.ok) throw new Error(`${file.path}: ${String(wrote.error ?? "could not be written")}`);
        first = false;
      }
    };
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > file.size) { await reader.cancel().catch(() => {}); throw new Error(`${file.path}: larger than its manifest says`); }
      hash.update(value);
      chunks.push(value); held += value.byteLength;
      if (held >= SYNC_PIECE_BYTES) await write(false);
    }
    await write(true);
    if (size !== file.size || hash.digest("hex") !== file.sha256) throw new Error(`${file.path}: file integrity check failed`);
  };
  // A few files at a time (many small files are mostly round trips); the first failure ends the sync.
  let next = 0, failure: unknown;
  const worker = async () => {
    while (failure === undefined && next < sync.files.length) {
      const index = next++;
      // The first failure ends the sync at once: the fetches still in flight are aborted too.
      try { await one(index); } catch (error) { if (failure === undefined) { failure = error; controller.abort(error); } }
    }
  };
  try { await Promise.all(Array.from({ length: Math.min(SYNC_PARALLEL, sync.files.length) }, worker)); }
  finally { clearTimeout(deadline); }
  if (timedOut) throw new Error("Host-side sync ran past the job's deadline");
  if (failure !== undefined) throw failure;
  return Date.now() - began;
}
/** Files fetched at once in host-side sync. */
export const SYNC_PARALLEL = 6;

class Stopped extends Error {}

/**
 * The production attestor: this instance's role credentials from IMDSv2, signing sts:GetCallerIdentity for the runtime
 * (shared/job-host-attest.ts). The runtime learns the host id from STS (the role session: this instance's id).
 */
export function awsAttestor(imds = "http://169.254.169.254") {
  return async (audience: string): Promise<Attestation> => {
    const tokenResponse = await fetch(`${imds}/latest/api/token`, { method: "PUT", headers: { "x-aws-ec2-metadata-token-ttl-seconds": "300" } });
    if (!tokenResponse.ok) throw new Error(`IMDS token: ${tokenResponse.status}`);
    const token = await tokenResponse.text();
    const get = async (path: string) => { const response = await fetch(`${imds}${path}`, { headers: { "x-aws-ec2-metadata-token": token } }); if (!response.ok) throw new Error(`IMDS ${path}: ${response.status}`); return response.text(); };
    const role = (await get("/latest/meta-data/iam/security-credentials/")).split("\n")[0]!.trim();
    const credentials = JSON.parse(await get(`/latest/meta-data/iam/security-credentials/${role}`)) as { AccessKeyId: string; SecretAccessKey: string; Token: string };
    const region = (await get("/latest/meta-data/placement/region")).trim();
    return signGetCallerIdentity({ accessKeyId: credentials.AccessKeyId, secretAccessKey: credentials.SecretAccessKey, sessionToken: credentials.Token }, audience, { region });
  };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const arg = (name: string) => { const at = process.argv.indexOf(`--${name}`); return at > 0 ? process.argv[at + 1] : undefined; };
  const fake = process.argv.includes("--fake");
  if (!fake && !process.argv.includes("--firecracker")) throw new Error("Choose --firecracker (a host built from infra/job-hosts/image) or --fake (tests)");
  const kind = arg("attestor") ?? "aws", secret = process.env.JOB_HOST_TEST_SECRET, name = arg("name") ?? hostname();
  if (kind === "test" && !secret) throw new Error("Set JOB_HOST_TEST_SECRET for the test attestor");
  const attest = kind === "test" ? async (): Promise<Attestation> => ({ kind: "test", host: name, secret: secret! }) : awsAttestor();
  const camelfsSocket = arg("camelfs-socket");
  const camelfsd = camelfsSocket ? camelfsdClient(camelfsSocket) : undefined;
  if (camelfsd && !(await camelfsd.health()).ok) throw new Error("camelFS daemon is unhealthy");
  const apiPort = arg("camelfs-api-port");
  if (apiPort !== undefined && !process.env.CAMELFS_API_TOKEN) throw new Error("Set CAMELFS_API_TOKEN for --camelfs-api-port");
  const proxy = apiPort !== undefined ? await serveImportProxy({ socketPath: camelfsSocket ?? "/run/camelfsd/api.sock", token: process.env.CAMELFS_API_TOKEN!, host: "127.0.0.1", port: Number(apiPort) }) : undefined;
  const agent = new HostAgent({
    ...(camelfsd ? { camelfsd } : {}),
    runtime: arg("runtime") ?? "http://127.0.0.1:8787", attest, slots: Number(arg("slots") ?? 4),
    ...(arg("pool") === "build" || arg("pool") === "test" ? { pool: arg("pool") as "build" | "test" } : {}),
    vcpus: Number(arg("vcpus") ?? 4), memoryMiB: Number(arg("memory") ?? 8192),
    // A real host's paths are the image's (infra/job-hosts/image/files/jobhost.env).
    launcher: fake ? fakeLauncher({ base: arg("base") }) : firecrackerLauncher({
      mountsRepo: process.argv.includes("--camelfs-repo-mount"),
      firecracker: arg("firecracker-bin") ?? "/usr/local/bin/firecracker", kernel: arg("kernel") ?? "/var/lib/camel/guest/vmlinux",
      initrd: arg("initrd") ?? "/var/lib/camel/guest/initrd.img", image: arg("image") ?? "/var/lib/camel/nvme/base.ext4",
      work: arg("work") ?? "/var/lib/camel/nvme/jobs", policyDir: arg("policies") ?? "/run/camel/egress", build: process.argv.includes("--build"),
      runtimeHost: new URL(arg("runtime") ?? "http://127.0.0.1:8787").hostname,
    }),
    diskLowBytes: Number(arg("disk-low") ?? DISK_LOW_BYTES),
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { void agent.close().then(() => proxy?.close()).then(() => process.exit(0)); });
  await agent.start();
}
