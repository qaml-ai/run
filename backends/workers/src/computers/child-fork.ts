import { computerOwner, computerDisabled, disableComputer, hasComputer, shareComputer } from "../../../../src/core/computer-share.ts";
import { Directory } from "../control.ts";
import { withSql } from "../postgres.ts";
import { HttpError } from "../errors.ts";
import { computerStarting, FORK_LIMITS, noSession } from "../../../../src/core/computer-fork.ts";
import type { ChildComputerFork } from "../delegation.ts";
import type { OperateSetup } from "./objects.ts";
import { ComputerService, inheritComputer, type ComputerEnv } from "./service.ts";

type Env = ComputerEnv & { AGENTS: { idFromName(name: string): DurableObjectId } };
/** The native computer DO's name for an agent: its agent DO's id, as computerTool keys it. */
export const nativeComputer = (env: Env, agent: string) => env.AGENTS.idFromName(agent).toString();
/** An agent has a native computer: the deployment binds them, and it shares one or its configuration declares `computer` (hasComputer). */
export async function hasNativeComputer(env: Env, tenant: string, agent: string) {
  if (!env.COMPUTER_CONTAINERS) return false;
  const entry = await new Directory(env, tenant).get(agent);
  return withSql(env, sql => hasComputer(sql, tenant, agent, entry?.config?.computer !== undefined));
}

/**
 * A fork of the parent's computers for one call (`batch`): its connection's (a snapshot row, in the parent DO's
 * serial queue) and its native computer's (the computer DO's snapshot). A computer with nothing to copy is left out;
 * with neither, NO_SESSION. A connection whose provider cannot fork answers FORK_UNSUPPORTED.
 */
export async function forkChildComputers(env: Env, tenant: string, parent: string, batch: string, setup: () => Promise<OperateSetup>, serialize: <T>(run: () => Promise<T>) => Promise<T>): Promise<ChildComputerFork> {
  parent = await withSql(env, sql => computerOwner(sql, tenant, parent));
  let connection: ChildComputerFork["connection"], missing: unknown;
  try {
    const taken = await serialize(() => new ComputerService(env, tenant).forkSnapshot(parent, batch));
    if (taken) connection = { seed: taken.id, connection: taken.connection, provider: taken.provider, at: taken.at };
  } catch (error) { if ((error as HttpError).code === "NO_SESSION") missing = error; else throw error; }
  let native: ChildComputerFork["native"];
  // An agent without a computer has nothing to copy, and its computer object is never reached.
  if (env.COMPUTER_CONTAINERS && await hasNativeComputer(env, tenant, parent)) {
    const name = nativeComputer(env, parent);
    const answer = await env.COMPUTER_CONTAINERS.getByName(name).forkSnapshot(batch, await setup());
    if (answer.ok) native = { snapshot: answer.snapshot, origin: { parent: name, agent: parent, batch, at: Date.now() } };
    else if (answer.code === "COMPUTER_STARTING") throw computerStarting(Math.round(FORK_LIMITS.startWaitMs * FORK_LIMITS.startAttempts / 1000));
  }
  if (!connection && !native) throw missing ?? noSession();
  return { ...connection ? { connection } : {}, ...native ? { native } : {} };
}

/**
 * The fork route (POST /v1/computers/{id}/fork, /v1/agents/{id}/computer/fork), run in the source agent's DO: one fork
 * of its computers, and each target agent's computers start from it. Connections need targets with none of their own.
 */
export async function forkComputerInto(env: Env & { AGENTS: { getByName(name: string): { fetch(request: Request): Promise<Response> } } }, tenant: string, source: string, agents: string[], options: { connectionOnly?: boolean; setup: () => Promise<OperateSetup>; serialize: <T>(run: () => Promise<T>) => Promise<T> }) {
  const service = new ComputerService(env, tenant);
  if (options.connectionOnly && !(await service.hasConnection(source))) throw new HttpError(404, "Unknown computer connection");
  await service.forkTargets(source, agents);
  // A target's own native disk is never overwritten: a fork goes only to computers that have none yet, and only to
  // agents that have a computer to start from it.
  if (!options.connectionOnly && env.COMPUTER_CONTAINERS && await hasNativeComputer(env, tenant, source)) for (const agent of agents) {
    if (!(await hasNativeComputer(env, tenant, agent))) throw new HttpError(409, `Agent ${agent} has no computer: add \`computer\` to its definition`, "NO_COMPUTER");
    if (await env.COMPUTER_CONTAINERS.getByName(nativeComputer(env, agent)).hasDisk()) throw new HttpError(409, `Agent ${agent} already has files on its computer; fork into an agent whose computer has not been used`);
  }
  let fork: ChildComputerFork;
  if (options.connectionOnly) {
    const taken = await options.serialize(() => service.forkSnapshot(source, `api:${crypto.randomUUID()}`));
    if (!taken) throw new HttpError(404, "Unknown computer connection");
    fork = { connection: { seed: taken.id, connection: taken.connection, provider: taken.provider, at: taken.at } };
  } else fork = await forkChildComputers(env, tenant, source, `api:${crypto.randomUUID()}`, options.setup, options.serialize);
  // All or none: native computers are seeded first (they had no disk, so undoing one is a purge), then the connections
  // in one transaction; a failure in either undoes the seeds.
  const seeded: string[] = [];
  const undo = () => Promise.all(seeded.map(agent => env.COMPUTER_CONTAINERS!.getByName(nativeComputer(env, agent)).purge().catch(() => {})));
  let forks: Awaited<ReturnType<ComputerService["forkInto"]>> = [];
  try {
    if (fork.native && env.COMPUTER_CONTAINERS) for (const agent of agents) { await seedNative(env, agent, fork.native); seeded.push(agent); }
    if (fork.connection) forks = await service.forkInto(source, { id: fork.connection.seed, connection: fork.connection.connection!, provider: fork.connection.provider!, at: fork.connection.at! }, agents);
  } catch (error) { await undo(); throw error; }
  for (const agent of agents) {
    // An agent that has run already gets its new computer tools at its next turn.
    if (fork.connection) await env.AGENTS.getByName(agent).fetch(new Request("https://computer.internal/__computer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tenant, operation: "refresh" }) })).then(response => response.body?.cancel());
  }
  const snapshot = fork.connection
    ? { id: fork.connection.seed, provider: fork.connection.provider!, createdAt: fork.connection.at! }
    : { id: fork.native!.snapshot.id, provider: "cloudflare", createdAt: fork.native!.snapshot.createdAt };
  return { snapshot, forks, ...fork.native ? { native: { snapshot: fork.native.snapshot.id, agents } } : {} };
}

/** Seed an agent's native computer from a fork; a snapshot it refuses (expired, another image) is a 409 to fork again. */
async function seedNative(env: Env, agent: string, native: NonNullable<ChildComputerFork["native"]>) {
  try { await env.COMPUTER_CONTAINERS!.getByName(nativeComputer(env, agent)).seed(native.snapshot, native.origin); }
  catch (error) { throw new HttpError(409, `The fork could not start this computer: ${error instanceof Error ? error.message.slice(0, 200) : "its snapshot was refused"}`); }
}

/** Give a child just made the computers its call chose: a fork's seeds, none, or (undefined) a fresh copy of the parent's connection. */
export async function attachChildComputers(env: Env, tenant: string, parent: string, child: string, computer?: "none" | "share" | ChildComputerFork) {
  if (computer === "none") { await withSql(env, sql => disableComputer(sql, tenant, child)); return; }
  if (computer === "share") {
    // Share only what the parent has: an attached connection, or a native computer (declared, or shared to it).
    const disabled = await withSql(env, sql => computerDisabled(sql, tenant, parent));
    const attached = await new ComputerService(env, tenant).hasConnection(parent);
    if (disabled || (!attached && !(await hasNativeComputer(env, tenant, parent)))) {
      await withSql(env, sql => disableComputer(sql, tenant, child));
      return;
    }
    await withSql(env, sql => shareComputer(sql, tenant, parent, child));
    return;
  }
  await inheritComputer(env, tenant, parent, child, undefined, computer?.connection);
  // A replay never replaces a child's disk: one already seeded keeps it.
  if (computer?.native && env.COMPUTER_CONTAINERS && !(await env.COMPUTER_CONTAINERS.getByName(nativeComputer(env, child)).forkedFrom())) await seedNative(env, child, computer.native);
}

/**
 * A made child's work ended: its connection's session stops (in the child's own DO, whose serial queue owns its
 * computer calls) and its native computer is released (container, handles, the parent's snapshot reference).
 */
export async function releaseChildComputers(env: Env & { AGENTS: { getByName(name: string): { fetch(request: Request): Promise<Response> } } }, tenant: string, child: string) {
  if (await withSql(env, sql => computerOwner(sql, tenant, child)) !== child) return;
  const failures: unknown[] = [];
  try {
    const response = await env.AGENTS.getByName(child).fetch(new Request("https://computer.internal/__computer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tenant, operation: "release" }) }));
    if (!response.ok && response.status !== 404) failures.push(response.status);
    await response.body?.cancel();
  } catch (error) { failures.push(error); }
  if (env.COMPUTER_CONTAINERS) await env.COMPUTER_CONTAINERS.getByName(nativeComputer(env, child)).release("purge").catch(error => failures.push(error));
  if (failures.length) console.error(JSON.stringify({ type: "computer_release_failed", tenant, agent: child }));
}
