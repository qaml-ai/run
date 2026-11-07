import { workspacePath } from "../validation.ts";
import { COMPUTER_LIMITS, EGRESS_ENV, TRUST_COMMAND, type EgressGrant } from "./egress.ts";
import { boundedStart, FORK_LIMITS } from "../../../../src/core/computer-fork.ts";
import type { NativeForkAnswer, NativeForkOrigin, NativeForkedFrom } from "./native-fork.ts";

export type ComputerRequest =
  | { op: "exec"; argv: string[]; timeoutMs?: number }
  | { op: "exec"; command: string; timeoutMs?: number }
  | { op: "read"; path: string }
  | { op: "write"; path: string; content: string }
  | { op: "parse"; path: string; format: "text" | "json" | "csv" | "html" }
  | { op: "snapshot"; name: string }
  | { op: "restore"; name: string }
  | { op: "sleep" };
/**
 * How a computer starts its container: HTTPS egress per granted host (each a gateway the container's traffic to that
 * host is intercepted into), and the idle time before it stops. `key` names the grants; a running container started
 * with other grants is replaced, so a definition change takes effect on the next operation.
 */
export type ComputerNetwork = {
  key: string; egress: { grant: EgressGrant; gateway: Fetcher }[]; idleMs: number;
  /** What idling out does (a definition's `computer.idle`): "stop" (the default) loses the disk; "sleep" saves it first. */
  idle?: "stop" | "sleep";
};
export interface ComputerProvider {
  exec(
    argv: string[],
    signal: AbortSignal,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  readFile(path: string, signal: AbortSignal): Promise<string>;
  writeFile(path: string, content: string, signal: AbortSignal): Promise<void>;
  parse(
    path: string,
    format: string,
    signal: AbortSignal,
  ): Promise<{
    format: string;
    bytes: number;
    text: string;
    truncated: boolean;
  }>;
  snapshot(name: string, signal: AbortSignal): Promise<ComputerSnapshot>;
  restore(name: string, signal: AbortSignal): Promise<ComputerSnapshot>;
  startFrom(handle: ComputerSnapshot, signal: AbortSignal): Promise<ComputerSnapshot>;
  /** Save the disk as the next start's base, then stop. */
  sleep(): Promise<{ saved: boolean }>;
}
export interface SnapshotStore {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  /** The fork registry needs these (DO storage has them). */
  delete?(key: string): Promise<boolean>;
  list?<T>(options: { prefix: string }): Promise<Map<string, T>>;
}
export type ContainerApi = Pick<
  Container,
  | "running"
  | "images"
  | "start"
  | "setInactivityTimeout"
  | "exec"
  | "destroy"
  | "snapshotContainer"
  | "interceptOutboundHttps"
> & Partial<Pick<Container, "monitor">>;

export const INSTANCE_TYPES = [
  "lite",
  "standard-1",
  "standard-2",
  "standard-3",
  "standard-4",
] as const;
export type InstanceType = (typeof INSTANCE_TYPES)[number];
/**
 * What a computer starts from. Under Cloudflare's `durable_object` scheduling
 * policy this code picks it at every start: a named image from the Wrangler
 * `images` map (digest-pinned per deployment) and an instance size.
 */
export interface ComputerSpec {
  image: string;
  instance: InstanceType;
}
export const DEFAULT_SPEC: ComputerSpec = {
  image: "workspace",
  instance: "lite",
};
/** The spec a deployment's variables select; unknown values fall back to the defaults. */
export function computerSpec(env: {
  COMPUTER_IMAGE?: string;
  COMPUTER_INSTANCE?: string;
}): ComputerSpec {
  const instance = INSTANCE_TYPES.find((type) => type === env.COMPUTER_INSTANCE);
  return {
    image: env.COMPUTER_IMAGE || DEFAULT_SPEC.image,
    instance: instance ?? DEFAULT_SPEC.instance,
  };
}
/** Cloudflare keeps a snapshot for 30 days from its creation or latest restore. */
export const SNAPSHOT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * A computer's filesystem snapshot as DO storage keeps it. It is a plain value,
 * so any computer DO can start from it: the base of "fork a computer".
 */
export interface ComputerSnapshot {
  /** Cloudflare's snapshot id, all a restore needs. */
  id: string;
  name: string;
  size: number;
  /** The digest-pinned image the filesystem came from; it restores only onto that image version. */
  image: string;
  createdAt: number;
  /** When Cloudflare may have deleted it: 30 days after creation or the latest restore made here. */
  expiresAt: number;
}
export const SNAPSHOT_NAME = /^[a-zA-Z0-9_-]{1,80}$/;
/** Check a snapshot handle's shape before a computer starts from it. */
export function snapshotHandle(value: unknown): ComputerSnapshot {
  const v = value as Partial<ComputerSnapshot> | null;
  if (
    !v ||
    typeof v.id !== "string" ||
    !v.id ||
    v.id.length > 256 ||
    typeof v.name !== "string" ||
    !SNAPSHOT_NAME.test(v.name) ||
    typeof v.image !== "string" ||
    !v.image ||
    !Number.isSafeInteger(v.size) ||
    !Number.isSafeInteger(v.createdAt) ||
    !Number.isSafeInteger(v.expiresAt)
  )
    throw new Error("Invalid computer snapshot");
  return {
    id: v.id,
    name: v.name,
    size: v.size!,
    image: v.image,
    createdAt: v.createdAt!,
    expiresAt: v.expiresAt!,
  };
}
// The image the current filesystem descends from. A container started from a
// snapshot reports no image (inspect() gives ""), so the lineage is kept here.
const IMAGE_KEY = "computer:image";
/**
 * What a start without a running container boots from, when set: a fork's seed, or the snapshot this computer's last
 * sleep took. Booting from it rather than the image keeps later snapshots small: Cloudflare stores only what changed
 * since the snapshot a container was restored from. `restores` counts the starts from it.
 */
const BASE_KEY = "computer:base";
export type ComputerBase = ComputerSnapshot & { kind: "fork" | "sleep" | "restore"; restores: number };
/** A start that did not answer in time and may still be coming up: the next call waits for it instead of booting another. */
const STARTING_KEY = "computer:starting";
type StartPlan = { from: { image: string } | { containerSnapshot: { id: string } }; init: string[]; image: string; base?: ComputerBase["kind"] };
/** Where a seeded computer came from (the parent's computer, its batch, the snapshot). */
const FORKED_FROM_KEY = "computer:forked-from";
/**
 * A computer that sleeps when idle (`idle: "sleep"`): when its idle time is up, `{ at }`. The DO's alarm then saves the
 * disk as the base and stops the container (sleepIfIdle); the container's own inactivity timeout is a backstop
 * IDLE_SLEEP_BACKSTOP_MS later, for an alarm that never ran (that stop loses the disk, as idling out always did).
 */
const IDLE_KEY = "computer:idle";
export const IDLE_SLEEP_BACKSTOP_MS = 10 * 60_000;
/** The parent's registry: one entry per batch, `fork:<batch>`, with the children that adopted its snapshot. */
const FORK_PREFIX = "fork:";
export type ForkEntry = { snapshot: ComputerSnapshot; children: string[]; adopted: boolean; at: number };
/** Snapshots this computer stopped using, kept as a record for cleanup (Cloudflare has no Worker API to delete one). */
const DROPPED_PREFIX = "dropped:";
const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 300);
async function hex(value: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}
/** Container time for whoever pays for this computer (computers/meter.ts); without one nothing is metered. */
export interface ProviderMeter {
  /** Before every paid operation: throws when the payer may not use compute. */
  admit(): Promise<void>;
  /** Just before a container starts, with the idle timeout it starts with. */
  started(instance: InstanceType, idleMs: number): Promise<void>;
  /** After use; `cpuUsec` is the container's cgroup CPU counter, when it could be read. */
  used(cpuUsec?: number): Promise<void>;
  stopped(cpuUsec?: number): Promise<void>;
}
/** Where the container's own cgroup (v2) counts its CPU time. */
export const CPU_STAT = "/sys/fs/cgroup/cpu.stat";
const OUTPUT_LIMIT = 64 * 1024;
const FILE_LIMIT = 1024 * 1024;

export async function readBounded(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error("Computer output limit exceeded");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

// A container owned by its Durable Object through ctx.container, under the
// `durable_object` scheduling policy. setInactivityTimeout stops it when idle.
// Files and parsing run as node processes in the image (exec with bounded
// stdout/stdin), so the image needs nothing but Node.
export class ContainerProvider implements ComputerProvider {
  protected container: ContainerApi;
  protected store: SnapshotStore;
  protected spec: ComputerSpec;
  protected now: () => number;
  protected network: ComputerNetwork;
  protected meter?: ProviderMeter;
  /** How long one start may take before it is tried again (FORK_LIMITS.startWaitMs; tests shorten it). */
  startWaitMs: number = FORK_LIMITS.startWaitMs;
  /**
   * A boot from the image (no disk to load) gets the readiness wait it had before bounded restores: an image's first
   * start on a host pulls it (7 s on Cloudflare, longer on a local Docker), which a retry elsewhere would not shorten.
   */
  imageWaitMs = 30_000;
  private waitFor(plan: StartPlan) { return "image" in plan.from ? Math.max(this.imageWaitMs, this.startWaitMs) : this.startWaitMs; }
  /** What the operation that started the container should tell the model about its disk (restored, or not). */
  private notice?: Record<string, unknown>;
  constructor(
    container: ContainerApi,
    store: SnapshotStore,
    spec: ComputerSpec = DEFAULT_SPEC,
    now: () => number = Date.now,
    network?: ComputerNetwork,
    meter?: ProviderMeter,
    /** Asks for the DO's alarm at `at` (or earlier): a computer that sleeps when idle is put to sleep then. */
    wake?: (at: number) => Promise<void>,
  ) {
    this.container = container;
    this.store = store;
    this.spec = spec;
    this.now = now;
    this.network = network ?? { key: "", egress: [], idleMs: COMPUTER_LIMITS.idleSeconds.default * 1000 };
    this.meter = meter;
    this.wake = wake;
  }
  private wake?: (at: number) => Promise<void>;
  /** The notice of the start this operation made, once. */
  takeNotice() {
    const notice = this.notice;
    this.notice = undefined;
    return notice;
  }
  get sleepAfter() {
    return this.network.idleMs;
  }
  /** The container's own inactivity timeout: the idle time, or for one that sleeps when idle, a backstop past it. */
  private get containerTimeout() {
    return this.network.idle === "sleep" ? this.network.idleMs + IDLE_SLEEP_BACKSTOP_MS : this.network.idleMs;
  }
  /** The container was just used: a computer that sleeps when idle is due to sleep idleMs from now. */
  private async touched() {
    if (this.network.idle !== "sleep") { if (await this.store.get(IDLE_KEY)) await this.store.put(IDLE_KEY, null); return; }
    const at = this.now() + this.network.idleMs;
    await this.store.put(IDLE_KEY, { at });
    await this.wake?.(at);
  }
  /** Starts the container with the Internet on, each granted host intercepted into its gateway. */
  protected async boot(from: { image: string } | { containerSnapshot: { id: string } }) {
    const egress = this.network.egress;
    // Metered from before start(): a DO that dies in between leaves a session, not an unmetered container.
    await this.meter?.started(this.spec.instance, this.sleepAfter);
    this.container.start({
      ...from,
      instance: this.spec.instance,
      enableInternet: true,
      ...(egress.length ? { env: EGRESS_ENV } : {}),
    } as ContainerStartupOptions);
    await this.container.setInactivityTimeout(this.containerTimeout);
    for (const { grant, gateway } of egress)
      await this.container.interceptOutboundHttps(grant.host, gateway);
    await this.store.put("network", this.network.key);
  }
  /**
   * Start a container and wait until it runs `init`: start() returns before the container is up (a failure shows only
   * later) and exec waits for a starting one, so `init` is the readiness check. A container that does not come up is
   * destroyed, never left running without its idle timeout, its first command or its egress trust.
   */
  protected async bootReady(plan: StartPlan) {
    try {
      // Bounded: a start that does not answer in startWaitMs is destroyed and tried once more (a slow restore on a
      // host that must fetch the snapshot usually comes up at once elsewhere); then "still starting" (COMPUTER_STARTING).
      await boundedStart(async (signal) => {
        await this.boot(plan.from);
        await this.awaitReady(plan.init, signal);
      }, { waitMs: this.waitFor(plan), onTimeout: () => this.halt(false) });
      await this.trust();
    } catch (error) {
      if ((error as { code?: string }).code === "COMPUTER_STARTING" && this.container.running) {
        // The last try keeps starting: the next call waits for it rather than booting another.
        await this.store.put(STARTING_KEY, { ...plan, at: this.now() });
        throw error;
      }
      await this.halt(false);
      throw error;
    }
  }
  /**
   * Destroy whatever runs (no snapshot), ending its metered session; with `read`, a last CPU reading first. A start
   * that never came up is not read: its exec would only wait for it.
   */
  async halt(read = true) {
    const cpu = read ? await this.cpuUsec() : undefined;
    if (this.container.running) await this.container.destroy().catch(() => {});
    await this.meter?.stopped(cpu);
  }
  /**
   * Wait until the container runs `init` (exec waits for a starting container), or fail as soon as `monitor()` says
   * it will not run: a start past the account's limits never comes up, and only monitor() says why.
   */
  protected async awaitReady(init: string[], signal: AbortSignal) {
    const watch = this.container.monitor?.().then(
      () => { throw new Error("Computer stopped while starting"); },
      (error) => { throw new Error(`Computer could not start: ${message(error)}`); },
    );
    watch?.catch(() => {});
    const probe = (async () => {
      const ready = await this.container.exec(init, { signal, stdout: "ignore", stderr: "ignore" });
      if (await ready.exitCode) throw new Error("Computer did not start");
    })();
    await (watch ? Promise.race([probe, watch]) : probe);
  }
  /** Destroy the running container, ending its metered session with a last CPU reading. */
  protected async stop() {
    const cpu = await this.cpuUsec();
    await this.container.destroy();
    await this.meter?.stopped(cpu);
  }
  /**
   * The container's CPU time so far (cgroup v2 `usage_usec`), for metering; undefined when unmetered or unreadable,
   * which charges that time at the provisioned vCPU instead.
   */
  protected async cpuUsec(): Promise<number | undefined> {
    if (!this.meter || !this.container.running) return undefined;
    try {
      const read = await this.container.exec(["cat", CPU_STAT], { signal: AbortSignal.timeout(5_000), stdout: "pipe", stderr: "ignore" });
      const [text, code] = await Promise.all([readBounded(read.stdout, 4096), read.exitCode]);
      const usage = code ? undefined : /^usage_usec (\d+)$/m.exec(text)?.[1];
      return usage === undefined ? undefined : Number(usage);
    } catch {
      return undefined;
    }
  }
  /**
   * Each container has its own interception CA, and a snapshot carries the one its machine trusted: trust this one.
   * Unread output pipes would hold the process open (update-ca-certificates warns on stderr), so they are ignored.
   */
  protected async trust() {
    if (!this.network.egress.length) return;
    const trust = await this.container.exec(["sh", "-c", TRUST_COMMAND], { signal: AbortSignal.timeout(30_000), stdout: "ignore", stderr: "ignore" });
    if (await trust.exitCode) throw new Error("Computer could not trust the egress certificate authority");
  }
  /** This deployment's digest-pinned reference for the spec's image. */
  protected image() {
    const image = this.container.images[this.spec.image];
    if (!image) throw new Error("Computer image is not configured");
    return image;
  }
  protected async ready() {
    // Every operation is admitted, as web calls are: a session spends while it runs.
    await this.meter?.admit();
    // Grants changed since this container started: replace it, so no host stays reachable that the definition dropped.
    if (this.container.running && (await this.store.get<string>("network") ?? "") !== this.network.key)
      await this.stop();
    const starting = await this.store.get<StartPlan | null>(STARTING_KEY);
    if (starting && this.container.running) await this.awaitStarting(starting);
    else if (!this.container.running) {
      if (starting) await this.store.put(STARTING_KEY, null);
      const plan = await this.plan();
      await this.bootReady(plan);
      await this.started(plan);
    }
    await this.container.setInactivityTimeout(this.containerTimeout);
    await this.meter?.used();
    await this.touched();
  }
  /** What a start boots: this computer's base when it has a usable one, else the image. */
  private async plan(): Promise<StartPlan> {
    const image = this.image(), base = await this.store.get<ComputerBase | null>(BASE_KEY);
    if (base) {
      const why = base.expiresAt <= this.now() ? "its snapshot expired" : base.image !== image ? "it was saved on an older image version" : undefined;
      if (!why) return { from: { containerSnapshot: { id: base.id } }, init: ["true"], image: base.image, base: base.kind };
      await this.store.put(BASE_KEY, null);
      this.notice = { resumed: false, reason: `This computer's saved disk (${base.kind === "fork" ? "its fork of the parent's" : "from its last sleep"}) could not be restored because ${why}. It started empty.` };
    }
    // The readiness command also puts /workspace in the writable layer, which snapshots capture.
    return { from: { image }, init: ["mkdir", "-p", "/workspace"], image };
  }
  /** A start came up: record its lineage, refresh its base's 30-day TTL (each restore resets it) and say what it restored. */
  private async started(plan: StartPlan) {
    await this.store.put(IMAGE_KEY, plan.image);
    await this.store.put(STARTING_KEY, null);
    if (!plan.base) return;
    const base = await this.store.get<ComputerBase | null>(BASE_KEY);
    if (!base) return;
    await this.store.put(BASE_KEY, { ...base, expiresAt: this.now() + SNAPSHOT_TTL_MS, restores: base.restores + 1 });
    this.notice = {
      restoredFrom: plan.base,
      ...(base.restores > 0 ? { note: `This computer stopped and started again from its ${plan.base === "fork" ? "fork snapshot (the parent's disk at the fork)" : plan.base === "sleep" ? "last sleep's snapshot" : "last restored snapshot"}: changes made after that snapshot were lost. Use sleep to keep work across stops.` } : {}),
    };
  }
  /** Wait (bounded, once) for a start an earlier call left coming up. */
  private async awaitStarting(plan: StartPlan) {
    try {
      await boundedStart((signal) => this.awaitReady(plan.init, signal), { waitMs: this.waitFor(plan), attempts: 1 });
      await this.trust();
    } catch (error) {
      if ((error as { code?: string }).code !== "COMPUTER_STARTING") {
        await this.halt(false);
        await this.store.put(STARTING_KEY, null);
      }
      throw error;
    }
    await this.started(plan);
  }
  protected async run(
    argv: string[],
    signal: AbortSignal,
    limit = OUTPUT_LIMIT,
    stdin?: string,
  ) {
    await this.ready();
    signal.throwIfAborted();
    const process = await this.container.exec(argv, {
      cwd: "/workspace",
      // exec does not inherit start()'s env: each process gets what trusting the egress CA needs (EGRESS_ENV).
      ...(this.network.egress.length ? { env: EGRESS_ENV } : {}),
      signal,
      stdin: stdin === undefined ? undefined : "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const input = async () => {
        if (stdin === undefined) return;
        if (!process.stdin) throw new Error("Container stdin unavailable");
        const writer = process.stdin.getWriter();
        try {
          await writer.write(new TextEncoder().encode(stdin));
          await writer.close();
        } finally {
          writer.releaseLock();
        }
      };
      const [stdout, stderr, exitCode] = await Promise.all([
        readBounded(process.stdout, limit),
        readBounded(process.stderr, OUTPUT_LIMIT),
        process.exitCode,
        input(),
      ]);
      return { stdout, stderr, exitCode };
    } catch (error) {
      process.kill(9);
      throw error;
    } finally {
      // Never let metering replace the command's own outcome; the session was marked used before it ran.
      await this.cpuUsec().then((cpu) => this.meter?.used(cpu)).catch((error) =>
        console.error(JSON.stringify({ type: "computer_meter_failed", error: error instanceof Error ? error.message.slice(0, 200) : "unknown" })),
      );
      // A long command counts as use until it ends: the idle time starts over now.
      await this.touched().catch(() => {});
    }
  }
  exec(argv: string[], signal: AbortSignal) {
    return this.run(argv, signal);
  }
  async readFile(path: string, signal: AbortSignal) {
    const result = await this.run(
      [
        "node",
        "-e",
        'process.stdout.write(require("node:fs").readFileSync(process.argv[1]))',
        path,
      ],
      signal,
      FILE_LIMIT,
    );
    if (result.exitCode) throw new Error("Computer file read failed");
    return result.stdout;
  }
  async writeFile(path: string, content: string, signal: AbortSignal) {
    const result = await this.run(
      [
        "node",
        "-e",
        'const fs=require("node:fs");fs.mkdirSync(require("node:path").dirname(process.argv[1]),{recursive:true});fs.writeFileSync(process.argv[1],fs.readFileSync(0))',
        path,
      ],
      signal,
      OUTPUT_LIMIT,
      content,
    );
    if (result.exitCode) throw new Error("Computer file write failed");
  }
  async parse(path: string, format: string, signal: AbortSignal) {
    const result = await this.run(
      ["node", "/usr/local/lib/camelrun-parse.mjs", path, format],
      signal,
    );
    if (result.exitCode)
      throw new Error(
        "Document parsing failed: invalid content, unsupported format, or document exceeds 8 MiB",
      );
    return JSON.parse(result.stdout) as {
      format: string;
      bytes: number;
      text: string;
      truncated: boolean;
    };
  }
  async snapshot(name: string, signal: AbortSignal) {
    await this.ready();
    signal.throwIfAborted();
    return this.capture(name);
  }
  /** Snapshot the running container, without starting or using it (the idle sleep takes one this way). */
  private async capture(name: string) {
    const image = (await this.store.get<string>(IMAGE_KEY)) ?? this.image();
    const taken = await this.container.snapshotContainer({ name });
    const createdAt = this.now();
    const snapshot: ComputerSnapshot = {
      id: taken.id,
      name,
      size: taken.size,
      image,
      createdAt,
      expiresAt: createdAt + SNAPSHOT_TTL_MS,
    };
    await this.store.put(`snapshot:${name}`, snapshot);
    return snapshot;
  }
  /** A snapshot this computer took or started from, by name. */
  async snapshotNamed(name: string) {
    const snapshot = await this.store.get<ComputerSnapshot>(`snapshot:${name}`);
    if (!snapshot) throw new Error("Unknown computer snapshot");
    return snapshot;
  }
  async restore(name: string, signal: AbortSignal) {
    return this.startFrom(await this.snapshotNamed(name), signal);
  }
  /**
   * Replace this computer's filesystem with a snapshot's, taken here or by
   * another computer's DO, and keep the refreshed handle under its name.
   */
  async startFrom(handle: ComputerSnapshot, signal: AbortSignal) {
    const snapshot = snapshotHandle(handle);
    if (snapshot.expiresAt <= this.now())
      throw new Error("Computer snapshot expired; take a new snapshot");
    if (snapshot.image !== this.image())
      throw new Error(
        "Computer snapshot was taken from another image version; take a new snapshot",
      );
    signal.throwIfAborted();
    await this.meter?.admit();
    if (this.container.running) await this.stop();
    // A restore that does not come up throws here: no caller gets a blank computer it thinks was restored.
    const plan: StartPlan = { from: { containerSnapshot: { id: snapshot.id } }, init: ["true"], image: snapshot.image };
    await this.bootReady(plan);
    await this.started(plan);
    const restored = { ...snapshot, expiresAt: this.now() + SNAPSHOT_TTL_MS };
    await this.store.put(`snapshot:${snapshot.name}`, restored);
    // The restored disk is what a later start (after an idle stop) comes back to.
    await this.store.put(BASE_KEY, { ...restored, kind: "restore", restores: 1 } satisfies ComputerBase);
    await this.touched();
    return restored;
  }
  /**
   * Stop the container, saving its disk first as the base the next start restores (Cloudflare keeps no disk across a
   * stop). A computer that is not running has nothing to save. A failed save keeps the container running and throws,
   * unless `force` (a release at the end of a child's work), which stops it anyway.
   */
  async sleep(force = false) {
    if (!this.container.running) return { saved: false };
    return this.saveAndStop(() => this.snapshot("camelrun-sleep", AbortSignal.timeout(180_000)), force);
  }
  private async saveAndStop(save: () => Promise<ComputerSnapshot>, force: boolean) {
    let saved: ComputerSnapshot | undefined;
    try { saved = await save(); }
    catch (error) {
      if (!force) throw error;
      console.error(JSON.stringify({ type: "computer_sleep_save_failed", error: message(error) }));
    }
    if (saved) await this.store.put(BASE_KEY, { ...saved, kind: "sleep", restores: 0 } satisfies ComputerBase);
    await this.store.put(IDLE_KEY, null);
    await this.stop();
    return { saved: !!saved };
  }
  /**
   * The DO's alarm, for a computer that sleeps when idle: once its idle time is up, save its disk as the base (the next
   * start, or a fork, resumes it) and stop. Answers when to look again: when it is due, or undefined (nothing to do).
   */
  async sleepIfIdle(): Promise<number | undefined> {
    const due = await this.store.get<{ at: number } | null>(IDLE_KEY);
    if (!due) return undefined;
    if (!this.container.running) { await this.store.put(IDLE_KEY, null); return undefined; }
    // A start still coming up is not saved half-loaded; look again later.
    if (await this.store.get<StartPlan | null>(STARTING_KEY)) return this.now() + this.network.idleMs;
    if (this.now() < due.at) return due.at;
    // Forced: a save that fails still stops it (the backstop would anyway, without saving), and is logged.
    await this.saveAndStop(() => this.capture("camelrun-sleep"), true);
    return undefined;
  }

  // Forking (native-fork.ts): the parent's side.
  /**
   * The snapshot a batch's children start from: the one this batch already took, else a snapshot of the running
   * container, else this computer's base (a stopped computer's saved disk), else NO_SESSION.
   */
  async forkSnapshot(batch: string, signal: AbortSignal): Promise<NativeForkAnswer> {
    const key = `${FORK_PREFIX}${batch}`, existing = await this.store.get<ForkEntry | null>(key);
    if (existing) return { ok: true, snapshot: existing.snapshot };
    // A start or restore still coming up: its disk is not all there yet. A marker whose container is gone is stale.
    if (await this.store.get<StartPlan | null>(STARTING_KEY)) {
      if (this.container.running) return { ok: false, code: "COMPUTER_STARTING", message: "This agent's computer is still starting; fork again in a few seconds." };
      await this.store.put(STARTING_KEY, null);
    }
    await this.dropStale();
    let snapshot: ComputerSnapshot | undefined;
    if (this.container.running) snapshot = await this.snapshot(`fork-${await hex(batch)}`, signal);
    else {
      const base = await this.store.get<ComputerBase | null>(BASE_KEY);
      if (base && base.expiresAt > this.now() && base.image === this.image()) {
        const { kind: _kind, restores: _restores, ...handle } = base;
        snapshot = handle;
      }
    }
    if (!snapshot) return { ok: false, code: "NO_SESSION", message: "This agent's computer has no running session or saved disk to fork: use it first (any computer operation), or use computer: \"fresh\"." };
    await this.store.put<ForkEntry>(key, { snapshot, children: [], adopted: false, at: this.now() });
    return { ok: true, snapshot };
  }
  /** A child started from the batch's snapshot. */
  async adopt(batch: string, child: string) {
    const key = `${FORK_PREFIX}${batch}`, entry = await this.store.get<ForkEntry | null>(key);
    if (!entry) return;
    await this.store.put<ForkEntry>(key, { ...entry, adopted: true, children: [...new Set([...entry.children, child])] });
  }
  /** A child is gone; the last one takes the batch's snapshot with it. */
  async unref(batch: string, child: string) {
    const key = `${FORK_PREFIX}${batch}`, entry = await this.store.get<ForkEntry | null>(key);
    if (!entry) return;
    const children = entry.children.filter((each) => each !== child);
    // Within the grace a sibling of the same call may still be seeding from it: dropStale drops it later.
    if (entry.adopted && !children.length && entry.at + FORK_LIMITS.dropGraceMs <= this.now()) await this.drop(batch, entry);
    else await this.store.put<ForkEntry>(key, { ...entry, children });
  }
  /** Batches whose snapshot no child adopted within the grace (a child that was never made). */
  async dropStale() {
    if (!this.store.list) return;
    for (const [key, entry] of await this.store.list<ForkEntry | null>({ prefix: FORK_PREFIX }))
      if (entry && !entry.children.length && entry.at + FORK_LIMITS.dropGraceMs <= this.now()) await this.drop(key.slice(FORK_PREFIX.length), entry);
  }
  /**
   * Forget a batch's snapshot. Cloudflare has no Worker API to delete a snapshot (it expires 30 days after its last
   * restore), so one nothing here uses any more is logged and recorded under `dropped:`, for its registry tag
   * (`rootfs-snapshot-*`) to be deleted by hand. A snapshot that is still this computer's base, or another batch's,
   * stays. Snapshots restored from this one (a child's own) may depend on it: delete tags only of whole trees.
   */
  private async drop(batch: string, entry: ForkEntry) {
    if (this.store.delete) await this.store.delete(`${FORK_PREFIX}${batch}`);
    else await this.store.put(`${FORK_PREFIX}${batch}`, null);
    const id = entry.snapshot.id, base = await this.store.get<ComputerBase | null>(BASE_KEY);
    if (base?.id === id) return;
    if (this.store.list) for (const other of (await this.store.list<ForkEntry | null>({ prefix: FORK_PREFIX })).values()) if (other?.snapshot.id === id) return;
    if (entry.snapshot.name.startsWith("fork-")) await this.store.delete?.(`snapshot:${entry.snapshot.name}`);
    console.error(JSON.stringify({ type: "computer_snapshot_unused", id, name: entry.snapshot.name, size: entry.snapshot.size }));
    await this.store.put(`${DROPPED_PREFIX}${id}`, { id, name: entry.snapshot.name, size: entry.snapshot.size, createdAt: entry.snapshot.createdAt, droppedAt: this.now() });
  }

  // Forking: the child's side.
  /** Make `snapshot` this computer's base: its next start restores the parent's disk. A running container is replaced. */
  async seed(handle: ComputerSnapshot, origin: NativeForkOrigin) {
    const snapshot = snapshotHandle(handle);
    if (snapshot.expiresAt <= this.now()) throw new Error("The fork's snapshot expired; fork again");
    if (snapshot.image !== this.image()) throw new Error("The fork's snapshot was taken on another image version; fork again");
    if (this.container.running) await this.stop();
    await this.store.put(STARTING_KEY, null);
    await this.store.put(BASE_KEY, { ...snapshot, kind: "fork", restores: 0 } satisfies ComputerBase);
    await this.store.put<NativeForkedFrom>(FORKED_FROM_KEY, { ...origin, snapshot: snapshot.id });
  }
  /** Whether this computer has a disk of its own: running, or saved as its base. A fork route never overwrites one. */
  async hasDisk() {
    return this.container.running || !!(await this.store.get<ComputerBase | null>(BASE_KEY));
  }
  async forkedFrom() {
    return (await this.store.get<NativeForkedFrom | null>(FORKED_FROM_KEY)) ?? null;
  }
}

export async function operate(
  provider: ComputerProvider & { takeNotice?(): Record<string, unknown> | undefined },
  request: ComputerRequest,
  signal: AbortSignal = AbortSignal.timeout(30_000),
) {
  const result = await operation(provider, request, signal);
  // A start this operation made says what disk it came up with (restored from a fork or a sleep, or not).
  const notice = provider.takeNotice?.();
  return notice && result && typeof result === "object" ? { ...result, computer: notice } : result;
}

async function operation(
  provider: ComputerProvider,
  request: ComputerRequest,
  signal: AbortSignal,
) {
  switch (request.op) {
    case "exec": {
      // A shell command is what models write; an argv list given as one JSON string ran as a single word (exit 127).
      if ("command" in request) {
        if (typeof request.command !== "string" || !request.command || request.command.includes("\0") || new TextEncoder().encode(request.command).length > 16384)
          throw new Error("Invalid command");
        if ("argv" in request) throw new Error("Give command or argv, not both");
        return provider.exec(["bash", "-lc", request.command], signal);
      }
      if (
        !Array.isArray(request.argv) ||
        request.argv.length < 1 ||
        request.argv.length > 100 ||
        request.argv.some(
          (arg) =>
            typeof arg !== "string" ||
            arg.includes("\0") ||
            new TextEncoder().encode(arg).length > 16384,
        )
      )
        throw new Error("Invalid argv");
      return provider.exec(request.argv, signal);
    }
    case "read":
      return {
        content: await provider.readFile(workspacePath(request.path), signal),
      };
    case "write":
      if (
        typeof request.content !== "string" ||
        new TextEncoder().encode(request.content).length > FILE_LIMIT
      )
        throw new Error("Computer file exceeds 1 MiB");
      await provider.writeFile(
        workspacePath(request.path),
        request.content,
        signal,
      );
      return { written: true };
    case "parse":
      if (!["text", "json", "csv", "html"].includes(request.format))
        throw new Error("Unsupported document format");
      return provider.parse(
        workspacePath(request.path),
        request.format,
        signal,
      );
    case "snapshot":
    case "restore":
      if (!SNAPSHOT_NAME.test(request.name))
        throw new Error("Invalid snapshot name");
      await provider[request.op](request.name, signal);
      return { [request.op]: request.name };
    case "sleep":
      return { sleeping: true, ...(await provider.sleep()) };
    default:
      throw new Error("Unsupported computer operation");
  }
}
