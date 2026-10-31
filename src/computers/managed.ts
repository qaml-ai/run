import { randomUUID } from "node:crypto";
import type { Accounts } from "../accounts.ts";
import { resolveKey } from "../capabilities/router.ts";
import type { CreditHolds } from "../credit-holds.ts";
import { transaction, type Db } from "../db.ts";
import { creditError, type EndUserCredits } from "../end-user-credits.ts";
import { HttpError } from "../http.ts";
import type { Outbound } from "../outbound.ts";
import { MICROS, micros as toMicros } from "../pricing.ts";
import type { ToolDefinition } from "../protocol.ts";
import { TOOL_DEADLINES } from "../tool-servers.ts";
import type { ToolContext } from "../volume-tools.ts";
import { Workspaces } from "../workspaces.ts";
import { machineSetup, signatures } from "./abuse.ts";
import { bounded, output, quote } from "./providers.ts";
import type { ComputerTransfers } from "./transfers.ts";

/**
 * Managed computers: a machine on the platform's Boat account for an agent, billed to credit at Boat's price. Boat keeps
 * most of the state. A create takes the row's id as its idempotency key, so a lost answer finds the same machine, and a
 * machine past its TTL deletes itself, so nothing here expires anything. One row per machine says whose it is and what
 * has been charged; each pass reads what Boat reports and charges the difference.
 */

const NAME = "boat" as const;
/** Boat's list price for a small machine (2 vCPU, 4 GB) per hour: what it reports is at this, and AGENT_PRICE_COMPUTER_HOUR_USD scales it. */
const BOAT_SMALL_HOUR = toMicros(0.018);
/** How long a command may run, by default and at most; how long a computer stays after its latest command unless its connection says, and at most. */
export const MANAGED = { provider: NAME, commandSeconds: 1800, defaultCommandSeconds: 600, idleSeconds: 7200, maxSeconds: 86400, dailySeconds: 86400 };
/** Waits before trying a provider that made nothing again, by attempt. */
const START_RETRIES: Record<string, number[]> = { out_of_capacity: [5000, 10000], no_ready_machine: [5000, 10000] };
/** The most to wait for a start the provider says it will take after this long. */
const START_WAIT_MS = 15000;
/** Boat's refusals that made nothing. */
const UNAVAILABLE = new Set(["rate_limited", "limit_reached", "member_limit_reached", "out_of_capacity", "no_ready_machine", "billing_required"]);
/** The longest a command waits on one request; longer ones run detached and are polled. */
const WAIT_SECONDS = 590;
/** A row this new may not be in a listing yet. A machine this old with no row is a leak; a row with no machine this old never got one. */
const SETTLE_MS = 10 * 60_000;
const LISTING_GRACE_MS = 60_000;
/** The labels on a machine: this runtime's, so another on the same account is left alone, then its row and tenant, which an abuse report leads to. */
const RUNTIME_LABEL = "camelrun-runtime";
const NO_UNIT = "CAMEL_NO_UNIT";
const GONE_STATES = ["stopped", "archived", "deleted", "gone"];
const PAGE = 200;

/** What Boat reports for a machine: its id, the row it was made for, and what it has cost in `since`'s period. */
export type Machine = { id: string; computer: string; tenant: string; createdAt: number; since: string; seconds: number; dollars: number };
export type Refused = { code: string; retryAfterMs?: number };
export class BoatRefused extends Error {
  readonly refused: Refused;
  constructor(refused: Refused) { super(refused.code); this.refused = refused; }
}
export interface ManagedMachines {
  create(computer: string, tenant: string, ttlSeconds: number): Promise<{ id: string }>;
  extend(machine: string, ttlSeconds: number): Promise<void>;
  remove(machine: string): Promise<void>;
  /** The machines of this runtime on this account, what they cost as of now; `computer` narrows it to one row's. */
  list(computer?: string): Promise<Machine[]>;
  run(machine: string, command: string, timeoutSeconds: number): Promise<{ exitCode: number; stdout: string; stderr: string; truncated: boolean }>;
}

/**
 * The command, in `$d/command` (bounded's directory), in a transient unit, so everything it started ends with it, and at
 * `seconds` it exits 124: a managed computer is for work in the foreground. It is in a file because systemd expands `$` and
 * `%` in a unit's arguments. A machine whose agent gave up sudo runs it plainly, and says so.
 */
export function unitCommand(seconds: number) {
  const bash = `timeout -k 2 ${seconds} bash -l "$d/command"`;
  return `if sudo -n true 2>/dev/null; then sudo -n systemd-run --quiet --wait --pipe --collect --uid="$(id -u)" --gid="$(id -g)" --working-directory="$PWD" --property=RuntimeMaxSec=${seconds + 3} --setenv=HOME="$HOME" --setenv=PATH="$PATH" --setenv=TERM=dumb ${bash}; else echo ${NO_UNIT} >&2; ${bash}; fi`;
}

/** Some Boat machines' own shell clears the screen on its way out, around the command's output: not the command's. */
const answered = (exitCode: number, stdout: string, stderr: string) => output(exitCode, stdout.replace(/\x1b\[3J$/, ""), stderr.replace(/^TERM environment variable not set\.\n/, ""));

/** Boat's API for this runtime's machines (`runtime` names it in their labels). `setup` runs before anyone uses a machine. */
export function boatMachines(apiKey: string, outbound: Outbound, runtime: string, setup?: string): ManagedMachines {
  const request = async (path: string, init: { body?: unknown; method?: string; headers?: Record<string, string>; waitSeconds?: number; missingOk?: boolean } = {}) => {
    const { body, method = "POST", headers = {}, waitSeconds = 20, missingOk = false } = init;
    const response = await outbound.fetch(`https://boat.dev/api/v1${path}`, {
      method, secrets: { Authorization: `Bearer ${apiKey}` }, headers: { "Content-Type": "application/json", ...headers }, ...body === undefined ? {} : { body: JSON.stringify(body) },
      timeoutMs: (waitSeconds + 10) * 1000, maxBytes: 8 * 1024 * 1024, maxRedirects: 0,
    });
    if (response.ok) return response.status === 204 ? {} : await response.json() as any;
    if (missingOk && response.status === 404) { await response.body?.cancel(); return null; }
    const value = await response.json().catch(() => ({})) as any, code = value.code ?? value.error?.code;
    const next = Date.parse(value.error?.details?.nextStartAt ?? value.nextStartAt);
    if (UNAVAILABLE.has(code) || response.status === 401 || response.status === 403) throw new BoatRefused({ code: code ?? `http_${response.status}`, ...Number.isFinite(next) ? { retryAfterMs: Math.max(0, next - Date.now()) } : {} });
    throw new Error(`Computer provider HTTP ${response.status}`);
  };
  const label = (name: string, value: string) => `label=${encodeURIComponent(`${name}=${value}`)}`;
  const machines: ManagedMachines = {
    async create(computer, tenant, ttlSeconds) {
      const created = await request("/sandboxes", {
        headers: { "Idempotency-Key": computer }, waitSeconds: 45,
        body: { type: "small", ttlSeconds, noEnv: true, snapshots: false, monitoring: false, labels: { [RUNTIME_LABEL]: runtime, computer, tenant } },
      });
      const id = created.sandbox.id as string;
      if (setup && (await machines.run(id, setup, 60)).exitCode !== 0) throw new Error("Computer setup failed");
      return { id };
    },
    async extend(machine, ttlSeconds) { await request(`/sandboxes/${machine}`, { method: "PATCH", body: { ttlSeconds } }); },
    async remove(machine) { await request(`/sandboxes/${machine}`, { method: "DELETE", headers: { "X-ASCII-Confirm-Delete": machine }, missingOk: true }); },
    async list(computer) {
      const found: Machine[] = [];
      for (let cursor: string | undefined; ;) {
        const page = await request(`/sandboxes?include=cost&limit=${PAGE}&${label(RUNTIME_LABEL, runtime)}${computer ? `&${label("computer", computer)}` : ""}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, { method: "GET" });
        // A machine missing from a listing has ended, so a listing is whole or it is no listing: anything short of that throws.
        const more = page.pageInfo?.hasMore;
        if (!Array.isArray(page.sandboxes) || typeof more !== "boolean" || (more && (page.sandboxes.length < PAGE || !page.pageInfo.nextCursor || page.pageInfo.nextCursor === cursor))) throw new Error("Incomplete computer listing");
        for (const box of page.sandboxes) {
          if (GONE_STATES.includes(box.state) || !box.labels?.computer) continue;
          const { since, seconds, dollars } = box.cost ?? {};
          if (typeof since !== "string" || !since || !Number.isFinite(seconds) || !Number.isFinite(dollars)) throw new Error("Incomplete computer listing");
          found.push({ id: box.id, computer: box.labels.computer, tenant: box.labels.tenant, createdAt: Date.parse(box.createdAt), since, seconds, dollars });
        }
        if (!more) return found;
        cursor = page.pageInfo.nextCursor;
      }
    },
    async run(machine, command, timeoutSeconds) {
      const script = bounded(unitCommand(timeoutSeconds), `printf %s ${quote(command)} > "$d/command"; `);
      if (timeoutSeconds <= WAIT_SECONDS) {
        const done = await request(`/sandboxes/${machine}/commands`, { body: { command: script, timeoutSeconds: timeoutSeconds + 5 }, waitSeconds: timeoutSeconds + 5 });
        return answered(done.exitCode, done.stdout ?? "", done.stderr ?? "");
      }
      const { processId } = await request(`/sandboxes/${machine}/commands`, { body: { command: script, detached: true } });
      for (const until = Date.now() + (timeoutSeconds + 15) * 1000; Date.now() < until; await new Promise(resolve => setTimeout(resolve, 2000))) {
        const state = await request(`/sandboxes/${machine}/commands/${processId}`, { method: "GET" });
        if (state.status === "lost") throw new Error("Remote command outcome uncertain");
        if (!state.running) return answered(state.exitCode, state.stdout ?? "", state.stderr ?? "");
      }
      await request(`/sandboxes/${machine}/commands/${processId}`, { method: "DELETE", missingOk: true });
      throw new Error("Remote command outcome uncertain");
    },
  };
  return machines;
}

/** Its tools say what a managed computer is for. */
export function managedTools(common: ToolDefinition[], shell: ToolDefinition[], tool: (name: string, description: string, props?: object, required?: string[]) => ToolDefinition, text: object): ToolDefinition[] {
  return [
    ...common.map(t => t.name === "computer_start" ? tool("computer_start", "Start your attached computer or return its current session. Its files stay until it is released: 2 hours after your latest command, or 24 hours after it started. A new session after that starts empty.")
      : t.name === "computer_status" ? tool("computer_status", "Read your computer's session and when it will be released; does not start one.") : t),
    ...shell.map(t => t.name !== "computer_exec" ? t : { ...tool("computer_exec", `Call computer_start first. Run a shell command in your attached remote Linux computer, never on the camelRun host. Inspect exitCode. This computer is for short-lived work, so a background process doesn't keep running after its command ends. Run work in the foreground and wait for it, with timeoutSeconds long enough for it (default ${MANAGED.defaultCommandSeconds}, at most ${MANAGED.commandSeconds}). Files stay until the computer is released.`, { command: text, timeoutSeconds: { type: "integer", minimum: 1, maximum: MANAGED.commandSeconds } }, ["command"]), timeoutMs: TOOL_DEADLINES.maxTotalMs }),
  ];
}

const unavailableMessage = ({ code, retryAfterMs }: Refused) => {
  const nothing = "Nothing was created or charged.";
  if (code === "rate_limited") return `Too many computers were started just now. ${nothing} Call computer_start again${retryAfterMs ? ` in about ${Math.ceil(retryAfterMs / 1000)} seconds` : " in a few minutes"}; if it keeps failing, tell the user computers are busy.`;
  if (code === "limit_reached" || code === "member_limit_reached") return `Too many computers are running right now. ${nothing} Call computer_start again in a few minutes; if it keeps failing, tell the user computers are busy.`;
  if (code === "out_of_capacity" || code === "no_ready_machine") return `The computer provider has no machines free right now. ${nothing} Call computer_start again in a couple of minutes; if it keeps failing, tell the user computers are unavailable for now.`;
  return `Computers are unavailable right now. ${nothing} Do not retry in this turn. Tell the user computers are unavailable and that the runtime's operator needs to look at it.`;
};

const publicSession = (row: any) => row ? ({ id: row.id, provider: NAME, workspaceId: row.workspace, state: row.ended_at ? "closed" : row.machine ? "active" : "starting", recoveryRequired: false, createdAt: Number(row.created_at), expiresAt: Number(row.deadline), closedAt: row.ended_at === null ? null : Number(row.ended_at) }) : null;
const id = () => `cmp_${randomUUID().replaceAll("-", "")}`;

export class ManagedComputers {
  readonly options: {
    db: Db;
    accounts: Pick<Accounts, "billing" | "tenants" | "providerKey" | "recordUsageIn" | "usageCommitted">;
    outbound: Outbound;
    /** Whether agents may have managed computers (AGENT_MANAGED_COMPUTERS). */
    enabled: boolean;
    /** What names this runtime on its machines: its public URL. */
    runtime: string;
    transfers?(): ComputerTransfers | undefined;
    endUsers?(): Pick<EndUserCredits, "reserve" | "extend" | "settleHold" | "release" | "renew"> | undefined;
    credit?(): Pick<CreditHolds, "available"> | undefined;
    /** Who pays for the agent's current run, where the tenant meters its end users. */
    payer?(agent: string): { id: string; bucket: string } | undefined;
    machines?(apiKey: string): ManagedMachines;
    now(): number;
    sleep?(ms: number): Promise<void>;
  };
  constructor(options: ManagedComputers["options"]) { this.options = options; }
  private get db() { return this.options.db; }
  private machines(apiKey: string) { return this.options.machines?.(apiKey) ?? boatMachines(apiKey, this.options.outbound, this.options.runtime, machineSetup()); }
  private async keyFor(row: { tenant: string; platform: boolean }) {
    const key = row.platform ? this.options.accounts.tenants.platformKey(NAME) : (await this.options.accounts.providerKey(row.tenant, NAME))?.key;
    if (!key) throw new Error("No key for this computer");
    return key;
  }
  private log(type: string, fields: Record<string, unknown>) { console.error(JSON.stringify({ type, ...fields })); }
  private async open(connection: string) { return (await this.db.query("select * from managed_computers where connection=$1 and ended_at is null", [connection])).rows[0]; }
  /** The latest row of a connection, as the API shows a session. */
  async session(connection: string) { return publicSession((await this.db.query("select * from managed_computers where connection=$1 order by created_at desc limit 1", [connection])).rows[0]); }
  async usage(tenant: string) {
    return (await this.db.query(`select workspace,'${NAME}' as provider,count(*)::integer as sessions,sum(greatest(0,coalesce(ended_at,least($2,deadline))-created_at))/1000.0 as seconds,(sum(charged_micros)/${MICROS})::float8 as "costUsd" from managed_computers where tenant=$1 group by workspace`, [tenant, this.options.now()])).rows;
  }

  /** A tool call on a managed connection. A call's key is recorded before it runs, so a retry answers from it, or says its outcome is unknown. */
  async call(connection: any, tenant: string, agent: string, name: string, args: Record<string, any>, requestKey: string, hash: string, files?: Pick<ToolContext, "mounts" | "onWrite">) {
    const { db } = this;
    if (name === "computer_status") return publicSession(await this.open(connection.id));
    const inserted = (await db.query("insert into computer_operations(connection,key,input_hash,state,tenant) values($1,$2,$3,'pending',$4) on conflict do nothing", [connection.id, requestKey, hash, tenant])).rowCount;
    if (!inserted) {
      const old = (await db.query("select * from computer_operations where connection=$1 and key=$2", [connection.id, requestKey])).rows[0];
      if (old.input_hash !== hash) throw new HttpError(409, "Retried computer operation changed");
      if (old.state !== "completed") throw new HttpError(409, "Previous operation has an uncertain outcome; inspect status before retrying");
      return old.result;
    }
    try {
      const result = name === "computer_start" ? await this.start(connection, tenant, agent)
        : name === "computer_stop" ? await this.stopOpen(connection.id)
        : await this.command(connection, tenant, agent, name, args, requestKey, files);
      await db.query("update computer_operations set state='completed',result=$3 where connection=$1 and key=$2", [connection.id, requestKey, JSON.stringify(result)]);
      return result;
    } catch (error) {
      await db.query("update computer_operations set state='uncertain' where connection=$1 and key=$2", [connection.id, requestKey]);
      throw error;
    }
  }

  private async start(connection: any, tenant: string, agent: string) {
    const now = this.options.now();
    let row = await this.open(connection.id);
    if (row?.machine && Number(row.deadline) > now) return publicSession(row);
    if (row && Number(row.deadline) <= now) { await this.end(row); row = undefined; }
    if (!this.options.enabled) throw new HttpError(403, "Managed computers are not available on this runtime. Do not retry in this turn; tell the user.");
    row ??= await this.newRow(connection, tenant, agent);
    const machines = this.machines(await this.keyFor(row)), started = Date.now();
    for (let attempt = 0; ; attempt++) {
      try {
        const { id: machine } = await machines.create(row.id, tenant, connection.lease_seconds);
        await this.db.query("update managed_computers set machine=$2 where id=$1", [row.id, machine]);
        this.log("computer_started", { tenant, agent, computer: row.id, ms: Date.now() - started });
        return publicSession({ ...row, machine });
      } catch (error) {
        // Anything but a refusal may have made a machine: the row stays, and the next start, or the next pass, finds it by its key.
        if (!(error instanceof BoatRefused)) { this.log("computer_create_failed", { tenant, agent, computer: row.id }); throw new HttpError(502, "The computer did not answer in time. Nothing is charged until it starts. Call computer_start again; if it keeps failing, tell the user computers are unavailable for now."); }
        const { refused } = error;
        this.log("computer_unavailable", { tenant, agent, computer: row.id, code: refused.code, attempt, ...refused.retryAfterMs !== undefined ? { retryAfterMs: refused.retryAfterMs } : {} });
        const wait = refused.retryAfterMs !== undefined ? (attempt === 0 && refused.retryAfterMs <= START_WAIT_MS ? refused.retryAfterMs : undefined) : START_RETRIES[refused.code]?.[attempt];
        if (wait === undefined) {
          await this.end(row);
          throw new HttpError(refused.code === "rate_limited" ? 429 : 503, unavailableMessage(refused), "COMPUTER_UNAVAILABLE", { reason: refused.code });
        }
        await (this.options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(wait);
      }
    }
  }

  /**
   * What a new computer needs: that it may start, on which key, and its end user's hold. On the platform's key an account
   * that has never bought credit may not start one, and spent credit, or credit its model calls hold all of, refuses it.
   */
  private async newRow(connection: any, tenant: string, agent: string) {
    const { accounts, payer, endUsers, credit, now } = this.options;
    if ((await this.db.query("select 1 from computer_blocks where tenant=$1", [tenant])).rowCount) throw new HttpError(403, "Computers are turned off for this account. Nothing was created or charged. Do not retry in this turn; tell the user.");
    const credential = await resolveKey(accounts, tenant, NAME);
    if (!credential) throw new HttpError(503, "Computers are unavailable on this runtime. Do not retry in this turn; tell the user.");
    let held: { id: string; endUser: string; bucket: string } | undefined;
    if (credential.platform) {
      if (await accounts.billing.onFreeCredit(tenant)) throw new HttpError(403, "Computers are available once this account has bought credit. Nothing was created or charged. Do not retry in this turn; tell the user.");
      const available = await credit?.()?.available(tenant, now());
      if (available !== undefined && available <= 0) throw new HttpError(402, "This account's credit is spent or held by calls in flight, so a computer can't start. Nothing was created or charged. Do not retry in this turn; tell the user.", "INSUFFICIENT_CREDIT");
      const user = payer?.(agent), users = endUsers?.();
      if (user && users) {
        const hold = randomUUID(), want = Math.ceil(connection.lease_seconds * accounts.billing.pricing.computerHour / 3600);
        const reserved = await users.reserve(tenant, user.id, user.bucket, { id: hold, want, min: want }, now());
        if (reserved?.refused) throw creditError(reserved.refused);
        if (reserved) held = { id: hold, endUser: user.id, bucket: user.bucket };
      }
    }
    const at = now(), workspace = await new Workspaces(this.db).current(tenant, "agent", agent);
    const row = (await this.db.query("insert into managed_computers(id,tenant,agent,connection,workspace,platform,hold,end_user,bucket,deadline,created_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) on conflict do nothing returning *",
      [id(), tenant, agent, connection.id, workspace?.workspace ?? null, credential.platform, held?.id ?? null, held?.endUser ?? null, held?.bucket ?? null, at + connection.lease_seconds * 1000, at])).rows[0];
    if (row) return row;
    // A start at the same moment made it: this one uses its row, and so its machine.
    if (held) await endUsers?.()?.release(held.id);
    return this.open(connection.id);
  }

  private async command(connection: any, tenant: string, agent: string, name: string, args: Record<string, any>, requestKey: string, files?: Pick<ToolContext, "mounts" | "onWrite">) {
    const row = await this.open(connection.id);
    if (!row?.machine || Number(row.deadline) <= this.options.now()) throw new HttpError(409, "Call computer_start before using the computer");
    const transfer = name === "computer_upload" || name === "computer_download";
    const command = transfer ? "true" : fileCommand(name, args) ?? args.command;
    if (typeof command !== "string" || !command || command.length > 32000) throw new HttpError(400, "Invalid command");
    const timeout = transfer ? 120 : args.timeoutSeconds ?? MANAGED.defaultCommandSeconds;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > MANAGED.commandSeconds) throw new HttpError(400, `Command timeout must be 1–${MANAGED.commandSeconds} seconds`);
    const found = signatures([args.command, args.content].filter(part => typeof part === "string").join("\n"));
    if (found.length) this.log("computer_signature", { tenant, agent, computer: row.id, tool: name, signatures: found });
    const machines = this.machines(await this.keyFor(row));
    const deadline = await this.keep(connection, row, machines);
    const seconds = Math.max(1, Math.min(timeout, Math.floor((deadline - this.options.now()) / 1000)));
    try {
      const value = transfer ? await this.transfer(tenant, agent, name, args, machines, row.machine, seconds, requestKey, files) : await this.runIn(machines, row, command, seconds);
      return storable(value);
    } catch (error) {
      if (transfer && error instanceof HttpError) throw error;
      throw new HttpError(502, "Computer command failed; outcome may be uncertain");
    }
  }

  private async runIn(machines: ManagedMachines, row: any, command: string, seconds: number) {
    const done = await machines.run(row.machine, command, seconds);
    if (!done.stderr.startsWith(`${NO_UNIT}\n`)) return done;
    // Without its unit a background process outlives its command: counted, with no content.
    this.log("computer_unit_fallback", { tenant: row.tenant, computer: row.id });
    return { ...done, stderr: done.stderr.slice(NO_UNIT.length + 1) };
  }

  private transfer(tenant: string, agent: string, name: string, args: Record<string, any>, machines: ManagedMachines, machine: string, seconds: number, requestKey: string, files?: Pick<ToolContext, "mounts" | "onWrite">) {
    const transfers = this.options.transfers?.();
    if (!transfers) throw new HttpError(400, "Computer transfers are not enabled");
    const driver = { call: (_ref: unknown, _op: string, call: Record<string, any>) => machines.run(machine, String(call.command), Number(call.timeoutSeconds)) };
    return transfers.run({ tenant, agent, mounts: files?.mounts ?? [], onWrite: files?.onWrite }, name === "computer_upload", args, driver, { id: machine }, seconds, requestKey);
  }

  /** Keep a computer for its idle time from now, up to its hard stop, when less than half of that is left. A hold or an extension refused leaves it as it is. Answers its deadline. */
  private async keep(connection: any, row: any, machines: ManagedMachines) {
    const deadline = Number(row.deadline), now = this.options.now(), idle = connection.lease_seconds * 1000;
    const target = Math.min(Number(row.created_at) + MANAGED.maxSeconds * 1000, now + idle);
    if (target - deadline < idle / 2) return deadline;
    try {
      const users = this.options.endUsers?.();
      if (row.hold && users) {
        const want = Math.ceil((target - deadline) / 1000 * this.options.accounts.billing.pricing.computerHour / 3600);
        if ((await users.extend(row.tenant, row.end_user, row.bucket, row.hold, want, now)).refused) { this.log("computer_hold_refused", { tenant: row.tenant, computer: row.id }); return deadline; }
      }
      await machines.extend(row.machine, Math.ceil((target - now) / 1000));
      await this.db.query("update managed_computers set deadline=$2 where id=$1 and deadline<$2", [row.id, target]);
      return target;
    } catch { this.log("computer_extend_failed", { tenant: row.tenant, computer: row.id }); return deadline; }
  }

  /** Charge what Boat has reported since the last charge. It counts up, so a rerun or another node charges nothing more; a new period starts it over. */
  private async charge(row: { id: string }, machine: Machine) {
    const { accounts } = this.options;
    const tenant = await transaction(this.db, async sql => {
      const current = (await sql.query("select * from managed_computers where id=$1 and platform for update", [row.id])).rows[0];
      if (!current) return undefined;
      // Whole micro-USD, on the running total: pieces add up to it at any price. What it reports can only add: a lower figure, unless a new period starts the count over, charges nothing and moves nothing.
      const fresh = current.usage_since !== machine.since;
      const micros = Math.round(machine.dollars * MICROS);
      const counted = fresh ? 0 : Number(current.usage_micros), countedSeconds = fresh ? 0 : Number(current.usage_seconds);
      if (micros <= counted) { if (fresh) await sql.query("update managed_computers set usage_since=$2,usage_micros=0,usage_seconds=0 where id=$1", [row.id, machine.since]); return undefined; }
      const ratio = accounts.billing.pricing.computerHour / BOAT_SMALL_HOUR;
      const amount = Math.round(micros * ratio) - Math.round(counted * ratio), total = Number(current.charged_micros) + amount;
      await sql.query("update managed_computers set usage_since=$2,usage_micros=$3,usage_seconds=$4,charged_micros=$5 where id=$1", [row.id, machine.since, micros, machine.seconds, total]);
      await accounts.recordUsageIn(sql, current.tenant, current.agent, { provider: NAME, model: "computer", kind: "computer", usage: { cost: { total: amount / MICROS } }, platform: true, seconds: Math.max(0, machine.seconds - countedSeconds), timestamp: this.options.now() });
      return current.tenant as string;
    });
    if (tenant) await accounts.usageCommitted(tenant);
  }

  /** The row ends: no machine is there, or no more of it is ours to run. What it cost goes to its end user, once: the ledger key is its own. */
  private async end(row: { id: string }) {
    await this.db.query("update managed_computers set ended_at=$2 where id=$1 and ended_at is null", [row.id, this.options.now()]);
    await this.settle(row.id).catch(() => this.log("computer_settle_failed", { computer: row.id }));
  }

  private async settle(computer: string) {
    const users = this.options.endUsers?.();
    const row = (await this.db.query("select * from managed_computers where id=$1 and hold is not null and ended_at is not null", [computer])).rows[0];
    if (!row || !users) return;
    if (Number(row.charged_micros) > 0) await users.settleHold(row.tenant, row.end_user, row.bucket, row.hold, Number(row.charged_micros), `computer:${row.id}`, { call: "computer", agent: row.agent, provider: NAME, computer: row.id }, this.options.now());
    else await users.release(row.hold);
    await this.db.query("update managed_computers set hold=null where id=$1", [computer]);
  }

  private async stopOpen(connection: string) {
    const row = await this.open(connection);
    if (row) await this.stopRow(row);
    return { stopped: true };
  }

  /** Read what the machine has cost last, then delete it: past that, Boat no longer says. */
  private async stopRow(row: any) {
    try {
      const machines = this.machines(await this.keyFor(row));
      if (row.platform) {
        const [machine] = await machines.list(row.id);
        if (machine) await this.charge(row, machine);
      }
      if (row.machine) await machines.remove(row.machine);
      else if (row.platform) for (const machine of await machines.list(row.id)) await machines.remove(machine.id);
    } catch { throw new HttpError(502, "Computer cleanup failed; call computer_stop again. It also ends by itself when it is released."); }
    await this.end(row);
  }

  /** Stop a connection's computer, as disconnecting does. */
  async remove(connection: string) { await this.stopOpen(connection); }

  /** Stop every running computer, or one account's, until none is left. Answers how many stopped and how many failed: those end by themselves at their deadline. */
  private async stopAll(tenant?: string) {
    let stopped = 0, failed = 0;
    const failures = new Set<string>();
    for (;;) {
      const { rows } = await this.db.query("select * from managed_computers where ended_at is null and ($1::text is null or tenant=$1) and not (id = any($2::text[])) limit 200", [tenant ?? null, [...failures]]);
      if (!rows.length) return { stopped, failed };
      for (const row of rows) {
        try { await this.stopRow(row); stopped++; }
        catch { failed++; failures.add(row.id); }
        this.log("computer_kill_stop", { tenant: row.tenant, agent: row.agent, computer: row.id });
      }
    }
  }

  /** The platform operator's stop: this account's computers now, and with `block`, none new until `unblock`. */
  async stopTenant(tenant: string, by: string, block: boolean) {
    if (block) await this.db.query("insert into computer_blocks(tenant,blocked_by,created_at) values($1,$2,$3) on conflict (tenant) do nothing", [tenant, by, this.options.now()]);
    const result = await this.stopAll(tenant);
    const blocked = !!(await this.db.query("select 1 from computer_blocks where tenant=$1", [tenant])).rowCount;
    this.log("computer_tenant_stopped", { tenant, by, block, ...result });
    return { ...result, blocked };
  }
  async unblockTenant(tenant: string) {
    await this.db.query("delete from computer_blocks where tenant=$1", [tenant]);
    return { blocked: false };
  }

  /**
   * One pass: what Boat lists for this runtime is the truth. A row it lists is charged the difference; a row it no longer
   * lists has ended, once a listing of that row alone agrees; a listed machine with no row is only said, since its own
   * expiry ends it. Then an agent gone takes its machine with it, holds are kept, credit is checked, and with the flag off
   * everything stops. A listing that fails changes nothing.
   */
  async pass() {
    const { accounts, now } = this.options, started = now();
    const { rows } = await this.db.query(`select m.*, (a.id is null or a.revoked or a.purged_at is not null or (a.expires_at is not null and a.expires_at<=$1)) as agent_gone
      from managed_computers m left join agents a on a.id=m.agent and a.tenant=m.tenant where m.ended_at is null`, [started]);
    for (const row of rows) if (!row.platform && Number(row.deadline) <= started) await this.end(row);
    const key = accounts.tenants.platformKey(NAME);
    if (key) {
      const machines = this.machines(key), listed = await machines.list();
      const byRow = new Map(listed.map(machine => [machine.computer, machine]));
      const open = new Set(rows.map(row => row.id));
      for (const row of rows.filter(row => row.platform)) {
        const machine = byRow.get(row.id);
        try {
          if (machine) {
            if (!row.machine) await this.db.query("update managed_computers set machine=$2 where id=$1 and machine is null", [row.id, machine.id]);
            await this.charge(row, machine);
          } else if (Number(row.created_at) + (row.machine ? LISTING_GRACE_MS : SETTLE_MS) <= started && !(await machines.list(row.id)).length) await this.end(row);
        } catch { this.log("computer_charge_failed", { computer: row.id }); }
      }
      for (const machine of listed) {
        if (open.has(machine.computer) || machine.createdAt + SETTLE_MS > started) continue;
        this.log("computer_leak", { tenant: machine.tenant, computer: machine.computer, machine: machine.id });
      }
      if (listed.length || rows.length) this.log("computer_pass", { machines: listed.length, open: rows.length });
    }
    for (const row of rows.filter(row => row.agent_gone)) {
      try {
        const current = (await this.db.query("select * from managed_computers where id=$1 and ended_at is null", [row.id])).rows[0];
        if (!current) continue;
        this.log("computer_agent_gone", { tenant: row.tenant, agent: row.agent, computer: row.id });
        await this.stopRow(current);
      } catch { this.log("computer_charge_failed", { computer: row.id }); }
    }
    const users = this.options.endUsers?.();
    const limits = new Map<string, boolean>();
    for (const row of rows.filter(row => row.platform && !row.agent_gone)) {
      try {
        if (row.hold && users) await users.renew(row.tenant, row.end_user, row.hold, now());
        if (!this.options.enabled) continue;
        if (!limits.has(row.tenant)) limits.set(row.tenant, !!await accounts.billing.creditLimit(row.tenant));
        if (!limits.get(row.tenant)) continue;
        this.log("computer_credit_stop", { tenant: row.tenant, agent: row.agent, computer: row.id });
        const current = (await this.db.query("select * from managed_computers where id=$1 and ended_at is null", [row.id])).rows[0];
        if (current) await this.stopRow(current);
      } catch { this.log("computer_charge_failed", { computer: row.id }); }
    }
    for (const { id: computer } of (await this.db.query("select id from managed_computers where hold is not null and ended_at is not null limit 100")).rows) {
      await this.settle(computer).catch(() => this.log("computer_settle_failed", { computer }));
    }
    if (!this.options.enabled) await this.stopAll();
  }
}

/** A file tool's command, run the way a shell command is. */
export function fileCommand(name: string, args: Record<string, any>) {
  if (name !== "computer_read_file" && name !== "computer_write_file") return undefined;
  if (typeof args.path !== "string" || !args.path || args.path.length > 1024 || (name === "computer_write_file" && (typeof args.content !== "string" || args.content.length > 16000))) throw new HttpError(400, "Invalid file input");
  const data = Buffer.from(JSON.stringify(args)).toString("base64");
  return `python3 -c 'import json,base64,pathlib; d=json.loads(base64.b64decode("${data}")); p=pathlib.Path(d["path"]); ${name === "computer_write_file" ? 'p.parent.mkdir(parents=True,exist_ok=True); p.write_text(d["content"]); print("written")' : 'print(p.open().read(24000))'}'`;
}

/** A tool's result as Postgres can keep it and a retry can answer it. */
export function storable(value: unknown) {
  const encoded = JSON.stringify(value ?? null, (_key, item) => typeof item === "string" ? item.replaceAll("\u0000", "�").toWellFormed() : item);
  return encoded.length > 64000 ? { truncated: true, text: encoded.slice(0, 64000) } : JSON.parse(encoded);
}
