import { computerOwner, computerDisabled, disableComputer, hasComputer, shareComputer } from "../../../../src/core/computer-share.ts";
import { noSession } from "../../../../src/core/computer-fork.ts";
import { Directory } from "../control.ts";
import { HttpError } from "../errors.ts";
import { withSql } from "../postgres.ts";
import { bashEnabled } from "../camelfs/tier.ts";
import type { ChildComputerFork } from "../delegation.ts";
import { ComputerService, inheritComputer, type ComputerEnv } from "./service.ts";

type Env = ComputerEnv & { CAMELFS_COMPUTE?: string; CAMELFS_URL?: string };

export async function hasBashComputer(env: Env, tenant: string, agent: string) {
  if (!bashEnabled(env)) return false;
  const entry = await new Directory(env, tenant).get(agent);
  return !!entry && withSql(env, sql => hasComputer(sql, tenant, agent, entry.config?.computer !== undefined));
}

/** A snapshot per batch lets all children of one call fork the same connection. */
export async function forkChildComputers(env: Env, tenant: string, parent: string, batch: string, serialize: <T>(run: () => Promise<T>) => Promise<T>): Promise<ChildComputerFork> {
  const owner = await withSql(env, sql => computerOwner(sql, tenant, parent));
  const taken = await serialize(() => new ComputerService(env, tenant).forkSnapshot(owner, batch));
  if (!taken) throw noSession();
  return { connection: { seed: taken.id, connection: taken.connection, provider: taken.provider, at: taken.at } };
}

export async function forkComputerInto(env: Env, tenant: string, source: string, agents: string[], serialize: <T>(run: () => Promise<T>) => Promise<T>, byConnection = false) {
  const service = new ComputerService(env, tenant);
  await service.forkTargets(source, agents);
  if (byConnection && !(await service.hasConnection(source))) throw new HttpError(404, "Unknown computer connection");
  const { connection } = await forkChildComputers(env, tenant, source, `api:${crypto.randomUUID()}`, serialize);
  const snapshot = { id: connection.seed, connection: connection.connection, provider: connection.provider, at: connection.at };
  const forks = await service.forkInto(source, snapshot, agents);
  for (const agent of agents) {
    // An agent that has run already gets its new computer tools at its next turn.
    const response = await env.AGENTS.getByName(agent).fetch(new Request("https://computer.internal/__computer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tenant, operation: "refresh" }) }));
    await response.body?.cancel();
  }
  return { snapshot: { id: snapshot.id, provider: snapshot.provider, createdAt: snapshot.at }, forks };
}

/** Preserve the connection choice and the explicit compute opt-out for Firecracker. */
export async function attachChildComputers(env: Env, tenant: string, parent: string, child: string, computer?: "none" | "share" | ChildComputerFork) {
  if (computer === "none") { await withSql(env, sql => disableComputer(sql, tenant, child)); return; }
  if (computer === "share") {
    const disabled = await withSql(env, sql => computerDisabled(sql, tenant, parent));
    const attached = await new ComputerService(env, tenant).hasConnection(parent);
    // Keep the declaration/share policy for inherited compute access. The bash tool still owns its per-agent VM.
    const attachedComputer = attached && attached.provider !== "container";
    const canShare = !disabled && (attachedComputer || await hasBashComputer(env, tenant, parent));
    await withSql(env, sql => !canShare
      ? disableComputer(sql, tenant, child)
      : shareComputer(sql, tenant, parent, child));
    return;
  }
  await inheritComputer(env, tenant, parent, child, computer?.connection);
}

/** A finished child stops its own connection's session in the owning agent's queue. */
export async function releaseChildComputers(env: Env, tenant: string, child: string) {
  if (await withSql(env, sql => computerOwner(sql, tenant, child)) !== child) return;
  let failed = false;
  try {
    const response = await env.AGENTS.getByName(child).fetch(new Request("https://computer.internal/__computer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tenant, operation: "release" }) }));
    failed = !response.ok && response.status !== 404;
    await response.body?.cancel();
  } catch { failed = true; }
  if (failed) console.error(JSON.stringify({ type: "computer_release_failed", tenant, agent: child }));
}
