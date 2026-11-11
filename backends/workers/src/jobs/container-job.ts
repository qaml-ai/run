import { boundedStart, FORK_LIMITS } from "../../../../src/core/computer-fork.ts";
import { CPU_STAT, SNAPSHOT_TTL_MS, type ComputerSnapshot, type ContainerApi, type InstanceType } from "../computers/provider.ts";
import { camelSync, SyncError, type SyncFile } from "./camel-sync.ts";
import { JOB_LIMITS, JOB_OUT, JOB_REPO, JOB_SYNC_MS, jobLifetimeMs, type JobFailureCode, type JobOutput, type JobResult, type JobSpec, type JobStream, type JobTimings } from "./job.ts";

/** Container time for whoever pays for a job (computers/meter.ts), and its computer slot. Absent: unmetered. */
export interface JobMeter {
  /** Before the container starts: throws when the payer may not start compute or its tree is at its computer limit. */
  admit(instance: InstanceType, until: number): Promise<void>;
  /** Just before the container starts. */
  started(instance: InstanceType, idleMs: number): Promise<void>;
  used(cpuUsec?: number): Promise<void>;
  /** The container is gone: settle the session and give back the slot. */
  stopped(cpuUsec?: number): Promise<void>;
}
export type ContainerJobOptions = {
  container: ContainerApi;
  meter?: JobMeter;
  /** The files to sync into /repo, already resolved (inline, or a volume snapshot's reader). */
  files?: AsyncIterable<SyncFile>;
  /** Aborted by stop(). */
  stop?: AbortSignal;
  now?: () => number;
  /** How long a start may take before it is tried once more (a boot from the image gets at least imageWaitMs). */
  startWaitMs?: number;
  imageWaitMs?: number;
  /** Deadlines for the steps around the command. */
  syncMs?: number;
  collectMs?: number;
};
type Spec = JobSpec & { image: string; outputs: string[]; instance: InstanceType };

const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 500);
class JobFailure extends Error {
  readonly code: JobFailureCode;
  readonly freeBytes?: number;
  constructor(code: JobFailureCode, text: string, freeBytes?: number) {
    super(text);
    this.code = code;
    this.freeBytes = freeBytes;
  }
}

/**
 * Read a stream, keeping at most `max` bytes. `drain` reads the rest to the end (counting it), so the process is never
 * blocked on a full pipe; otherwise reading stops past `max`.
 */
export async function readCapped(stream: ReadableStream<Uint8Array> | null, max: number, drain = true): Promise<JobStream> {
  if (!stream) return { bytes: new Uint8Array(), size: 0, truncated: false };
  const reader = stream.getReader(), chunks: Uint8Array[] = [];
  let kept = 0, size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (kept < max) {
        const part = value.subarray(0, max - kept);
        chunks.push(part);
        kept += part.byteLength;
      }
      if (size > max && !drain) { await reader.cancel().catch(() => {}); break; }
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(kept);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return { bytes, size, truncated: size > max };
}

async function execText(container: ContainerApi, argv: string[], signal: AbortSignal) {
  const process = await container.exec(argv, { signal, stdout: "pipe", stderr: "ignore" });
  const [out, code] = await Promise.all([readCapped(process.stdout, 64 * 1024), process.exitCode]);
  return { text: new TextDecoder().decode(out.bytes), code };
}

/** Free bytes on the container's root filesystem (`df -Pk /`), or undefined when df cannot say. */
export async function freeBytes(container: ContainerApi, signal: AbortSignal) {
  const { text, code } = await execText(container, ["df", "-Pk", JOB_REPO], signal);
  const available = code ? undefined : text.trim().split("\n").at(-1)?.trim().split(/\s+/)[3];
  return available && /^\d+$/.test(available) ? Number(available) * 1024 : undefined;
}

/**
 * Run one job in `container`, start to stop: admit and meter the payer, start from the image or snapshot, check the
 * disk watermark, apply the pids limit, sync the files into /repo, run the command under its timeout, collect its
 * outputs from /out, save a snapshot when asked and the command exited 0, and destroy the container whatever happened.
 */
export async function runContainerJob(spec: Spec, options: ContainerJobOptions): Promise<JobResult> {
  const { container, meter } = options, now = options.now ?? Date.now;
  const startedAt = now();
  const timings: JobTimings = { startedAt, endedAt: startedAt, startMs: 0, syncMs: 0, commandMs: 0, collectMs: 0, totalMs: 0 };
  const timeoutMs = spec.timeoutSeconds * 1000;
  const lifetimeMs = jobLifetimeMs(spec.timeoutSeconds);
  const stop = options.stop ?? new AbortController().signal;
  const step = (ms: number) => AbortSignal.any([AbortSignal.timeout(ms), stop]);
  const done = (result: JobResult): JobResult => {
    timings.endedAt = now();
    timings.totalMs = timings.endedAt - startedAt;
    return result;
  };
  const fail = (failure: JobFailure) => done({
    ok: false, id: spec.id, code: stop.aborted ? "stopped" : failure.code, message: stop.aborted ? "The job was stopped" : failure.message,
    timings, ...failure.freeBytes !== undefined ? { freeBytes: failure.freeBytes } : {},
  });

  try { await meter?.admit(spec.instance, startedAt + lifetimeMs); }
  catch (error) { return fail(new JobFailure("admission_refused", message(error))); }

  let began = false;
  try {
    // Start.
    const image = container.images[spec.image];
    if (!image) throw new JobFailure("start_failed", `Job image ${spec.image} is not configured`);
    if (spec.snapshot) {
      if (spec.snapshot.expiresAt <= now()) throw new JobFailure("start_failed", `Snapshot ${spec.snapshot.name} expired; take a new one`);
      if (spec.snapshot.image !== image) throw new JobFailure("start_failed", `Snapshot ${spec.snapshot.name} was taken on another image version; take a new one`);
    }
    const from = spec.snapshot ? { containerSnapshot: { id: spec.snapshot.id } } : { image };
    if (container.running) await container.destroy().catch(() => {});
    const waitMs = spec.snapshot ? (options.startWaitMs ?? FORK_LIMITS.startWaitMs) : Math.max(options.imageWaitMs ?? 30_000, options.startWaitMs ?? FORK_LIMITS.startWaitMs);
    try {
      await boundedStart(async (signal) => {
        began = true;
        await meter?.started(spec.instance, lifetimeMs);
        container.start({ ...from, instance: spec.instance, enableInternet: !!spec.internet } as ContainerStartupOptions);
        // The backstop: the container stops itself after the job's whole lifetime, should every other stop be lost.
        await container.setInactivityTimeout(lifetimeMs);
        const watch = container.monitor?.().then(
          () => { throw new Error("Job container stopped while starting"); },
          (error) => { throw new Error(`Job container could not start: ${message(error)}`); },
        );
        watch?.catch(() => {});
        const probe = (async () => {
          const ready = await container.exec(["mkdir", "-p", JOB_REPO, JOB_OUT], { signal: AbortSignal.any([signal, stop]), stdout: "ignore", stderr: "ignore" });
          if (await ready.exitCode) throw new Error("Job container did not start");
        })();
        await (watch ? Promise.race([probe, watch]) : probe);
      }, { waitMs, onTimeout: async () => { if (container.running) await container.destroy().catch(() => {}); } });
    } catch (error) {
      throw new JobFailure("start_failed", message(error));
    }
    timings.startMs = now() - startedAt;

    // The disk watermark, before anything is written: a snapshot that leaves less than 2 GiB free is too full.
    const free = await freeBytes(container, step(30_000)).catch(() => undefined);
    if (free !== undefined && free < JOB_LIMITS.diskLowBytes)
      throw new JobFailure("disk_low", `${spec.snapshot ? `Snapshot ${spec.snapshot.name}` : `Image ${spec.image}`} leaves ${(free / 2 ** 30).toFixed(2)} GiB free on a ${spec.instance} instance, under the 2 GiB a job needs: make the snapshot smaller or ask for more diskMiB`, free);

    // pids: the container's own cgroup, when the container may set it.
    let pids: "cgroup" | "unenforced" | undefined;
    if (spec.limits?.pids) {
      const set = await execText(container, ["sh", "-c", `echo ${spec.limits.pids} > /sys/fs/cgroup/pids.max`], step(30_000)).catch(() => ({ code: 1 }));
      pids = set.code ? "unenforced" : "cgroup";
    }

    // Sync.
    const syncStart = now();
    if (options.files) {
      try { await camelSync(container, options.files, step(options.syncMs ?? JOB_SYNC_MS)); }
      catch (error) { throw new JobFailure("sync_failed", error instanceof SyncError ? error.message : `Sync failed: ${message(error)}`); }
    }
    timings.syncMs = now() - syncStart;

    // The command.
    const commandStart = now(), deadline = AbortSignal.timeout(timeoutMs), signal = AbortSignal.any([deadline, stop]);
    let exitCode: number | null = null, stdout: JobStream | undefined, stderr: JobStream | undefined;
    try {
      const process = await container.exec(["bash", "-lc", spec.command], {
        cwd: JOB_REPO, env: { JOB_ID: spec.id, JOB_OUT }, signal, stdout: "pipe", stderr: "pipe",
      });
      const kill = () => { try { process.kill(9); } catch { /* already gone */ } };
      signal.addEventListener("abort", kill, { once: true });
      try {
        [stdout, stderr, exitCode] = await Promise.all([
          readCapped(process.stdout, JOB_LIMITS.streamBytes),
          readCapped(process.stderr, JOB_LIMITS.streamBytes),
          process.exitCode,
        ]);
      } finally { signal.removeEventListener("abort", kill); }
    } catch (error) {
      if (!signal.aborted) throw new JobFailure("container_failed", `The job's container failed while the command ran: ${message(error)}`);
    }
    const empty = (): JobStream => ({ bytes: new Uint8Array(), size: 0, truncated: false });
    if (stop.aborted) throw new JobFailure("stopped", "The job was stopped");
    const timedOut = deadline.aborted;
    if (timedOut) exitCode = null;
    timings.commandMs = now() - commandStart;

    // Outputs: each from /out, within one total.
    const collectStart = now(), outputs: Record<string, JobOutput> = {}, missing: string[] = [];
    const collect = step(options.collectMs ?? 60_000);
    let budget = JOB_LIMITS.outputTotalBytes;
    for (const name of spec.outputs) {
      try {
        const max = Math.min(JOB_LIMITS.outputBytes, budget);
        const process = await container.exec(["cat", "--", `${JOB_OUT}/${name}`], { signal: collect, stdout: "pipe", stderr: "ignore" });
        const read = await readCapped(process.stdout, max, false);
        if (read.truncated) try { process.kill(9); } catch { /* gone */ }
        const code = await process.exitCode;
        if (code && !read.truncated) { missing.push(name); continue; }
        outputs[name] = read;
        budget -= read.bytes.byteLength;
      } catch {
        missing.push(name);
      }
    }
    timings.collectMs = now() - collectStart;

    // A failed save keeps the job's result: the next job starts from the older snapshot.
    let snapshot: ComputerSnapshot | undefined, snapshotError: string | undefined;
    if (spec.saveSnapshot && exitCode === 0) {
      try {
        const taken = await container.snapshotContainer({ name: spec.saveSnapshot });
        const createdAt = now();
        snapshot = { id: taken.id, name: spec.saveSnapshot, size: taken.size, image, createdAt, expiresAt: createdAt + SNAPSHOT_TTL_MS };
      } catch (error) { snapshotError = message(error); }
    }
    return done({
      ok: true, id: spec.id, instance: spec.instance, exitCode, timedOut, stdout: stdout ?? empty(), stderr: stderr ?? empty(), outputs, missing,
      ...pids ? { pids } : {}, ...snapshot ? { snapshot } : {}, ...snapshotError ? { snapshotError } : {}, timings,
    });
  } catch (error) {
    if (error instanceof JobFailure) return fail(error);
    return fail(new JobFailure("start_failed", message(error)));
  } finally {
    // Stop: nothing is kept but the snapshot. The meter gets a last CPU reading first.
    let cpu: number | undefined;
    if (meter && began && container.running) {
      try {
        const read = await execText(container, ["cat", CPU_STAT], AbortSignal.timeout(5_000));
        const usage = read.code ? undefined : /^usage_usec (\d+)$/m.exec(read.text)?.[1];
        cpu = usage === undefined ? undefined : Number(usage);
      } catch { cpu = undefined; }
    }
    if (container.running) await container.destroy().catch((error: unknown) =>
      console.error(JSON.stringify({ type: "job_destroy_failed", job: spec.id, error: message(error) })));
    if (meter) await meter.stopped(cpu).catch((error: unknown) =>
      console.error(JSON.stringify({ type: "job_meter_failed", job: spec.id, error: message(error) })));
  }
}
