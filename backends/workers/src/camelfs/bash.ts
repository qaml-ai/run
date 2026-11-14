import { createHash } from "node:crypto";
import { defineTool } from "@earendil-works/pi-durable";
import { int, obj, opt, str } from "@earendil-works/pi-schema";
import type { AgentRuntime } from "../agent-runtime.ts";
import type { Config, Env } from "../agent-types.ts";
import { meterBilling } from "../computers/meter-billing.ts";
import { computerSpec } from "../computers/provider.ts";
import { HttpError } from "../errors.ts";
import { HOSTS_PROVIDER, hostPool, hostSecondRate, hostShape, type HostPriceEnv, type HostShape } from "../jobs/host-pricing.ts";
import { workspaceMount, type Mount } from "../repos/mounts.ts";
import { HttpRepoClient } from "../repos/http-client.ts";
import { repoContext, type RepoEnv } from "../repos/registry.ts";
import { bashStream, type BashResult } from "./bash-stream.ts";
import type { TierClaims } from "./claims.ts";
import { TierError, tierConfigured, tierRequest } from "./tier.ts";
import { encodeVmPayer, type VmPayer } from "./usage.ts";
import { startUsagePoller } from "./usage-poller.ts";
import { guestFiles, VM_FILES_STDOUT_BYTES, type VmFiles } from "./vm-files.ts";

export const BASH_WORKDIR = '/workspace';
export type BashEnv = HostPriceEnv & { CAMELFS_COMPUTE?: string; CAMELFS_POOLS?: string; GUEST_IMAGE_SHA256?: string; COMPUTER_INSTANCE?: string };

/**
 * The tier pool a VM of this shape runs in: THE mapping is the deployment's `CAMELFS_POOLS` (JSON: shape class → pool,
 * with an optional "default"), e.g. {"default":"test"} while one test host exists. The shape class is hostPool(shape)
 * ("test" | "build"). There is no code-side default: an unmapped shape is refused here, never sent to the tier.
 */
export function tierPool(env: { CAMELFS_POOLS?: string }, shape: HostShape): string {
  let map: unknown;
  try { map = JSON.parse(env.CAMELFS_POOLS ?? "null"); } catch { map = null; }
  const pools = map && typeof map === "object" && !Array.isArray(map) ? map as Record<string, unknown> : {};
  const pool = pools[hostPool(shape)] ?? pools.default;
  if (typeof pool !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(pool))
    throw new Error(`no host pool for shape ${shape.vcpus} vCPU / ${shape.memoryMiB} MiB (CAMELFS_POOLS)`);
  return pool;
}
export const bashEnabled = (env: Env) => tierConfigured(env) && env.CAMELFS_COMPUTE === "1";

// MONEY: renew a ten-minute credit lease after three minutes of elapsed lease time.
const LEASE_MS = 600_000;
const RENEW_MS = 180_000;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const isTier = (error: unknown, status: number, code: string) => error instanceof TierError && error.status === status && error.code === code;
const vmStopped = (error: unknown) => isTier(error, 409, "not_running") || isTier(error, 409, "ended") || isTier(error, 409, "lease_expired");
const computeBusy = "compute is busy, retry shortly";

type Branch = { branch: string; lineage: string; ref: string };
type Vm = Branch & { vm_id: string; shell: string | null; state: "creating" | "running" | "stopped"; deadline: number; created_at: number };
type Boot = ReturnType<typeof bootSpec> & { id: string; lineage: string; ref: string; deadline: number };
type Intent = { vm: Vm; first: boolean; body: { execId: string; command: string; shell: string; cwd?: string; timeoutS: number } };
type Checkpoint = { vm: Vm; callId: string; requestId?: string; message: string; time: number; started?: boolean };
type SessionResult = BashResult & { checkpointWarning?: string };
type Receipt = { intent?: Intent; result?: SessionResult; checkpoint?: Checkpoint };
type Args = { command: string; cwd?: string; timeoutSeconds?: number };
type Head = { version: string; tree: string };
type Status = { phase: string; code?: string; lastCheckpoint?: Head };

function claims(vm: Branch): TierClaims {
  return { sub: "runtime:bash", lin: vm.lineage, acc: "w", refs: [vm.ref] };
}

function bootSpec(env: Env, conf: Config) {
  const image = env.GUEST_IMAGE_SHA256;
  if (!image || !/^[a-f0-9]{64}$/.test(image)) throw new Error("GUEST_IMAGE_SHA256 must name a published guest image");
  const shape = hostShape({ instance: conf.config.computer?.instance ?? computerSpec(env).instance });
  const pool = tierPool(env, shape);
  // MONEY: the encoded payer fixes the rate at create, priced by the shape's class (hostPool) whatever tier pool it is
  // placed in. The usage poller settles independently of vm.ended.
  const payer: VmPayer = { tenant: conf.tenantId, agent: conf.id, rate: hostSecondRate(hostPool(shape), shape, env) };
  return {
    image, pool, shape: { vcpus: shape.vcpus, memoryMiB: shape.memoryMiB, diskGiB: Math.ceil(shape.diskMiB / 1024) },
    network: { internet: conf.config.networking?.type !== "limited" }, usage: { payer: encodeVmPayer(payer) },
  };
}

export class BashSessions {
  private readonly savedHeads = new Map<string, Head>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private get sql() { return this.storage.sql; }

  private readonly storage: DurableObjectStorage;
  private readonly env: Env;
  private readonly defer: (work: Promise<unknown>) => void;
  private readonly arm: (at?: number) => Promise<void>;
  private readonly checkpointFailed: (callId: string, requestId: string, error: string) => Promise<void>;
  private readonly admit: ReturnType<typeof meterBilling>["admit"];
  private renewing = false;

  constructor(
    storage: DurableObjectStorage,
    env: Env,
    defer: (work: Promise<unknown>) => void,
    arm: (at?: number) => Promise<void>,
    checkpointFailed: (callId: string, requestId: string, error: string) => Promise<void>,
    admit = meterBilling(env, HOSTS_PROVIDER).admit,
  ) {
    this.storage = storage;
    this.env = env;
    this.defer = defer;
    this.arm = arm;
    this.checkpointFailed = checkpointFailed;
    this.admit = admit;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS agent_vms (
      branch TEXT PRIMARY KEY, vm_id TEXT UNIQUE, ref TEXT, lineage TEXT, deadline INTEGER,
      state TEXT CHECK(state IN ('creating','running','stopped')), shell TEXT, created_at INTEGER
    )`);
    this.sql.exec("CREATE TABLE IF NOT EXISTS agent_vm_boot (branch TEXT PRIMARY KEY, body TEXT NOT NULL, seq INTEGER NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS agent_vm_shell_used (vm_id TEXT PRIMARY KEY)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS agent_vm_heads (branch TEXT PRIMARY KEY, version TEXT NOT NULL, tree TEXT NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS agent_vm_checkpoint_warnings (branch TEXT PRIMARY KEY, reason TEXT NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS agent_vm_renewal (vm_id TEXT PRIMARY KEY, next INTEGER NOT NULL, refused INTEGER NOT NULL, proposed INTEGER)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS agent_vm_deliveries (id TEXT PRIMARY KEY)");
    this.sql.exec(`CREATE TABLE IF NOT EXISTS agent_vm_calls (
      id TEXT PRIMARY KEY, branch TEXT NOT NULL, receipt TEXT NOT NULL, checkpoint INTEGER NOT NULL DEFAULT 0
    )`);
    this.sql.exec("CREATE INDEX IF NOT EXISTS agent_vm_checkpoints ON agent_vm_calls(branch) WHERE checkpoint=1");
  }

  private async serial<T>(branch: string, action: () => Promise<T>): Promise<T> {
    const next = (this.locks.get(branch) ?? Promise.resolve()).then(action);
    const settled = next.catch(() => {});
    this.locks.set(branch, settled);
    try { return await next; }
    finally { if (this.locks.get(branch) === settled) this.locks.delete(branch); }
  }

  private row(branch: string) {
    return this.sql.exec<Vm>("SELECT * FROM agent_vms WHERE branch=?", branch).toArray()[0];
  }

  private stop(vmId: string) {
    this.savedHeads.delete(vmId);
    this.sql.exec("UPDATE agent_vms SET state='stopped' WHERE vm_id=?", vmId);
  }

  ended(id: string, vmId: string) {
    this.storage.transactionSync(() => {
      if (!this.sql.exec("INSERT OR IGNORE INTO agent_vm_deliveries VALUES(?) RETURNING id", id).toArray().length) return;
      this.stop(vmId);
    });
  }

  private request<T>(vm: Vm, method: string, suffix = "", body?: unknown, timeoutMs?: number, idempotencyKey?: string) {
    return tierRequest<T>(this.env, { method, path: "/v1/vms/" + vm.vm_id + suffix, body, claims: claims(vm), timeoutMs, idempotencyKey });
  }

  private receipt(key: string): Receipt | undefined {
    const row = this.sql.exec<{ receipt: string }>("SELECT receipt FROM agent_vm_calls WHERE id=?", key).toArray()[0];
    return row && JSON.parse(row.receipt);
  }

  private save(key: string, branch: string, receipt: Receipt) {
    this.sql.exec(`INSERT INTO agent_vm_calls VALUES(?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET receipt=excluded.receipt,checkpoint=excluded.checkpoint`,
      key, branch, JSON.stringify(receipt), Number(!!receipt.checkpoint));
  }

  private async credit(conf: Config) {
    // MONEY: admission checks spend limits and available credit before create or renewal, without a hold.
    try { await this.admit({ tenant: conf.tenantId, agent: conf.id }); }
    catch (error) {
      const { status, code } = (error ?? {}) as { status?: number; code?: string };
      if (status === 402 || (status === 429 && code === "FREE_HOURLY_LIMIT")) return false;
      if (status === 429) throw new HttpError(429, computeBusy);
      throw error;
    }
    return true;
  }

  private async ready(conf: Config, branch: Branch) {
    let vm = this.row(branch.branch);
    if (vm?.state === "running") return vm;
    const creating = vm?.state === "creating" ? vm : undefined;
    const prior = vm;
    const boot = this.sql.exec<{ body: string; seq: number }>("SELECT body,seq FROM agent_vm_boot WHERE branch=?", branch.branch).toArray()[0];
    let body: Boot;
    if (creating) {
      body = JSON.parse(boot.body) as Boot;
      vm = creating;
    } else {
      const spec = bootSpec(this.env, conf);
      // MONEY: no VM row or create request is issued on refusal. Persist the original priced boot spec for replay.
      if (!await this.credit(conf)) throw new Error("no credit for compute");
      const created_at = Date.now();
      const seq = (boot?.seq ?? 0) + 1;
      const n = seq.toString(36);
      const prefix = `vm-${conf.id}-`;
      const id = prefix + hash(branch.branch).slice(0, Math.min(16, 95 - prefix.length - n.length)) + "-" + n;
      body = { ...spec, id, lineage: branch.lineage, ref: branch.ref, deadline: created_at + LEASE_MS };
      vm = { ...branch, vm_id: id, deadline: body.deadline, state: "creating", shell: null, created_at };
      const created = vm;
      this.storage.transactionSync(() => {
        this.sql.exec("INSERT OR REPLACE INTO agent_vms VALUES(?,?,?,?,?,?,?,?)",
          created.branch, id, created.ref, created.lineage, created.deadline, created.state, null, created.created_at);
        this.sql.exec("INSERT OR REPLACE INTO agent_vm_boot VALUES(?,?,?)", branch.branch, JSON.stringify(body), seq);
        if (prior?.state === "stopped") {
          this.sql.exec("DELETE FROM agent_vm_renewal WHERE vm_id=?", prior.vm_id);
          this.sql.exec("DELETE FROM agent_vm_shell_used WHERE vm_id=?", prior.vm_id);
        }
      });
    }

    const until = Date.now() + 60_000;
    try {
      await tierRequest(this.env, { method: "POST", path: "/v1/vms", claims: claims(vm), body, idempotencyKey: vm.vm_id });
    } catch (error) {
      if (error instanceof TierError && error.status === 400) this.stop(vm.vm_id);
      throw error;
    }
    // MONEY: make sure pulled usage starts even if this VM ends before an exec can attach.
    await startUsagePoller(this.env);
    for (let delay = 100; ; delay = Math.min(2_000, delay * 2)) {
      const status = await this.request<Status>(vm, "GET", "", undefined, Math.max(1, until - Date.now()));
      if (status.phase === "ended" || this.row(vm.branch)?.state === "stopped") {
        this.stop(vm.vm_id);
        throw new Error(`Bash VM ended during startup (${status.code ?? "stopped"})`);
      }
      if (status.phase === "running") break;
      if (Date.now() >= until) throw new Error("Bash VM did not start within 60 seconds");
      await sleep(Math.min(delay, until - Date.now()));
    }
    let shell: string;
    try {
      // One shell per VM: the VM id is the key, so a retry after a crash gets the same shell (#1071, L104).
      ({ shell } = await this.request<{ shell: string }>(vm, "POST", "/shells", undefined, undefined, vm.vm_id));
    } catch (error) {
      if (isTier(error, 409, "not_running")) this.stop(vm.vm_id);
      throw error;
    }
    await this.arm(Date.now() + 1_000);
    const running = this.sql.exec<Vm>("UPDATE agent_vms SET state='running', shell=? WHERE vm_id=? AND state='creating' RETURNING *", shell, vm.vm_id).toArray()[0];
    if (!running) throw new Error("Bash VM stopped during startup");
    console.log(JSON.stringify({ type: "bash_vm_created", vm: vm.vm_id, runningMs: Date.now() - vm.created_at }));
    return running;
  }

  completed(key: string) { return this.receipt(key)?.result; }

  async execute(conf: Config, branch: Branch, key: string, callId: string, requestId: string, args: Args): Promise<SessionResult> {
    return this.serial(branch.branch, async () => {
      const previous = this.receipt(key);
      if (previous?.result) return previous.result;
      await this.checkpoints(branch.branch);
      let intent = previous?.intent;
      const replay = !!intent;
      for (let attempt = 0; ; attempt++) {
        if (!intent) {
          const vm = await this.ready(conf, branch);
          // An abandoned invocation can no longer be safely reissued after later commands may have evicted its guest receipt.
          this.sql.exec(`UPDATE agent_vm_calls SET receipt=? WHERE branch=? AND id<>? AND json_type(receipt,'$.intent')='object'`,
            JSON.stringify({ result: { stdout: "", stderr: "", exitCode: null, timedOut: false, truncated: true, error: "Bash result was interrupted and could not be recovered" } }), branch.branch, key);
          const first = !this.sql.exec("SELECT 1 FROM agent_vm_shell_used WHERE vm_id=?", vm.vm_id).toArray().length;
          // Keep the call ID on the wire whenever it fits the tier's mount alphabet.
          const execId = /^[\w.-]{1,96}$/.test(callId) && callId !== "." && callId !== ".." ? callId : hash(key);
          const timeoutS = Math.min(600, Math.max(1, args.timeoutSeconds ?? 120));
          const body = { execId, command: args.command, shell: vm.shell!, cwd: args.cwd ?? (first ? BASH_WORKDIR : undefined), timeoutS };
          intent = { vm, first, body };
          this.save(key, branch.branch, { intent });
        }
        const { vm, first, body } = intent;
        const started = Date.now();
        const path = "/v1/vms/" + vm.vm_id + "/exec";
        let streamed: Awaited<ReturnType<typeof bashStream>>;
        try {
          this.savedHeads.delete(vm.vm_id);
          streamed = await bashStream(this.env, { method: "POST", path, body, claims: claims(vm) }, body.execId, started + (body.timeoutS + 30) * 1000, () => {
            if (first) console.log(JSON.stringify({ type: "bash_vm_first_output", vm: vm.vm_id, firstOutputMs: Date.now() - vm.created_at }));
          });
        } catch (error) {
          if (!isTier(error, 409, "not_running")) throw error;
          this.stop(vm.vm_id);
          if (replay || attempt > 0) throw new Error("Bash VM stopped before the result could be recovered");
          this.save(key, branch.branch, {});
          intent = undefined;
          continue;
        }
        const { bytes, ms } = streamed;
        const result: SessionResult = streamed.result;
        const checkpoint = { vm, callId, requestId, message: (`bash: ${body.command.split(/\r?\n/, 1)[0]}`).slice(0, 72), time: Date.now() };
        // The wake is durable before the receipt leaves a pending checkpoint.
        await this.arm(Date.now() + 1_000);
        this.storage.transactionSync(() => {
          const warning = this.sql.exec<{ reason: string }>(
            "DELETE FROM agent_vm_checkpoint_warnings WHERE branch=? RETURNING reason", branch.branch,
          ).toArray()[0];
          if (warning) {
            result.checkpointWarning = `Warning: files from your previous command were not saved to your branch: ${warning.reason}\n`;
            result.stdout = result.checkpointWarning + result.stdout;
          }
          this.sql.exec("INSERT OR IGNORE INTO agent_vm_shell_used VALUES(?)", vm.vm_id);
          this.save(key, branch.branch, { result, checkpoint });
        });
        this.scheduleCheckpoint(branch.branch);
        console.log(JSON.stringify({ type: "bash_exec", vm: vm.vm_id, callId, ms: ms ?? Date.now() - started, exitCode: result.exitCode, truncated: result.truncated, bytes }));
        return result;
      }
    });
  }

  runningFiles(lineage: string, ref: string): VmFiles | undefined {
    const branch = JSON.stringify([lineage, ref]);
    const vm = this.row(branch);
    if (vm?.state !== "running") return;
    const ensureRunning = () => {
      const current = this.row(branch);
      if (current?.state !== "running" || current.vm_id !== vm.vm_id) throw new HttpError(409, "the VM stopped; retry");
    };
    const onVm = <T>(work: () => Promise<T>) => this.serial(branch, async () => {
      ensureRunning();
      try {
        const value = await work();
        ensureRunning();
        return value;
      } catch (error) {
        if (vmStopped(error))
          this.stop(vm.vm_id);
        ensureRunning();
        throw error;
      }
    });
    return guestFiles(
      (execId, command, stdin, mutation) => onVm(async () => {
        const timeoutS = 120;
        const body = { execId, command, stdin, cwd: BASH_WORKDIR, timeoutS };
        const checkpoint = { vm, callId: execId, message: "Save VM file changes", time: Date.now() };
        const key = JSON.stringify(["vmfiles", vm.vm_id]);
        if (mutation) {
          await this.arm(Date.now() + 1_000);
          this.savedHeads.delete(vm.vm_id);
          // Record the pending save before dispatch. The mutation can succeed even if its response is lost.
          this.save(key, branch, { checkpoint });
        }
        try {
          const { result } = await bashStream(this.env, {
            method: "POST", path: "/v1/vms/" + vm.vm_id + "/exec", body, claims: claims(vm),
          }, execId, Date.now() + (timeoutS + 30) * 1000, () => {}, VM_FILES_STDOUT_BYTES);
          return result;
        } finally {
          if (mutation) this.scheduleCheckpoint(branch);
        }
      }),
      () => onVm(async () => {
        await this.checkpoints(branch);
        ensureRunning();
        const saved = this.savedHeads.get(vm.vm_id);
        if (saved) return saved;
        const reply = await this.request<Head & { changed: boolean }>(vm, "POST", "/checkpoint", {
          message: "Save VM file changes", time: Date.now(),
        });
        if (reply.changed) this.recordHead(vm, reply);
        return this.rememberHead(vm, reply);
      }),
    );
  }

  private scheduleCheckpoint(branch: string) {
    this.defer(sleep(0).then(() => this.serial(branch, () => this.checkpoints(branch))).catch(() => this.arm(Date.now() + 1_000)));
  }

  private rememberHead(vm: Vm, { version, tree }: Head) {
    const head = { version, tree };
    const current = this.row(vm.branch);
    if (current?.state === "running" && current.vm_id === vm.vm_id) this.savedHeads.set(vm.vm_id, head);
    return head;
  }

  private async checkpoints(branch: string) {
    const rows = this.sql.exec<{ id: string; receipt: string }>("SELECT id,receipt FROM agent_vm_calls WHERE branch=? AND checkpoint=1 ORDER BY rowid", branch).toArray();
    for (const row of rows) {
      const { result, checkpoint } = JSON.parse(row.receipt) as { result?: SessionResult; checkpoint: Checkpoint };
      const { vm, callId, requestId, message, time } = checkpoint;
      const started = Date.now();
      let failure = result?.checkpointError;
      let changed: boolean | undefined;
      try {
        if (!result?.checkpointError) {
          if (!checkpoint.started) this.save(row.id, branch, { result, checkpoint: { ...checkpoint, started: true } });
          const reply = await this.request<Head & { diff: unknown; changed: boolean }>(vm, "POST", "/checkpoint", { message, trailers: { "Camel-Tool-Call": callId }, time });
          changed = reply.changed;
          this.rememberHead(vm, reply);
          if (changed) this.recordHead(vm, reply);
          else if (checkpoint.started) {
            const status = await this.request<Status>(vm, "GET");
            if (status.lastCheckpoint?.version === reply.version) this.recordHead(vm, status.lastCheckpoint);
          }
        }
      } catch (error) {
        const reason = (error instanceof TierError ? error.code : "checkpoint_failed").replace(/[\r\n]+/g, " ");
        this.savedHeads.delete(vm.vm_id);
        if (vmStopped(error))
          this.stop(vm.vm_id);
        failure = reason;
        if (result) result.checkpointError = reason;
        // Persist the warning and the bash failure together, before publishing the event.
        this.storage.transactionSync(() => {
          this.sql.exec("INSERT OR REPLACE INTO agent_vm_checkpoint_warnings VALUES(?,?)", branch, reason);
          if (result) this.save(row.id, branch, { result, checkpoint });
        });
      }
      if (requestId && result?.checkpointError) {
        await this.checkpointFailed(callId, requestId, result.checkpointError);
      }
      if (result) this.save(row.id, branch, { result });
      else this.sql.exec("DELETE FROM agent_vm_calls WHERE id=?", row.id);
      console.log(JSON.stringify({ type: "bash_checkpoint", vm: vm.vm_id, callId, ms: Date.now() - started, changed, error: failure }));
    }
  }

  private recordHead(vm: Vm, { version, tree }: Head) {
    this.sql.exec("INSERT OR REPLACE INTO agent_vm_heads VALUES(?,?,?)", vm.branch, version, tree);
  }

  deadline() {
    if (!bashEnabled(this.env)) return Infinity;
    if (this.sql.exec("SELECT 1 FROM agent_vm_calls WHERE checkpoint=1 LIMIT 1").toArray().length) return Date.now() + 1_000;
    // MONEY: a refusal keeps the original lease; check for tier expiry at that deadline.
    return this.sql.exec<{ at: number | null }>(`SELECT MIN(coalesce(r.next, v.deadline - ?)) AS at
      FROM agent_vms v LEFT JOIN agent_vm_renewal r ON v.vm_id=r.vm_id WHERE v.state='running'`, LEASE_MS - RENEW_MS).one().at ?? Infinity;
  }

  async wake(conf: Config) {
    if (!bashEnabled(this.env)) return;
    for (const { branch } of this.sql.exec<{ branch: string }>("SELECT DISTINCT branch FROM agent_vm_calls WHERE checkpoint=1").toArray())
      this.defer(this.serial(branch, () => this.checkpoints(branch)));
    if (this.renewing) return;
    this.renewing = true;
    try { await this.renew(conf); }
    finally { this.renewing = false; }
  }

  private async renew(conf: Config) {
    // MONEY: renew independently of a running command or a checkpoint on this branch.
    const due = this.sql.exec<Vm & { refused: number; proposed: number | null }>(`SELECT v.*,coalesce(r.refused,0) AS refused,r.proposed
      FROM agent_vms v LEFT JOIN agent_vm_renewal r ON v.vm_id=r.vm_id
      WHERE v.state='running' AND coalesce(r.next,v.deadline - ?)<=?`, LEASE_MS - RENEW_MS, Date.now()).toArray();
    await Promise.all(due.map(async vm => {
      const retry = (next: number, refused = vm.refused, proposed = vm.proposed) =>
        this.sql.exec("INSERT OR REPLACE INTO agent_vm_renewal VALUES(?,?,?,?)", vm.vm_id, next, refused, proposed);
      try {
        if (vm.refused) {
          const status = await this.request<Status>(vm, "GET");
          if (status.phase === "ended") this.stop(vm.vm_id);
          else retry(Date.now() + RENEW_MS);
          return;
        }
        if (!await this.credit(conf)) {
          retry(Math.max(Date.now() + 1, vm.proposed ?? vm.deadline), 1, null);
          return;
        }
        const current = this.row(vm.branch);
        if (current?.state !== "running" || current.vm_id !== vm.vm_id) return;
        // MONEY: persist the extension before sending it. An ambiguous response replays the same deadline.
        const proposed = vm.proposed ?? Date.now() + LEASE_MS;
        retry(Date.now() + RENEW_MS, 0, proposed);
        const { deadline } = await this.request<{ deadline: number }>(vm, "POST", "/deadline", { deadline: proposed });
        this.storage.transactionSync(() => {
          this.sql.exec("UPDATE agent_vms SET deadline=? WHERE vm_id=? AND state='running'", deadline, vm.vm_id);
          this.sql.exec("DELETE FROM agent_vm_renewal WHERE vm_id=?", vm.vm_id);
        });
      } catch (error) {
        if (vmStopped(error)) this.stop(vm.vm_id);
        else {
          this.sql.exec("UPDATE agent_vm_renewal SET next=? WHERE vm_id=?", Date.now() + RENEW_MS, vm.vm_id);
          this.sql.exec("INSERT OR IGNORE INTO agent_vm_renewal VALUES(?,?,?,?)", vm.vm_id, Date.now() + RENEW_MS, vm.refused, vm.proposed);
          console.error(JSON.stringify({ type: "bash_renewal_failed", vm: vm.vm_id, code: error instanceof TierError ? error.code : undefined }));
        }
      }
    }));
  }
}

export function bashTool(runtime: AgentRuntime) {
  return defineTool({
    name: "bash",
    description: `Runs a shell command on your machine, a Linux VM attached to your current branch, and returns its stdout, stderr and exit code. Files under ${BASH_WORKDIR} are saved to your branch after every command; everything else on the machine (installed packages, /tmp, the shell's environment) is lost when it sleeps. The machine sleeps after about 10 seconds with no command running, and a sleep ends every process, including background \`&\` jobs and servers; a command that is still running keeps it awake. The first command after a sleep waits a few seconds while the machine starts. Output over 32 KiB per stream is cut in the middle, and the result says how many bytes were dropped.`,
    parameters: obj({
      command: str({ description: "The command to run in bash, in a persistent shell: the working directory and environment carry over between calls until the machine sleeps." }),
      cwd: opt(str({ description: "Directory to run in; defaults to the shell's current directory." })),
      timeoutSeconds: opt(int({ description: "Kill the command after this many seconds; the result then says timedOut. (1–600, default 120)" })),
    }),
    replay: "safe",
    async execute(args, api) {
      const conf = await runtime.config();
      const run = await runtime.currentRun(api);
      const key = JSON.stringify([run.id, api.callId]);
      let result = runtime.bashSessions.completed(key);
      if (!result) {
        const mount = workspaceMount(conf.tenantId, conf.id, (conf.config.mounts ?? []) as Mount[]);
        if (mount.mode !== "rw" || (mount.subpath && mount.subpath !== "/")) throw new Error("Bash requires a writable workspace root");
        const { lineage, repo } = await repoContext(runtime.env as RepoEnv, conf.tenantId, mount.repo, `agent:${conf.id}`);
        if (!(repo instanceof HttpRepoClient)) throw new Error("Bash requires a camel-fs workspace");
        const ref = repo.tierRefName(mount.ref ?? "main");
        try {
          result = await runtime.bashSessions.execute(conf, { branch: JSON.stringify([lineage, ref]), lineage, ref }, key, api.callId, run.id, args);
        } catch (error) {
          if (error instanceof TierError && error.status === 429) throw new HttpError(429, computeBusy);
          throw error;
        }
      }
      const { checkpointWarning = "", ...structuredOutput } = result;
      const text = checkpointWarning + JSON.stringify({ ...structuredOutput, stdout: structuredOutput.stdout.slice(checkpointWarning.length) });
      return { output: [{ type: "text", text }], structuredOutput, isError: !!structuredOutput.error };
    },
  });
}
