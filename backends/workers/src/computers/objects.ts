import { guardAlarms } from "../alarm-guard.ts";
import { HttpError } from "../errors.ts";
import { keyServices } from "../security-services.ts";
import { reserveComputer, releaseComputer, computerToolError } from "../../../../src/core/computer-limit.ts";
import { SHARED_COMPUTER_STOPPED, SHARED_COMPUTER_CONTROL } from "../../../../src/core/computer-share.ts";
import { transaction, withSql } from "../postgres.ts";
import { secretPlaceholder } from "../../../../src/core/vault.ts";
import { DurableObject } from "cloudflare:workers";
import {
  ContainerProvider,
  computerSpec,
  operate,
  sameComputerNetwork,
  type ComputerNetwork,
  type ComputerRequest,
  type ComputerSnapshot,
  type ProviderMeter,
} from "./provider.ts";
import { COMPUTER_LIMITS, computerNetworkKey, type ComputerSetup } from "./egress.ts";
import type { NativeForkAnswer, NativeForkOrigin, NativeForkedFrom } from "./native-fork.ts";
import type { EgressProps } from "./egress-gateway.ts";
import { ComputerMeter, type ComputerPayer } from "./meter.ts";
export { payerSetup } from "./meter.ts";
import { meterBilling } from "./meter-billing.ts";
import type { KeyEnv } from "../security-services.ts";
import type { WebhookEnv } from "../webhooks.ts";
import { runContainerJob, type JobMeter } from "../jobs/container-job.ts";
import { inlineFiles, volumeFiles, type VolumeSyncEnv } from "../jobs/camel-sync.ts";
import { jobLifetimeMs, jobSpec, type JobResult } from "../jobs/job.ts";

type ComputerObjectEnv = KeyEnv & WebhookEnv & { COMPUTER_IMAGE?: string; COMPUTER_INSTANCE?: string; COMPUTER_CONTAINERS?: DurableObjectNamespace<ContainerComputer> };
/**
 * What the agent sends with an operation: its definition's computer settings and identity, and, for a sub-agent, the
 * name of its parent's computer object, which the runtime takes from the signed parent link.
 */
export type OperateSetup = ComputerSetup & { parent?: string; externalPermit?: boolean; shared?: boolean };
type EgressBinding = (options: { props: EgressProps }) => Fetcher;
/** Who pays for an operation's container time: the identity's tenant and agent. */
function payerOf(setup?: OperateSetup): ComputerPayer | undefined {
  const claims = setup?.identity.claims as { tenant?: unknown; agent?: unknown } | undefined;
  return typeof claims?.tenant === "string" && typeof claims.agent === "string" ? { tenant: claims.tenant, agent: claims.agent } : undefined;
}

/**
 * How often an idle running container's payer is admitted again (checkLimits, from the alarm). While a command runs the
 * alarm is the command's deadline instead (checkAfterActive, at most COMPUTER_LIMITS.execMs), and the check runs then.
 */
const LIMIT_CHECK_MS = 60_000;
/** A billing refusal: a spend limit or spent credit (402), or free credit's hourly allowance (429). */
const limitRefusal = (error: unknown) => [402, 429].includes(Number((error as { status?: number } | undefined)?.status));

// An optional, dedicated per-agent computer, not the agent's own DO. It owns
// one container through ctx.container (Cloudflare's `durable_object` scheduling
// policy) and picks image and size each time it starts one. One queue excludes
// simultaneous writes while taking or restoring a snapshot. Container time is
// metered to the payer each call's setup names (computers/meter.ts); a call
// without one (the cloud probe) runs unmetered.
export class ContainerComputer extends DurableObject<ComputerObjectEnv> {
  constructor(ctx: DurableObjectState, env: ComputerObjectEnv) {
    super(ctx, env);
    guardAlarms(this, ctx, "ContainerComputer", { test: (env as { TEST_MODE?: unknown }).TEST_MODE === "1" });
  }
  private queue: Promise<unknown> = Promise.resolve();
  /** The job this object runs now, when it is a job's object (jobs/driver.ts): its stop. */
  private job?: AbortController;
  /** The job this object runs now: a call for the same job made again (its caller was evicted) waits for this run. */
  private jobRun?: { id: string; result: Promise<JobResult> };
  private active = new Map<Promise<unknown>, number>();
  private network(setup?: OperateSetup): ComputerNetwork {
    const idleMs = (setup?.settings.idleSeconds ?? COMPUTER_LIMITS.idleSeconds.default) * 1000;
    const grants = [...(setup?.settings.egress ?? []), ...(setup?.settings.networking?.type === "limited" || setup?.settings.secrets?.length ? [{ host: "*" }] : [])], instance = setup?.settings.instance, idle = setup?.settings.idle;
    // The key names what a running container was started with; another key replaces it (ContainerProvider.ready).
    if (!grants.length) return { key: instance ? JSON.stringify([[], null, instance]) : "", egress: [], idleMs, ...idle ? { idle } : {} };
    const gateway = (this.ctx as unknown as { exports: { ComputerEgress: EgressBinding } }).exports.ComputerEgress;
    return {
      // The identity is part of the key: a gateway's props carry it, so a new one needs new intercepts.
      key: computerNetworkKey(grants, setup!.identity.claims, setup!.settings),
      limited: setup!.settings.networking?.type === "limited",
      secrets: Object.fromEntries((setup!.settings.secrets ?? []).map(ref => [ref.name, secretPlaceholder(ref.name)])),
      egress: (grants.some(g => g.host === "*") ? [{host:"*"}] : grants).map(grant => ({ grant, gateway: gateway({ props: { grant, grants, identity: setup!.identity, secrets: setup!.settings.secrets, networking: setup!.settings.networking, mcpHosts: setup!.settings.mcpHosts } }) })),
      idleMs,
      ...idle ? { idle } : {},
    };
  }
  /**
   * Stop a running container whose payer may no longer spend (its tenant's monthly spend limit or prepaid credit, or the
   * agent's spend limit), as Node stops a managed machine at its sweep: a computer that sleeps when idle saves its disk
   * first (provider.stopForLimit), any other is halted after a last CPU reading; its session is charged up to now, once
   * (the session's id), and its slot is given back. The agent hears of it at its next operation, refused with why.
   */
  private async limitStop(payer: ComputerPayer, error: unknown) {
    if (!this.ctx.container?.running) return;
    console.error(JSON.stringify({ type: "computer_limit_stop", tenant: payer.tenant, agent: payer.agent, status: (error as { status?: number }).status ?? null, code: (error as { code?: string }).code ?? null }));
    await this.provider().stopForLimit();
    await this.releasePermit();
  }
  /** While a session is open, its payer is admitted again at least this often; one refused is stopped (limitStop). */
  private async checkLimits() {
    const meter = this.meter(), payer = await meter.openPayer();
    if (!payer || !this.ctx.container?.running) return;
    // A job is admitted at its start and bounded by its own timeout: stopped midway it would fail, not pause its workflow.
    if (this.job || await this.ctx.storage.get<number>("job:deadline") !== undefined) return;
    try { await meter.admit(payer); }
    catch (error) {
      if (limitRefusal(error)) await this.limitStop(payer, error);
      else console.error(JSON.stringify({ type: "computer_limits_read_failed", tenant: payer.tenant, agent: payer.agent, status: (error as { status?: number }).status ?? null }));
    }
  }
  private meter() {
    return new ComputerMeter({
      store: this.ctx.storage,
      billing: meterBilling(this.env),
      idleMs: COMPUTER_LIMITS.idleSeconds.default * 1000,
      schedule: at => this.ctx.storage.setAlarm(at),
    });
  }
  private async releasePermit() {
    const permit = await this.ctx.storage.get<{ tenant: string; machine: string }>("computer:permit");
    if (permit) {
      await withSql(this.env, sql => releaseComputer(sql, permit.tenant, permit.machine));
      await this.ctx.storage.delete("computer:permit");
    }
  }
  private provider(setup?: OperateSetup, activityMs = 0) {
    if (!this.ctx.container)
      throw new Error("Computer container binding unavailable");
    const spec = { ...computerSpec(this.env), ...(setup?.settings.instance ? { instance: setup.settings.instance } : {}) };
    const network = this.network(setup), meter = this.meter(), payer = payerOf(setup);
    const bound: ProviderMeter = {
      admit: async () => {
        if (setup?.shared && await this.ctx.storage.get<boolean>("computer:stopped")) throw new HttpError(409, SHARED_COMPUTER_STOPPED, "COMPUTER_STOPPED");
        if (!payer) return;
        try { await meter.admit(payer); }
        catch (error) {
          // Refused for spend: the operation fails, and a container still running for it stops now rather than idling
          // out, but only when the refusal is its session's payer's. On a shared computer the operating agent (a child,
          // at its own spend limit) is not who the session bills: only its operation fails, as before.
          const session = limitRefusal(error) ? await meter.openPayer() : undefined;
          if (session && session.tenant === payer.tenant && session.agent === payer.agent) await this.limitStop(payer, error);
          throw error;
        }
        if (setup?.externalPermit) return;
        await transaction(this.env, async sql => reserveComputer(sql, payer.tenant, payer.agent,
          `native:${payer.agent}`, Date.now() + Math.max(network.idleMs, activityMs), Date.now(),
          (await keyServices(this.env)).accounts.tenants.computerLimit(payer.tenant)));
        await this.ctx.storage.put("computer:permit", { tenant: payer.tenant, machine: `native:${payer.agent}` });
      },
      // Unmetered starts still end any earlier session.
      started: async (instance, idleMs) => {
        if (!payer) { await meter.stopped(); return; }
        await meter.started(payer, instance, idleMs);
        await this.wake(Date.now() + LIMIT_CHECK_MS);
      },
      // A running container with no open session (a DO that died mid-start, or one started unmetered) is billed from
      // now to whoever uses it (its CPU from the current reading on).
      used: async (cpuUsec) => {
        if (payer && this.ctx.container?.running && !(await meter.isOpen())) await meter.started(payer, spec.instance, network.idleMs, cpuUsec ?? 0);
        else await meter.used(cpuUsec);
      },
      stopped: async (cpuUsec) => { await this.releasePermit(); await meter.stopped(cpuUsec); },
    };
    return new ContainerProvider(this.ctx.container, this.ctx.storage, spec, Date.now, network, bound, at => this.wake(at));
  }
  /** The alarm at `at`, unless one is set sooner (the meter's and the idle sleep's share it; each alarm re-arms both). */
  private async wake(at: number) {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
  }
  private serial<T>(run: () => Promise<T>) {
    const result = this.queue.then(async () => { await Promise.allSettled([...this.active.keys()]); return run(); });
    this.queue = result.catch(() => {});
    return result;
  }
  async operate(request: ComputerRequest, setup?: OperateSetup) {
    if (setup?.shared && ["sleep", "restore"].includes(request.op)) throw new Error(SHARED_COMPUTER_CONTROL);
    const timeout = request.op === "exec" ? (request.timeoutMs ?? 30_000) : 30_000;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > COMPUTER_LIMITS.execMs) throw new Error("Invalid computer timeout");
    if (["sleep", "restore", "snapshot"].includes(request.op)) return this.serial(async () => {
      if (request.op === "sleep") await this.ctx.storage.put("computer:stopped", true);
      else if (request.op === "restore") await this.ctx.storage.delete("computer:stopped");
      return operate(this.provider(setup), request, AbortSignal.timeout(timeout));
    });
    // Startup and configuration changes stay serialized; running commands share the live container.
    let running!: Promise<unknown>;
    const begin = this.queue.then(async () => {
      if (this.ctx.container?.running && !sameComputerNetwork(await this.ctx.storage.get<string>("network") ?? "", this.network(setup).key)) {
        if (setup?.shared) throw new Error(SHARED_COMPUTER_CONTROL);
        await Promise.allSettled([...this.active.keys()]);
      }
      const provider = this.provider(setup, timeout);
      if (!setup?.shared) await this.ctx.storage.delete("computer:stopped");
      await provider.ready();
      running = operate(provider, request, AbortSignal.timeout(timeout));
      this.active.set(running, Date.now() + timeout);
      void running.finally(async () => {
        this.active.delete(running);
        const payer = payerOf(setup);
        const settled = this.queue.then(async () => {
          if (payer && !setup?.externalPermit && !this.active.size) await withSql(this.env, sql => sql.query("update computer_slots set expires_at=$3 where tenant=$1 and machine=$2", [payer.tenant, `native:${payer.agent}`, Date.now() + (setup?.settings.idleSeconds ?? COMPUTER_LIMITS.idleSeconds.default) * 1000]));
        });
        this.queue = settled.catch(() => {});
        await settled;
        if (!this.active.size) await this.wake(Date.now());
      }).catch(() => {});
    });
    this.queue = begin.catch(() => {});
    try { await begin; } catch (error) { throw computerToolError(error); }
    return running;
  }
  // Forking (native-fork.ts). Errors a caller acts on cross RPC as values: an HttpError's code does not survive it.
  /** The parent's side: the snapshot every child of `batch` starts from, taken (or reused) now. */
  forkSnapshot(batch: string, setup?: OperateSetup): Promise<NativeForkAnswer> {
    return this.serial(async () => {
      try { return await this.provider(setup).forkSnapshot(batch, AbortSignal.timeout(180_000)); }
      catch (error) {
        if ((error as { code?: string }).code === "COMPUTER_STARTING") return { ok: false as const, code: "COMPUTER_STARTING" as const, message: (error as Error).message };
        throw error;
      }
    });
  }
  adopt(batch: string, child: string): Promise<void> {
    return this.serial(() => this.provider().adopt(batch, child));
  }
  unref(batch: string, child: string): Promise<void> {
    return this.serial(() => this.provider().unref(batch, child));
  }
  /** The child's side: start from the parent's snapshot from now on, and tell the parent's computer. */
  /** Whether this computer has a disk of its own (running, or a saved base): the fork route refuses to overwrite it. */
  hasDisk(): Promise<boolean> {
    return this.serial(() => this.provider().hasDisk());
  }
  async seed(snapshot: ComputerSnapshot, origin: NativeForkOrigin, setup?: OperateSetup): Promise<void> {
    await this.serial(() => this.provider(setup).seed(snapshot, origin));
    await this.env.COMPUTER_CONTAINERS?.getByName(origin.parent).adopt(origin.batch, this.ctx.id.toString());
  }
  forkedFrom(): Promise<NativeForkedFrom | null> {
    return this.serial(() => this.provider().forkedFrom());
  }
  /**
   * A child's work ended. purge: its container and handles go (as on deletion), and its parent's computer is told.
   * sleep: its disk is saved as its base, then the container stops: a later turn resumes it, and compute stops now.
   */
  async release(mode: "purge" | "sleep"): Promise<void> {
    if (mode === "purge") { await this.purge(); return; }
    await this.serial(async () => { await this.provider().sleep(true); });
  }
  /** Take a snapshot now and return its handle. */
  takeSnapshot(name: string, setup?: OperateSetup): Promise<ComputerSnapshot> {
    return this.serial(() =>
      this.provider(setup).snapshot(name, AbortSignal.timeout(30_000)),
    );
  }
  /** A named snapshot's handle, for another computer to start from (fork). */
  snapshotHandle(name: string): Promise<ComputerSnapshot> {
    return this.serial(() => this.provider().snapshotNamed(name));
  }
  /** Replace this computer's filesystem with a snapshot taken by any computer. */
  startFromSnapshot(handle: ComputerSnapshot, setup?: OperateSetup): Promise<ComputerSnapshot> {
    return this.serial(() =>
      this.provider(setup).startFrom(handle, AbortSignal.timeout(30_000)),
    );
  }
  /**
   * Stop the container and forget every snapshot handle (agent deletion). Its time is charged first; a charge that
   * cannot commit yet keeps only the meter's records, which the alarm retries.
   */
  async purge(): Promise<{ purged: true }> {
    const origin = await this.serial(async () => {
      let origin: NativeForkedFrom | null = null;
      if (this.ctx.container) {
        const provider = this.provider();
        origin = await provider.forkedFrom();
        // Stopping through the provider takes a last CPU reading for the meter (no snapshot: the disk goes).
        await provider.halt();
      }
      const meter = this.meter();
      await meter.stopped();
      if (await meter.settled()) await this.ctx.storage.deleteAll();
      else for (const key of (await this.ctx.storage.list()).keys())
        if (!key.startsWith("meter:")) await this.ctx.storage.delete(key);
      await this.ctx.storage.put("computer:stopped", true);
      return origin;
    });
    // A forked child: its parent's computer drops the batch's snapshot once no child of it is left. Best effort.
    if (origin) await this.env.COMPUTER_CONTAINERS?.getByName(origin.parent).unref(origin.batch, this.ctx.id.toString())
      .catch((error: unknown) => console.error(JSON.stringify({ type: "computer_unref_failed", error: error instanceof Error ? error.message.slice(0, 200) : "unknown" })));
    return { purged: true as const };
  }
  // Jobs (jobs/driver.ts): an object named `job:<id>` runs one job at a time, start to stop, in its own container.
  /** The payer's admission, computer slot (`job:<id>`, expiring with the job) and container-time meter. */
  private jobMeter(id: string, payer: ComputerPayer): JobMeter {
    const meter = this.meter(), machine = `job:${id}`;
    return {
      admit: async (_instance, until) => {
        await meter.admit(payer);
        const limit = (await keyServices(this.env)).accounts.tenants.computerLimit(payer.tenant);
        await transaction(this.env, async sql => reserveComputer(sql, payer.tenant, payer.agent, machine, until, Date.now(), await limit));
        await this.ctx.storage.put("computer:permit", { tenant: payer.tenant, machine });
      },
      // Named by the job: a run of the same job made again is charged under the same receipt, once.
      started: (instance, idleMs) => meter.started(payer, instance, idleMs, 0, `job:${id}`),
      used: cpu => meter.used(cpu),
      stopped: async cpu => { await meter.stopped(cpu); await this.releasePermit(); return meter.spentUsd(); },
    };
  }
  /**
   * Run one job (jobs/container-job.ts). The same job asked again while it runs gets that run's result, and asked again
   * within an hour of its end, the result it kept: never a second run. Another job while one runs answers job_running.
   */
  async runJob(value: unknown): Promise<JobResult> {
    const spec = jobSpec(value);
    const refused = (code: "job_running" | "start_failed", message: string): JobResult => {
      const at = Date.now();
      return { ok: false, id: spec.id, code, message, timings: { startedAt: at, endedAt: at, startMs: 0, syncMs: 0, commandMs: 0, collectMs: 0, totalMs: 0 } };
    };
    // The same job asked again while it runs (its caller was evicted and called again): this run's result, once.
    if (this.jobRun?.id === spec.id) return await this.jobRun.result;
    if (this.job) return refused("job_running", `Job ${spec.id} is running`);
    // Asked again after it ended (its caller lost the answer): the result it kept, not another run.
    const kept = await this.ctx.storage.get<KeptJobResult>("job:result");
    if (kept && kept.result.id === spec.id && kept.expiresAt > Date.now()) return kept.result;
    if (!this.ctx.container) return refused("start_failed", "Job container binding unavailable");
    const result = this.runJobOnce(spec);
    this.jobRun = { id: spec.id, result };
    try { return await result; } finally { if (this.jobRun?.result === result) this.jobRun = undefined; }
  }
  private async runJobOnce(spec: ReturnType<typeof jobSpec>): Promise<JobResult> {
    const stop = this.job = new AbortController();
    // The backstop for an object that dies mid-job: its alarm destroys the container after the job's whole lifetime.
    const deadline = Date.now() + jobLifetimeMs(spec.timeoutSeconds);
    try {
      await this.ctx.storage.put("job:deadline", deadline);
      await this.wake(deadline);
      const files = spec.files ? inlineFiles(spec.files) : spec.volume ? volumeFiles(this.env as unknown as VolumeSyncEnv, spec.volume) : undefined;
      const result = await runContainerJob(spec, {
        container: this.ctx.container!, stop: stop.signal, ...files ? { files } : {},
        meter: this.jobMeter(spec.id, spec.payer),
      });
      // Kept for a caller that lost it (evicted before it took the answer), within a DO value's size, for an hour.
      if (result.ok) {
        const expiresAt = Date.now() + JOB_RESULT_KEPT_MS;
        await this.ctx.storage.put("job:result", { result: keptJobResult(result), expiresAt } satisfies KeptJobResult);
        await this.wake(expiresAt);
      }
      return result;
    } finally {
      this.job = undefined;
      await this.ctx.storage.delete("job:deadline");
    }
  }
  /** Stop this object's job: the running one answers `stopped`; a container a dead run left is destroyed. */
  async stopJob(): Promise<{ stopped: boolean }> {
    if (this.job) { this.job.abort(); return { stopped: true }; }
    if (this.ctx.container?.running && await this.ctx.storage.get<number>("job:deadline") !== undefined) {
      await this.ctx.container.destroy().catch(() => {});
      await this.meter().stopped();
      await this.releasePermit();
      await this.ctx.storage.delete("job:deadline");
      return { stopped: true };
    }
    return { stopped: false };
  }
  /** A job whose object died mid-run: past its deadline, its container goes and its slot is given back. */
  private async jobBackstop() {
    const kept = await this.ctx.storage.get<KeptJobResult>("job:result");
    if (kept && kept.expiresAt <= Date.now()) await this.ctx.storage.delete("job:result");
    else if (kept) await this.wake(kept.expiresAt);
    const deadline = await this.ctx.storage.get<number>("job:deadline");
    if (deadline === undefined || this.job) return;
    if (Date.now() < deadline) { await this.wake(deadline); return; }
    if (this.ctx.container?.running) await this.ctx.container.destroy().catch(() => {});
    await this.meter().stopped();
    await this.releasePermit();
    await this.ctx.storage.delete("job:deadline");
  }
  /**
   * Put a computer that sleeps when idle to sleep once its idle time is up, settle a session that idled out, retry
   * charges that failed, and drop fork snapshots no child adopted.
   */
  private async checkAfterActive() {
    const deadline = Math.max(...this.active.values());
    await this.ctx.storage.setAlarm(deadline > Date.now() ? deadline : Date.now() + 30_000);
  }
  async alarm() {
    // Never put a waiter for a long command onto the command queue. Check again after that command,
    // leaving exec admission free for the other agents sharing this container.
    // Spend first: a payer that may no longer spend is stopped, a running command included (the alarm comes at its deadline).
    await this.checkLimits();
    if (this.active.size) { await this.checkAfterActive(); return; }
    const check = this.queue.then(async () => {
      if (this.active.size) { await this.checkAfterActive(); return; }
      await this.jobBackstop();
      const provider = this.ctx.container ? this.provider() : undefined;
      const next = await provider?.sleepIfIdle().catch((error: unknown) => {
        console.error(JSON.stringify({ type: "computer_idle_sleep_failed", error: error instanceof Error ? error.message.slice(0, 200) : "unknown" }));
        return undefined;
      });
      if (!this.ctx.container?.running) await this.releasePermit();
      await this.meter().alarm(!!this.ctx.container?.running);
      await provider?.dropStale().catch(() => {});
      if (next !== undefined) await this.wake(next);
      if (this.ctx.container?.running && await this.meter().isOpen()) await this.wake(Date.now() + LIMIT_CHECK_MS);
    });
    this.queue = check.catch(() => {});
    await check;
  }
}

/** How long a finished job's result is kept for a caller that asks again. */
const JOB_RESULT_KEPT_MS = 3_600_000;
/** Of each stream and each output, what a kept result holds (a DO value is at most 2 MiB): the end of a stream, the start of an output. */
const KEPT_BYTES = 256 * 1024, KEPT_OUTPUT_TOTAL = 1024 * 1024;
type KeptJobResult = { result: JobResult; expiresAt: number };
/** A finished job's result cut to fit one DO value: what is cut is marked truncated. */
function keptJobResult(result: Extract<JobResult, { ok: true }>): JobResult {
  const tail = (stream: { bytes: Uint8Array; size: number; truncated: boolean }) => stream.bytes.byteLength <= KEPT_BYTES ? stream : { bytes: stream.bytes.slice(-KEPT_BYTES), size: stream.size, truncated: true };
  let room = KEPT_OUTPUT_TOTAL;
  const outputs = Object.fromEntries(Object.entries(result.outputs).map(([name, output]) => {
    const keep = Math.max(0, Math.min(KEPT_BYTES, room, output.bytes.byteLength));
    room -= keep;
    return [name, keep === output.bytes.byteLength ? output : { bytes: output.bytes.slice(0, keep), size: output.size, truncated: true }];
  }));
  return { ...result, stdout: tail(result.stdout), stderr: tail(result.stderr), outputs };
}
