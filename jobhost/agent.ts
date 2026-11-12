// The job host agent (docs/design/job-hosts-plan.md, slices 3 and 4). It enrolls (an attestation of who it is, for a
// short-lived credential bound to that host id), dials out to the runtime over one WebSocket (no inbound ports) with
// the credential as its first message, enrolls again before the credential ends, says how many jobs it takes, and runs the jobs the runtime sends: a VM per job from
// a copy-on-write clone (vm.ts), the job's files synced in, its command run under its limits by the guest agent
// (guest.ts), its outputs collected and sent back, the VM destroyed. A job the runtime cancels is destroyed at once.
// While the socket is down, jobs keep running and their results wait to be sent when it is back.
//
//   node --experimental-strip-types jobhost/agent.ts --runtime https://run.example --attestor aws --slots 8 --fake
//   node … --attestor test --name host-1 --fake      (JOB_HOST_TEST_SECRET from the environment: tests only)
import { hostname } from "node:os";
import { frames, Frames, type HostMessage, type RuntimeMessage, type WireJob, type WireResult } from "../shared/job-host-protocol.ts";
import { signGetCallerIdentity, type Attestation } from "../shared/job-host-attest.ts";
import { fakeLauncher, type Vm, type VmLauncher } from "./vm.ts";

export const AGENT_VERSION = "0.1.0";
/** Less free disk than this before the command fails the job `disk_low`, as a container job does. */
const DISK_LOW_BYTES = 2 * 1024 * 1024 * 1024;

export type AgentOptions = {
  /** Proves who this host is, for each enrollment: AWS (awsAttestor) on a real host, a test secret in tests. */
  runtime: string; attest: (audience: string) => Promise<Attestation>; slots: number; vcpus: number; memoryMiB: number;
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
        this.send({ type: "hello", host: enrolled.host, slots: this.options.slots, free: this.options.slots - this.running.size, vcpus: this.options.vcpus, memoryMiB: this.options.memoryMiB, version: AGENT_VERSION });
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
      // Results wait for the next connection; heartbeats and hellos are made again then.
      if (message.type === "result") this.outbox.push(message);
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
    try {
      const shape = { vcpus: Math.max(1, Math.ceil(spec.limits.cpus ?? 1)), memoryMiB: spec.limits.memoryMiB ?? 2048, diskMiB: spec.limits.diskMiB ?? 8192 };
      const vm = job.vm = await this.options.launcher.boot(id, shape);
      if (job.cancelled) throw new Stopped();
      this.send({ type: "started", id, at: Date.now() });
      const startMs = Date.now() - began;
      const synced = await vm.request({ op: "files", files: spec.files });
      if (!synced.ok) { result = { ok: false, code: "sync_failed", message: String(synced.error ?? "sync failed") }; return; }
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
      };
    } catch (error) {
      result = job.cancelled || error instanceof Stopped ? { ok: false, code: "stopped", message: "The job was stopped" }
        : { ok: false, code: job.vm ? "container_failed" : "start_failed", message: error instanceof Error ? error.message.slice(0, 300) : "The VM failed" };
    } finally {
      await job.vm?.destroy().catch(() => {});
      this.running.delete(id);
      this.send({ type: "result", id, result: result! ?? { ok: false, code: "container_failed", message: "No result" } });
    }
  }
}
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
  if (!process.argv.includes("--fake")) throw new Error("Only --fake runs today: Firecracker needs the host image (docs/design/job-hosts-plan.md, slice 1)");
  const kind = arg("attestor") ?? "aws", secret = process.env.JOB_HOST_TEST_SECRET, name = arg("name") ?? hostname();
  if (kind === "test" && !secret) throw new Error("Set JOB_HOST_TEST_SECRET for the test attestor");
  const attest = kind === "test" ? async (): Promise<Attestation> => ({ kind: "test", host: name, secret: secret! }) : awsAttestor();
  const agent = new HostAgent({
    runtime: arg("runtime") ?? "http://127.0.0.1:8787", attest, slots: Number(arg("slots") ?? 4),
    vcpus: Number(arg("vcpus") ?? 4), memoryMiB: Number(arg("memory") ?? 8192), launcher: fakeLauncher({ base: arg("base") }),
    diskLowBytes: Number(arg("disk-low") ?? DISK_LOW_BYTES),
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { void agent.close().then(() => process.exit(0)); });
  await agent.start();
}
