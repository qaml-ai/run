import { setTimeout as sleep } from "node:timers/promises";
import type { Db } from "./db.ts";

const LOCK = "camelrun:v1-maintenance";

export class MaintenanceElectionError extends Error {}

export function requireEcsStopped(args: string[]) {
  if (args.length !== 1 || args[0] !== "--ecs-stopped") {
    throw new MaintenanceElectionError("Stop the old ECS tasks, disable their restarts, then pass --ecs-stopped");
  }
}

/** Old ECS tasks do not take this lock. Their shutdown is a precondition, checked here against the runtime leases too. */
export async function withMaintenanceElection(db: Pick<Db, "connect">, shutdown: AbortSignal,
  work: (signal: AbortSignal, check: () => Promise<void>) => Promise<void>, volumeOrigin?: string) {
  // The dedicated volume listener also publishes a lease and never runs these polls.
  if (volumeOrigin !== undefined) {
    const origin = URL.parse(volumeOrigin);
    if (!origin || !["http:", "https:"].includes(origin.protocol) || origin.origin !== volumeOrigin || !origin.port) {
      throw new MaintenanceElectionError("The v1 volume origin must be an exact HTTP origin with a port");
    }
  }
  const client = await db.connect();
  const election = new AbortController();
  const signal = AbortSignal.any([shutdown, election.signal]);
  let connected = true;
  let acquired = false;
  let locked = false;
  const lost = () => {
    connected = false;
    election.abort(new MaintenanceElectionError("The v1 maintenance election database session disconnected"));
  };
  client.on("error", lost);

  const check = async () => {
    try {
      election.signal.throwIfAborted();
      const { rows } = await client.query<{ live: boolean }>(`select exists (
        select 1 from runtime_nodes where expires_at > now() and node is distinct from $1
      ) as live`, [volumeOrigin ?? null]);
      if (rows[0].live) throw new MaintenanceElectionError("A v1 runtime peer still holds a live lease");
    } catch (error) {
      election.abort(error);
      throw error;
    }
  };

  try {
    if (shutdown.aborted) return;
    const { rows } = await client.query<{ acquired: boolean }>("select pg_try_advisory_lock(hashtextextended($1, 0)) as acquired", [LOCK]);
    locked = rows[0].acquired;
    acquired = true;
    if (!locked) throw new MaintenanceElectionError("A v1 maintenance runner already holds the election lock");
    await check();
    if (!signal.aborted) await work(signal, check);
    election.signal.throwIfAborted();
  } finally {
    try {
      if (locked && connected) await client.query("select pg_advisory_unlock(hashtextextended($1, 0))", [LOCK]);
    } catch {
      connected = false;
    } finally {
      client.off("error", lost);
      client.release(connected && acquired ? undefined : new Error("Discard the maintenance election connection"));
    }
  }
}

export type MaintenanceJob = {
  name: string;
  intervalMs: number;
  run: (signal: AbortSignal) => Promise<unknown>;
};

/** A failure leaves the durable job retryable on its usual schedule. An election failure stops all new polls. */
export async function runMaintenanceJobs(jobs: MaintenanceJob[], signal: AbortSignal, check: () => Promise<void>, failed: (name: string, error: unknown) => void) {
  // Wait for every poll already started before releasing the election lock, including when one rejects.
  const results = await Promise.allSettled(jobs.map(async ({ name, intervalMs, run }) => {
    while (!signal.aborted) {
      await check();
      if (signal.aborted) break;
      try { await run(signal); }
      catch (error) { failed(name, error); }
      try { await sleep(intervalMs, undefined, { signal }); }
      catch (error) { if (!signal.aborted) throw error; }
    }
  }));
  const failure = results.find(result => result.status === "rejected");
  if (failure) throw failure.reason;
}
