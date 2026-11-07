/**
 * Forking a computer: a sub-agent's machine starts as a disk copy of its parent's. Shared by the Node runtime and the
 * Workers app: the `computer` choice on delegate and spawn_agent, the snapshot a fork starts from, the errors, the fork
 * route's input, the bookkeeping rows both backends keep in Postgres, and a bounded start with one retry.
 *
 * A fork is a disk fork, not a memory fork: files, installed packages and build caches, never running processes. One
 * snapshot is taken at the call and serves every child of that call (one model response, or one script). Each child's
 * machine is its own: writes never reach the parent or a sibling.
 */
import { HttpError } from "./http-error.ts";
import type { Sql } from "./host.ts";

export const COMPUTER_CHOICES = ["fork", "fresh", "none"] as const;
/** fork: a copy of the parent's disk; fresh (the default): a new, empty machine with the parent's settings; none: no computer. */
export type ComputerChoice = typeof COMPUTER_CHOICES[number];

/** The `computer` argument of delegate and spawn_agent as the model sees it. */
export const COMPUTER_ARGUMENT = Object.freeze({
  type: "string", enum: [...COMPUTER_CHOICES],
  description: "Only if you have a computer: fork gives the sub-agent its own copy of your computer's disk as it is now (repos, installed packages, build caches; not running processes), so it can build and test on its own branch; its writes never reach yours. fresh (default): a new, empty computer. none: no computer.",
});

/** A call's `computer` argument: fresh when left out. */
export function computerChoice(value: unknown): ComputerChoice {
  if (value === undefined || value === null) return "fresh";
  if (typeof value === "string" && (COMPUTER_CHOICES as readonly string[]).includes(value)) return value as ComputerChoice;
  throw new HttpError(400, 'computer must be "fork", "fresh" or "none"');
}

/**
 * A disk snapshot a machine can start from, as the runtime keeps it: the provider's own id, and what deciding whether it
 * is still usable needs. `image` is the image version it was taken on, where the provider couples them (Cloudflare).
 */
export type SnapshotRef = { provider: string; id: string; image?: string; sizeBytes?: number; createdAt: number; expiresAt?: number };

/** Check a snapshot's shape before anything starts from it. */
export function snapshotRef(value: unknown): SnapshotRef {
  const v = value as Partial<SnapshotRef> | null;
  if (!v || typeof v !== "object" || typeof v.provider !== "string" || !v.provider || typeof v.id !== "string" || !v.id || v.id.length > 256
    || !Number.isSafeInteger(v.createdAt) || (v.image !== undefined && typeof v.image !== "string") || (v.sizeBytes !== undefined && !Number.isSafeInteger(v.sizeBytes))
    || (v.expiresAt !== undefined && !Number.isSafeInteger(v.expiresAt))) throw new Error("Invalid computer snapshot");
  return { provider: v.provider, id: v.id, createdAt: v.createdAt!, ...v.image !== undefined ? { image: v.image } : {},
    ...v.sizeBytes !== undefined ? { sizeBytes: v.sizeBytes } : {}, ...v.expiresAt !== undefined ? { expiresAt: v.expiresAt } : {} };
}

/**
 * What a provider's driver adds to fork: a snapshot of a running machine, a machine made from one (the driver's `create`
 * takes `{ from }`), and deleting one. A driver without `snapshot` cannot fork: the call answers `forkUnsupported`.
 */
export interface ForkDriver<Ref> {
  /** An exact snapshot of a running machine's disk: its files as they are now. The machine keeps running. */
  snapshot?(ref: Ref, label: string): Promise<SnapshotRef>;
  /** Delete a snapshot nothing will start from again. Best effort: a failure is retried later. */
  dropSnapshot?(snapshot: SnapshotRef): Promise<void>;
}
export const canFork = (driver: { snapshot?: unknown }) => typeof driver.snapshot === "function";

/** 409: this provider cannot copy a machine's disk. The caller can ask for a fresh computer instead. */
export const forkUnsupported = (provider: string) =>
  new HttpError(409, `This agent's ${provider} computer cannot be forked. Nothing was created. Use computer: "fresh" for a new, empty computer, or "none".`, "FORK_UNSUPPORTED", { provider });
/** Providers whose own-key connections can fork (their drivers snapshot); managed computers fork where their provider does. */
export const FORKABLE_PROVIDERS = Object.freeze(["boat", "container"]);
export const forkableProvider = (provider: string) => FORKABLE_PROVIDERS.includes(provider);
/** Whether a connection's machines are made so they can be snapshotted: managed by default, own-key when it opts in. */
export const connectionForkable = (row: { forkable?: boolean | null; managed?: boolean }) => row.forkable ?? !!row.managed;
/** 409: a connection made without `forkable` (a provider account's own Boat machines take no snapshots unless asked). */
export const notForkable = (provider: string) =>
  new HttpError(409, `This agent's ${provider} computer was connected without forkable, so its machines cannot be snapshotted. Nothing was created. Its owner can reconnect it with "forkable": true, or use computer: "fresh".`, "FORK_UNSUPPORTED", { provider, reason: "not_forkable" });
/** A provider's refusal or failure to snapshot: a machine made before its connection was forkable can't be, the rest is a 502. */
export const snapshotFailed = (provider: string, error: unknown) => (error as { status?: unknown })?.status === 409
  ? new HttpError(409, `This ${provider} machine was started before its connection could fork. Stop it (computer_stop) and start it again, then fork.`, "FORK_UNSUPPORTED", { provider, reason: "machine_not_forkable" })
  : error instanceof HttpError ? error : new HttpError(502, "The computer's disk could not be snapshotted, so nothing was forked. Try again; if it keeps failing, use a fresh computer.");

/** 409: there is no machine to copy: the parent's computer has not started, or its session ended. */
export const noSession = () =>
  new HttpError(409, 'This agent\'s computer has no running session to fork: start it first (computer_start, or any computer operation), or use computer: "fresh".', "NO_SESSION");
/** 503: a machine (often a restore whose disk is loading on a new host) did not answer within its bounded wait. */
export const computerStarting = (seconds: number) =>
  Object.assign(new HttpError(503, `The computer is still starting (it did not answer within ${seconds} seconds; restores of large disks sometimes take up to a minute). Nothing was lost. Call it again in a few seconds.`, "COMPUTER_STARTING"), { retryAfter: 5 });

/**
 * The key that makes the children of one call share one snapshot: the run, and the model response (its message index)
 * or, failing that, the tool call. A script's calls share its response's index, so a fan-out takes one snapshot too.
 */
export const forkBatch = (run: string, messageIndex: number | undefined, toolCallId: string) =>
  messageIndex !== undefined ? `${run}:m${messageIndex}` : `${run}:c${toolCallId}`;

export const FORK_LIMITS = Object.freeze({
  /** Agents one fork route call copies a computer into. */
  agents: 16,
  /** A snapshot no child starts from any more is dropped after this, so siblings of one call still being made can use it. */
  dropGraceMs: 10 * 60_000,
  /** How long one start or restore may take before it is tried again, and how many tries before "still starting". */
  startWaitMs: 12_000, startAttempts: 2,
});

/** The fork route's body: `{ agents: [...] }` (or one `agent`), the tenant's agents to copy the computer into. */
export function forkTargets(body: unknown, source: string): string[] {
  const value = body as { agents?: unknown; agent?: unknown } | null;
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => key !== "agents" && key !== "agent") || (value.agents === undefined) === (value.agent === undefined))
    throw new HttpError(400, "Give agents: the agent ids to fork this computer into");
  const agents = value.agents === undefined ? [value.agent] : value.agents;
  if (!Array.isArray(agents) || !agents.length || agents.length > FORK_LIMITS.agents || agents.some(agent => typeof agent !== "string" || !agent || agent.length > 200))
    throw new HttpError(400, `agents is 1 to ${FORK_LIMITS.agents} agent ids`);
  if (new Set(agents).size !== agents.length) throw new HttpError(400, "Each agent appears once");
  if (agents.includes(source)) throw new HttpError(400, "An agent cannot fork its computer into itself");
  return agents as string[];
}

/** Where a forked computer came from, as connections and fork answers show it. */
export type ForkedFrom = { agent: string; connection?: string; snapshot: string; provider: string; at: number };

/**
 * Run `attempt` with a bounded wait, once more after a timeout (a slow placement usually comes up at once elsewhere),
 * then answer `computerStarting`. `attempt` gets a signal that aborts at its deadline and the attempt's number; `onTimeout`
 * undoes a timed-out attempt (destroys the machine) before the next. A failure that is not a timeout is not retried.
 */
export async function boundedStart<T>(attempt: (signal: AbortSignal, index: number) => Promise<T>, options: { waitMs?: number; attempts?: number; onTimeout?: (index: number) => Promise<void> } = {}): Promise<T> {
  const waitMs = options.waitMs ?? FORK_LIMITS.startWaitMs, attempts = options.attempts ?? FORK_LIMITS.startAttempts;
  for (let index = 0; ; index++) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { const error = new Error("start timed out"); controller.abort(error); reject(error); }, waitMs); });
    try { return await Promise.race([attempt(controller.signal, index), deadline]); }
    catch (error) {
      if (!controller.signal.aborted) throw error;
      if (index + 1 >= attempts) throw computerStarting(Math.round(waitMs * attempts / 1000));
      await options.onTimeout?.(index);
    } finally { clearTimeout(timer); }
  }
}

/** A fork snapshot's row (`computer_snapshots`): what both backends keep so N children share one and the last one drops it. */
export type SnapshotRow = { id: string; tenant: string; connection: string; agent: string; batch: string; provider: string; reference: string; state: "taking" | "ready"; created_at: string | number; dropped_at: string | number | null; attempts: number };

/** How long a 'taking' row may wait for its snapshot before it counts as abandoned (its taker died), and drop retries. */
export const SNAPSHOT_ROWS = Object.freeze({ takingMs: 10 * 60_000, pollMs: 500, dropAttempts: 10, backoffMs: (attempts: number) => Math.min(6 * 3_600_000, 60_000 * 2 ** attempts) });

/**
 * The fork bookkeeping both backends share. `reference` is sealed by the host (it holds the snapshot and the
 * credentials to drop it), so these rows never hold a provider secret in the clear. One call per batch wins the row
 * (`claim`) and takes the snapshot with no database connection held; the others wait for it (`waitReady`).
 */
export const forkRows = {
  /** The open snapshot a call already took (or is taking) of this connection. */
  async batch(sql: Sql, connection: string, batch: string): Promise<SnapshotRow | undefined> {
    return (await sql.query("select * from computer_snapshots where connection=$1 and batch=$2 and dropped_at is null", [connection, batch])).rows[0];
  },
  /** Win the batch's row (state 'taking'), or answer the row another call won: `{ row, won }`. */
  async claim(sql: Sql, row: { id: string; tenant: string; connection: string; agent: string; batch: string; provider: string; created_at: number }): Promise<{ row: SnapshotRow; won: boolean }> {
    const won = (await sql.query(`insert into computer_snapshots(id,tenant,connection,agent,batch,provider,reference,state,created_at) values($1,$2,$3,$4,$5,$6,'{}','taking',$7)
      on conflict (connection, batch) where dropped_at is null do nothing returning *`, [row.id, row.tenant, row.connection, row.agent, row.batch, row.provider, row.created_at])).rows[0];
    if (won) return { row: won, won: true };
    const existing = await forkRows.batch(sql, row.connection, row.batch);
    if (!existing) throw new Error("Computer snapshot row vanished");
    return { row: existing, won: false };
  },
  /** The winner's snapshot is taken. False when its row is gone (cleared as abandoned): the caller drops the snapshot. */
  async ready(sql: Sql, id: string, reference: string): Promise<boolean> {
    return !!(await sql.query("update computer_snapshots set state='ready',reference=$2 where id=$1 and state='taking'", [id, reference])).rowCount;
  },
  /** The winner could not take the snapshot: its row goes, so the call can be made again. */
  async abandon(sql: Sql, id: string) {
    await sql.query("delete from computer_snapshots where id=$1 and state='taking'", [id]);
  },
  /** Wait for another call's snapshot of the batch, polling with no connection held between polls. */
  async waitReady(query: (work: (sql: Sql) => Promise<SnapshotRow | undefined>) => Promise<SnapshotRow | undefined>, id: string, now: () => number, sleep: (ms: number) => Promise<void>): Promise<SnapshotRow | undefined> {
    for (;;) {
      const row = await query(sql => forkRows.get(sql, id));
      if (!row || row.dropped_at !== null) return undefined;
      if (row.state === "ready") return row;
      if (Number(row.created_at) + SNAPSHOT_ROWS.takingMs <= now()) return undefined;
      await sleep(SNAPSHOT_ROWS.pollMs);
    }
  },
  async get(sql: Sql, id: string): Promise<SnapshotRow | undefined> {
    return (await sql.query("select * from computer_snapshots where id=$1", [id])).rows[0];
  },
  /** The seed a child attaches to, locked against a drop until its transaction ends; undefined when it is gone. */
  async attachable(sql: Sql, id: string, tenant: string): Promise<SnapshotRow | undefined> {
    const row = (await sql.query("select * from computer_snapshots where id=$1 for share", [id])).rows[0];
    return row && row.dropped_at === null && row.state === "ready" && row.tenant === tenant ? row : undefined;
  },
  /** Open snapshots no connection still starts from, taken before `before` and due: the ones to drop. 'taking' rows past their wait are cleared. */
  async unused(sql: Sql, before: number, now: number, limit = 50): Promise<SnapshotRow[]> {
    await sql.query("delete from computer_snapshots where state='taking' and created_at <= $1", [now - SNAPSHOT_ROWS.takingMs]);
    return (await sql.query(`select s.* from computer_snapshots s where s.dropped_at is null and s.state='ready' and s.created_at <= $1 and s.next_attempt_at <= $2
      and not exists (select 1 from computer_connections c where c.seed = s.id and c.agent not like 'removed:%') order by s.next_attempt_at, s.created_at limit $3`, [before, now, limit])).rows;
  },
  /** Every open snapshot of a tenant, for its deletion: dropped whatever their children or grace. */
  async ofTenant(sql: Sql, tenant: string): Promise<SnapshotRow[]> {
    return (await sql.query("select * from computer_snapshots where tenant=$1 and dropped_at is null and state='ready'", [tenant])).rows;
  },
  /** Snapshots of a tenant still being taken (a deletion waits for them, so none outlives its row). */
  async takingOf(sql: Sql, tenant: string): Promise<number> {
    return Number((await sql.query("select count(*)::int as n from computer_snapshots where tenant=$1 and dropped_at is null and state='taking'", [tenant])).rows[0].n);
  },
  /** The snapshot a removed connection started from, if no other connection still does and its call's siblings had time to attach. */
  async orphaned(sql: Sql, seed: string, before: number): Promise<SnapshotRow | undefined> {
    return (await sql.query(`select s.* from computer_snapshots s where s.id=$1 and s.dropped_at is null and s.state='ready' and s.created_at <= $2
      and not exists (select 1 from computer_connections c where c.seed = s.id and c.agent not like 'removed:%')`, [seed, before])).rows[0];
  },
  /** Lock a snapshot for its drop and check, under the lock, that nothing started from it meanwhile (`force`: account deletion). */
  async lockForDrop(sql: Sql, id: string, force = false): Promise<SnapshotRow | undefined> {
    const row = (await sql.query("select * from computer_snapshots where id=$1 and dropped_at is null for update", [id])).rows[0];
    if (!row || force) return row;
    return (await sql.query("select 1 from computer_connections where seed=$1 and agent not like 'removed:%' limit 1", [id])).rowCount ? undefined : row;
  },
  async dropped(sql: Sql, id: string, at: number, error?: string) {
    await sql.query("update computer_snapshots set dropped_at=$2,reference=$3,error=$4 where id=$1 and dropped_at is null", [id, at, "{}", error ?? null]);
  },
  /** A drop failed: try again later, backing off; past the last attempt the row is given up (the caller logs it). Answers whether it gave up. */
  async failed(sql: Sql, id: string, error: string, now: number): Promise<boolean> {
    const row = (await sql.query("update computer_snapshots set attempts=attempts+1,error=$2 where id=$1 and dropped_at is null returning attempts", [id, error.slice(0, 500)])).rows[0];
    if (!row) return false;
    if (row.attempts >= SNAPSHOT_ROWS.dropAttempts) { await forkRows.dropped(sql, id, now, `gave up: ${error.slice(0, 480)}`); return true; }
    await sql.query("update computer_snapshots set next_attempt_at=$2 where id=$1", [id, now + SNAPSHOT_ROWS.backoffMs(row.attempts)]);
    return false;
  },
};

/** A connection's `forkedFrom`, from its row. */
export const forkedFrom = (row: { forked_from?: unknown }): ForkedFrom | undefined => {
  const value = row.forked_from as ForkedFrom | null | undefined;
  return value && typeof value === "object" ? value : undefined;
};
