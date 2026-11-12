import { INSTANCE_TYPES, SNAPSHOT_NAME, snapshotHandle, type ComputerSnapshot, type InstanceType } from "../computers/provider.ts";
import { INSTANCE_RESOURCES, type ComputerPayer } from "../computers/meter.ts";

/**
 * A job: one command in a container of its own, for exactly as long as it runs (docs/design/swarm-workflows.md, "Jobs:
 * the ephemeral compute boundary"). It starts from an image or a container snapshot, gets its files synced into
 * /repo, runs the command there under the container's limits, and hands back the named files it left in /out, its
 * exit code and its timings. Then the container is destroyed.
 *
 * Internal in phase 1: the workflow's `job()` is its only caller. There is no /v1/jobs route and no `jobs` builtin.
 */
export const JOB_LIMITS = Object.freeze({
  timeoutSeconds: { min: 1, max: 3600 },
  /** stdout and stderr are each kept up to this many bytes; the rest is counted and dropped. */
  streamBytes: 8 * 1024 * 1024,
  /** Named outputs: how many, each one's bytes, and all of them together (a result crosses DO RPC, capped at 32 MiB). */
  outputs: 32,
  outputBytes: 8 * 1024 * 1024,
  outputTotalBytes: 8 * 1024 * 1024,
  /** Files given inline cross RPC too; a larger tree comes from a volume snapshot. */
  inlineFiles: 10_000,
  inlineBytes: 8 * 1024 * 1024,
  /** A volume snapshot synced into the job. Each file is read whole to check its digest. */
  syncFiles: 100_000,
  syncFileBytes: 64 * 1024 * 1024,
  syncBytes: 4 * 1024 * 1024 * 1024,
  /** The disk watermark: a container with less free disk than this when the command would start fails `disk_low`. */
  diskLowBytes: 2 * 1024 * 1024 * 1024,
  pids: { min: 16, max: 65_536 },
  /** After the deadline, time to collect outputs and stop before the slot and the backstop alarm expire. */
  graceMs: 120_000,
});
/** How long a sync may take, and a job's whole lifetime: its slot, the container's own stop and the backstop alarm. */
export const JOB_SYNC_MS = 600_000;
export const jobLifetimeMs = (timeoutSeconds: number) => timeoutSeconds * 1000 + JOB_SYNC_MS + JOB_LIMITS.graceMs;
/** Where a job's files go, where its command runs, and where it leaves its outputs. */
export const JOB_REPO = "/repo";
export const JOB_OUT = "/out";
/**
 * The instance types a job may get. `lite` has 2 GB of disk, under the disk watermark, so no job gets it.
 */
export const JOB_INSTANCES: readonly InstanceType[] = INSTANCE_TYPES.filter(type => type !== "lite");

export type JobLimits = { cpus?: number; memoryMiB?: number; diskMiB?: number; pids?: number };
/** What a job's files come from: given inline (path to bytes), or a volume snapshot (its whole tree). */
export type JobFiles = Record<string, Uint8Array>;
export type JobVolumeSource = { tenant: string; volume: string; snapshot: string };
export type JobSpec = {
  /** The job's id: unique per job. It names the job's container object (`job:<id>`) and its computer slot. */
  id: string;
  /** A named image from the deployment's `images` map (default "workspace"), or a snapshot taken on that image. */
  image?: string;
  snapshot?: ComputerSnapshot;
  files?: JobFiles;
  volume?: JobVolumeSource;
  /** A shell command (`bash -lc`), run in /repo. */
  command: string;
  timeoutSeconds: number;
  /** Paths under /out to hand back. One that is not there is listed as missing. */
  outputs?: string[];
  limits?: JobLimits;
  /** The Internet from inside the job; off unless asked for. */
  internet?: boolean;
  /** Save the container's disk under this name when the command exits 0, for the next job to start from. */
  saveSnapshot?: string;
  /** Who pays for the container time and whose computer limit the job counts against. Every job has one. */
  payer: ComputerPayer;
  /**
   * Environment variables only the command sees (a push's token): set on its process, never on the image or a snapshot,
   * and never part of the result. A command that prints one prints it; callers redact their own (workflow-jobs.ts).
   */
  secretEnv?: Record<string, string>;
};
export type JobStream = { bytes: Uint8Array; size: number; truncated: boolean };
export type JobOutput = { bytes: Uint8Array; size: number; truncated: boolean };
export type JobTimings = { startedAt: number; endedAt: number; startMs: number; syncMs: number; commandMs: number; collectMs: number; totalMs: number };
export type JobFailureCode =
  /** The payer may not start compute (credit, spend limit) or its tree is at its computer limit. */
  | "admission_refused"
  /** A job with this id is running now. */
  | "job_running"
  | "start_failed"
  /** The container had less than JOB_LIMITS.diskLowBytes free before the command: the snapshot is too full. */
  | "disk_low"
  | "sync_failed"
  /** The container died while the command ran (the instance ran out of memory, or the host failed). */
  | "container_failed"
  /** stop() ended it. */
  | "stopped";
export type JobResult =
  | {
      ok: true; id: string; instance: InstanceType;
      /** null when the command was killed at its timeout. */
      exitCode: number | null; timedOut: boolean;
      stdout: JobStream; stderr: JobStream;
      outputs: Record<string, JobOutput>; missing: string[];
      /** Whether `limits.pids` was applied through the container's cgroup (pids.max). */
      /** How `limits.pids` was applied: the container's cgroup (pids.max), the job VM guest's ulimit, or not at all. */
      pids?: "cgroup" | "ulimit" | "unenforced";
      camelfs?: { tree?: string; root?: string; warm: boolean; mountMs: number; applyMs: number; checkpointMs?: number; checkpointError?: string;
        checkpoint?: { walkMs: number; streamMs: number; freezeMs: number; files: number; bytes: number; skipped: number;
          changedChunks: number; uploadedChunks: number; changedBytes: number; reflinkMs: number; fiemapMs: number; hashMs: number; uploadMs: number } };
      snapshot?: ComputerSnapshot;
      /** saveSnapshot was asked for and failed; the result stands. */
      snapshotError?: string;
      timings: JobTimings;
      /** What the job's container time cost its payer (USD), as metered; absent for a job run without a meter. */
      costUsd?: number;
    }
  | { ok: false; id: string; code: JobFailureCode; message: string; timings: JobTimings; freeBytes?: number; costUsd?: number };

export class JobSpecError extends Error {
  readonly code = "JOB_INVALID";
}

/**
 * The volume a job starts from (`at`), or a JobSpecError that says why there is none: a workflow's forks are deleted
 * when the workflow ends, which an agent reading a finished workflow's result may not know.
 */
export async function jobVolume<T>(open: () => Promise<T>, id: string): Promise<T> {
  try { return await open(); }
  catch (error) {
    if ((error as { status?: number }).status !== 404) throw error;
    throw new JobSpecError(`No volume ${id}: it does not exist or was deleted (a workflow's forks are deleted when the workflow ends; start from the volume they were committed to)`);
  }
}
const bad = (message: string) => new JobSpecError(message);
const encoder = new TextEncoder();
export const JOB_ID = /^[A-Za-z0-9_-]{1,100}$/;

/**
 * A relative path inside /repo or /out: no empty, `.` or `..` segment, no NUL, at most 4096 bytes. A leading `/` (a
 * volume's paths have one) is dropped.
 */
export function jobPath(value: unknown, what = "path"): string {
  if (typeof value !== "string") throw bad(`A job ${what} is a string`);
  const path = value.startsWith("/") ? value.slice(1) : value;
  if (!path || path.includes("\0") || encoder.encode(path).length > 4096 || path.split("/").some(part => !part || part === "." || part === ".."))
    throw bad(`Invalid job ${what}: ${JSON.stringify(value).slice(0, 200)}`);
  return path;
}

/**
 * The largest job anywhere: a build host's sandbox (jobs/host-pricing.ts: an r8gd.4xlarge's 16 vCPUs and the memory
 * pool its image reserves, and room on its NVMe). Only our own hosts take a job past a container's limits.
 */
export const HOST_JOB_MAX = Object.freeze({ cpus: 16, memoryMiB: 96 * 1024, diskMiB: 400 * 1024 });
/** Whether a container has room for these limits (the smallest one that does is the job's instance). */
export function fitsContainer(limits: JobLimits = {}) {
  try { jobInstance(limits); return true; } catch { return false; }
}

/**
 * The smallest job instance that has the asked-for vCPUs, memory and disk; none is a spec error. With `beyondContainers`
 * (a job our own hosts may take) limits past the largest container, up to HOST_JOB_MAX, are the largest instance: the
 * host boots the job's limits, not the instance.
 */
export function jobInstance(limits: JobLimits = {}, options: { beyondContainers?: boolean } = {}): InstanceType {
  const cpus = limits.cpus ?? 0, memoryMiB = limits.memoryMiB ?? 0, diskMiB = limits.diskMiB ?? 0;
  const fit = JOB_INSTANCES.find(type => {
    const r = INSTANCE_RESOURCES[type];
    // Cloudflare sizes disk in GB (10^9 bytes) and memory in GiB.
    return r.vcpu >= cpus && r.memoryGiB * 1024 >= memoryMiB && r.diskGB * 1e9 >= diskMiB * 1024 * 1024;
  });
  if (!fit && options.beyondContainers && cpus <= HOST_JOB_MAX.cpus && memoryMiB <= HOST_JOB_MAX.memoryMiB && diskMiB <= HOST_JOB_MAX.diskMiB)
    return JOB_INSTANCES.at(-1)!;
  if (!fit) {
    const top = INSTANCE_RESOURCES[JOB_INSTANCES.at(-1)!];
    if (options.beyondContainers) throw bad(`No job host has these limits; the largest job has ${HOST_JOB_MAX.cpus} vCPUs, ${HOST_JOB_MAX.memoryMiB} MiB of memory and ${HOST_JOB_MAX.diskMiB} MiB of disk`);
    throw bad(`No job instance has these limits; the largest has ${top.vcpu} vCPUs, ${top.memoryGiB * 1024} MiB of memory and ${top.diskGB} GB of disk`);
  }
  return fit;
}

const positive = (value: unknown, name: string, max: number, integer = false) => {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > max || (integer && !Number.isInteger(value)))
    throw bad(`limits.${name} must be a ${integer ? "whole " : ""}number above 0 and at most ${max}`);
  return value;
};

/** Check a job spec and return it with its defaults; anything wrong is a JobSpecError, before any compute starts. */
export function jobSpec(value: unknown, options: { beyondContainers?: boolean } = {}): JobSpec & { image: string; outputs: string[]; instance: InstanceType } {
  const v = value as Partial<JobSpec> | null;
  if (!v || typeof v !== "object") throw bad("A job is an object");
  const known = ["id", "image", "snapshot", "files", "volume", "command", "timeoutSeconds", "outputs", "limits", "internet", "saveSnapshot", "payer", "instance", "secretEnv"];
  const extra = Object.keys(v).find(key => !known.includes(key));
  if (extra) throw bad(`Unknown job field: ${extra}`);
  if (typeof v.id !== "string" || !JOB_ID.test(v.id)) throw bad("A job id is 1-100 letters, digits, _ or -");
  if (v.image !== undefined && (typeof v.image !== "string" || !SNAPSHOT_NAME.test(v.image))) throw bad("Invalid job image name");
  let snapshot: ComputerSnapshot | undefined;
  if (v.snapshot !== undefined) {
    try { snapshot = snapshotHandle(v.snapshot); } catch { throw bad("Invalid job snapshot"); }
  }
  if (typeof v.command !== "string" || !v.command || v.command.includes("\0") || encoder.encode(v.command).length > 16384)
    throw bad("A job command is a non-empty string of at most 16 KiB");
  const { min, max } = JOB_LIMITS.timeoutSeconds;
  if (!Number.isInteger(v.timeoutSeconds) || v.timeoutSeconds! < min || v.timeoutSeconds! > max)
    throw bad(`timeoutSeconds must be a whole number from ${min} to ${max}`);
  if (v.files !== undefined && v.volume !== undefined) throw bad("Give files or volume, not both");
  let files: JobFiles | undefined;
  if (v.files !== undefined) {
    if (!v.files || typeof v.files !== "object" || Array.isArray(v.files)) throw bad("files maps paths to bytes");
    const entries = Object.entries(v.files);
    if (entries.length > JOB_LIMITS.inlineFiles) throw bad(`At most ${JOB_LIMITS.inlineFiles} inline files`);
    let total = 0;
    files = {};
    for (const [path, bytes] of entries) {
      if (!(bytes instanceof Uint8Array)) throw bad("Each inline file is a Uint8Array");
      total += bytes.byteLength;
      const clean = jobPath(path, "file path");
      if (clean in files) throw bad(`Duplicate job file path: ${clean}`);
      files[clean] = bytes;
    }
    if (total > JOB_LIMITS.inlineBytes) throw bad(`Inline files are at most ${JOB_LIMITS.inlineBytes} bytes together; sync a volume snapshot instead`);
  }
  let volume: JobVolumeSource | undefined;
  if (v.volume !== undefined) {
    const s = v.volume as Partial<JobVolumeSource> | null;
    if (!s || typeof s.tenant !== "string" || !s.tenant || typeof s.volume !== "string" || !s.volume || typeof s.snapshot !== "string" || !s.snapshot)
      throw bad("A job volume source names a tenant, a volume and a snapshot");
    volume = { tenant: s.tenant, volume: s.volume, snapshot: s.snapshot };
  }
  if (v.outputs !== undefined && (!Array.isArray(v.outputs) || v.outputs.length > JOB_LIMITS.outputs)) throw bad(`outputs is a list of at most ${JOB_LIMITS.outputs} paths under /out`);
  const outputs = [...new Set((v.outputs ?? []).map(path => jobPath(path, "output path")))];
  const l = v.limits as JobLimits | undefined;
  if (l !== undefined && (!l || typeof l !== "object" || Object.keys(l).some(key => !["cpus", "memoryMiB", "diskMiB", "pids"].includes(key)))) throw bad("limits has cpus, memoryMiB, diskMiB and pids");
  const limits: JobLimits = {};
  if (l) {
    const cpus = positive(l.cpus, "cpus", 64), memoryMiB = positive(l.memoryMiB, "memoryMiB", 1 << 20, true), diskMiB = positive(l.diskMiB, "diskMiB", 1 << 24, true);
    if (cpus !== undefined) limits.cpus = cpus;
    if (memoryMiB !== undefined) limits.memoryMiB = memoryMiB;
    if (diskMiB !== undefined) limits.diskMiB = diskMiB;
    if (l.pids !== undefined) {
      if (!Number.isInteger(l.pids) || l.pids < JOB_LIMITS.pids.min || l.pids > JOB_LIMITS.pids.max) throw bad(`limits.pids must be a whole number from ${JOB_LIMITS.pids.min} to ${JOB_LIMITS.pids.max}`);
      limits.pids = l.pids;
    }
  }
  if (v.internet !== undefined && typeof v.internet !== "boolean") throw bad("internet is true or false");
  if (v.saveSnapshot !== undefined && (typeof v.saveSnapshot !== "string" || !SNAPSHOT_NAME.test(v.saveSnapshot))) throw bad("Invalid saveSnapshot name");
  // Every job has a payer: it is metered, holds a computer slot, and reads volumes of the payer's tenant only.
  if (!v.payer || typeof v.payer.tenant !== "string" || !v.payer.tenant || typeof v.payer.agent !== "string" || !v.payer.agent) throw bad("A job needs a payer: { tenant, agent }");
  // A workflow payer is a workflow's id (wf_…): its tenant pays, recorded under the workflow.
  if (v.payer.kind !== undefined && (v.payer.kind !== "workflow" || !/^wf_[A-Za-z0-9_-]{1,80}$/.test(v.payer.agent))) throw bad('A job\'s payer kind is "workflow", with the workflow\'s id as its agent');
  const payer: ComputerPayer = { tenant: v.payer.tenant, agent: v.payer.agent, ...(v.payer.kind ? { kind: v.payer.kind } : {}) };
  if (volume && volume.tenant !== payer.tenant) throw bad("A job reads volumes of its payer's tenant only");
  let secretEnv: Record<string, string> | undefined;
  if (v.secretEnv !== undefined) {
    const entries = v.secretEnv && typeof v.secretEnv === "object" && !Array.isArray(v.secretEnv) ? Object.entries(v.secretEnv) : undefined;
    if (!entries || entries.length > 8 || entries.some(([name, value]) => !/^[A-Z][A-Z0-9_]{0,63}$/.test(name) || name === "JOB_ID" || name === "JOB_OUT" || typeof value !== "string" || value.length > 8192 || value.includes("\0")))
      throw bad("secretEnv maps at most 8 upper-case names (not JOB_ID or JOB_OUT) to strings of at most 8 KiB");
    secretEnv = Object.fromEntries(entries);
  }
  // A checked spec is checked again where it runs (ContainerComputer.runJob): its derived instance must be the one its limits give.
  const instance = jobInstance(limits, options);
  const given = (v as { instance?: unknown }).instance;
  if (given !== undefined && given !== instance) throw bad(`instance is derived from limits (${instance}), not set`);
  return {
    id: v.id, image: v.image ?? "workspace", command: v.command, timeoutSeconds: v.timeoutSeconds!, outputs,
    ...snapshot ? { snapshot } : {}, ...files ? { files } : {}, ...volume ? { volume } : {},
    ...Object.keys(limits).length ? { limits } : {}, ...v.internet ? { internet: true } : {},
    ...v.saveSnapshot ? { saveSnapshot: v.saveSnapshot } : {}, payer, ...secretEnv ? { secretEnv } : {},
    instance,
  };
}
