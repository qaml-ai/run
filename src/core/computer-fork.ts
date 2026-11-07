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
/** 409: there is no machine to copy: the parent's computer has not started, or its session ended. */
export const noSession = () =>
  new HttpError(409, 'This agent\'s computer has no running session to fork: start it first (computer_start, or any computer operation), or use computer: "fresh".', "NO_SESSION");
/** 503: a machine (often a restore whose disk is loading on a new host) did not answer within its bounded wait. */
export const computerStarting = (seconds: number) =>
  new HttpError(503, `The computer is still starting (it did not answer within ${seconds} seconds; restores of large disks sometimes take up to a minute). Nothing was lost. Call it again in a few seconds.`, "COMPUTER_STARTING");

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
export type SnapshotRow = { id: string; tenant: string; connection: string; agent: string; batch: string; provider: string; reference: string; created_at: string | number; dropped_at: string | number | null };

/**
 * The fork bookkeeping both backends share. `reference` is sealed by the host (it holds the snapshot and the
 * credentials to drop it), so these rows never hold a provider secret in the clear.
 */
export const forkRows = {
  /** The open snapshot a call already took of this connection. */
  async batch(sql: Sql, connection: string, batch: string): Promise<SnapshotRow | undefined> {
    return (await sql.query("select * from computer_snapshots where connection=$1 and batch=$2 and dropped_at is null", [connection, batch])).rows[0];
  },
  async insert(sql: Sql, row: Omit<SnapshotRow, "dropped_at">) {
    await sql.query("insert into computer_snapshots(id,tenant,connection,agent,batch,provider,reference,created_at) values($1,$2,$3,$4,$5,$6,$7,$8)",
      [row.id, row.tenant, row.connection, row.agent, row.batch, row.provider, row.reference, row.created_at]);
  },
  async get(sql: Sql, id: string): Promise<SnapshotRow | undefined> {
    return (await sql.query("select * from computer_snapshots where id=$1", [id])).rows[0];
  },
  /** Open snapshots no connection still starts from, taken before `before`: the ones to drop. */
  async unused(sql: Sql, before: number, limit = 50): Promise<SnapshotRow[]> {
    return (await sql.query(`select s.* from computer_snapshots s where s.dropped_at is null and s.created_at <= $1
      and not exists (select 1 from computer_connections c where c.seed = s.id and c.agent not like 'removed:%') order by s.created_at limit $2`, [before, limit])).rows;
  },
  /** The snapshot a removed connection started from, if no other connection still does. */
  async orphaned(sql: Sql, seed: string): Promise<SnapshotRow | undefined> {
    return (await sql.query(`select s.* from computer_snapshots s where s.id=$1 and s.dropped_at is null
      and not exists (select 1 from computer_connections c where c.seed = s.id and c.agent not like 'removed:%')`, [seed])).rows[0];
  },
  async dropped(sql: Sql, id: string, at: number, error?: string) {
    await sql.query("update computer_snapshots set dropped_at=$2,reference=$3,error=$4 where id=$1 and dropped_at is null", [id, at, "{}", error ?? null]);
  },
  async failed(sql: Sql, id: string, error: string) {
    await sql.query("update computer_snapshots set error=$2 where id=$1", [id, error.slice(0, 500)]);
  },
};

/** A connection's `forkedFrom`, from its row. */
export const forkedFrom = (row: { forked_from?: unknown }): ForkedFrom | undefined => {
  const value = row.forked_from as ForkedFrom | null | undefined;
  return value && typeof value === "object" ? value : undefined;
};
