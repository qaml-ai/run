import { workspacePath } from "../validation.ts";
import { CONTAINER_CA, COMPUTER_LIMITS, TRUST_COMMAND, type EgressGrant } from "./egress.ts";

export type ComputerRequest =
  | { op: "exec"; argv: string[]; timeoutMs?: number }
  | { op: "exec"; command: string; timeoutMs?: number }
  | { op: "read"; path: string }
  | { op: "write"; path: string; content: string }
  | { op: "parse"; path: string; format: "text" | "json" | "csv" | "html" }
  | { op: "snapshot"; name: string }
  | { op: "restore"; name: string; from?: "parent" }
  | { op: "sleep" };
/**
 * How a computer starts its container: HTTPS egress per granted host (each a gateway the container's traffic to that
 * host is intercepted into), and the idle time before it stops. `key` names the grants; a running container started
 * with other grants is replaced, so a definition change takes effect on the next operation.
 */
export type ComputerNetwork = { key: string; egress: { grant: EgressGrant; gateway: Fetcher }[]; idleMs: number };
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
  sleep(): Promise<void>;
}
export interface SnapshotStore {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
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
>;

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
  constructor(
    container: ContainerApi,
    store: SnapshotStore,
    spec: ComputerSpec = DEFAULT_SPEC,
    now: () => number = Date.now,
    network?: ComputerNetwork,
    meter?: ProviderMeter,
  ) {
    this.container = container;
    this.store = store;
    this.spec = spec;
    this.now = now;
    this.network = network ?? { key: "", egress: [], idleMs: COMPUTER_LIMITS.idleSeconds.default * 1000 };
    this.meter = meter;
  }
  get sleepAfter() {
    return this.network.idleMs;
  }
  /** Starts the container with the Internet off, each granted host intercepted into its gateway. */
  protected async boot(from: { image: string } | { containerSnapshot: { id: string } }) {
    const egress = this.network.egress;
    // Metered from before start(): a DO that dies in between leaves a session, not an unmetered container.
    await this.meter?.started(this.spec.instance, this.sleepAfter);
    this.container.start({
      ...from,
      instance: this.spec.instance,
      enableInternet: false,
      ...(egress.length ? { env: { NODE_EXTRA_CA_CERTS: CONTAINER_CA, GIT_TERMINAL_PROMPT: "0" } } : {}),
    } as ContainerStartupOptions);
    await this.container.setInactivityTimeout(this.sleepAfter);
    for (const { grant, gateway } of egress)
      await this.container.interceptOutboundHttps(grant.host, gateway);
    await this.store.put("network", this.network.key);
  }
  /**
   * Start a container and wait until it runs `init`: start() returns before the container is up (a failure shows only
   * later) and exec waits for a starting one, so `init` is the readiness check. A container that does not come up is
   * destroyed, never left running without its idle timeout, its first command or its egress trust.
   */
  protected async bootReady(from: { image: string } | { containerSnapshot: { id: string } }, init: string[]) {
    try {
      await this.boot(from);
      const ready = await this.container.exec(init, { signal: AbortSignal.timeout(30_000), stdout: "ignore", stderr: "ignore" });
      if (await ready.exitCode) throw new Error("Computer did not start");
      await this.trust();
    } catch (error) {
      if (this.container.running) await this.container.destroy().catch(() => {});
      await this.meter?.stopped();
      throw error;
    }
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
    if (!this.container.running) {
      const image = this.image();
      // The readiness command also puts /workspace in the writable layer, which snapshots capture.
      await this.bootReady({ image }, ["mkdir", "-p", "/workspace"]);
      await this.store.put(IMAGE_KEY, image);
    }
    await this.container.setInactivityTimeout(this.sleepAfter);
    await this.meter?.used();
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
    await this.bootReady({ containerSnapshot: { id: snapshot.id } }, ["true"]);
    await this.store.put(IMAGE_KEY, snapshot.image);
    const restored = { ...snapshot, expiresAt: this.now() + SNAPSHOT_TTL_MS };
    await this.store.put(`snapshot:${snapshot.name}`, restored);
    return restored;
  }
  async sleep() {
    await this.stop();
  }
}

export async function operate(
  provider: ComputerProvider,
  request: ComputerRequest,
  signal: AbortSignal = AbortSignal.timeout(30_000),
  parent?: ComputerSnapshot,
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
      if (request.op === "restore" && (request.from === "parent") !== !!parent)
        throw new Error("A restore from the parent needs the parent's snapshot");
      // A disk fork's stand-in: a sub-agent's own machine starts from its parent's snapshot, found by the runtime.
      if (parent) await provider.startFrom(parent, signal);
      else await provider[request.op](request.name, signal);
      return { [request.op]: request.name, ...(parent ? { from: "parent" } : {}) };
    case "sleep":
      await provider.sleep();
      return { sleeping: true };
    default:
      throw new Error("Unsupported computer operation");
  }
}
