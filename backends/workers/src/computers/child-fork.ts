import { HttpError } from "../errors.ts";
import { noSession } from "../../../../src/core/computer-fork.ts";
import type { ChildComputerFork } from "../delegation.ts";
import type { OperateSetup } from "./objects.ts";
import { ComputerService, inheritComputer, type ComputerEnv } from "./service.ts";

type Env = ComputerEnv & { AGENTS: { idFromName(name: string): DurableObjectId } };
/** The native computer DO's name for an agent: its agent DO's id, as computerTool keys it. */
export const nativeComputer = (env: Env, agent: string) => env.AGENTS.idFromName(agent).toString();

/**
 * A fork of the parent's computers for one call (`batch`): its connection's (a snapshot row, in the parent DO's
 * serial queue) and its native computer's (the computer DO's snapshot). A computer with nothing to copy is left out;
 * with neither, NO_SESSION. A connection whose provider cannot fork answers FORK_UNSUPPORTED.
 */
export async function forkChildComputers(env: Env, tenant: string, parent: string, batch: string, setup: () => Promise<OperateSetup>, serialize: <T>(run: () => Promise<T>) => Promise<T>): Promise<ChildComputerFork> {
  let connection: ChildComputerFork["connection"], missing: unknown;
  try {
    const taken = await serialize(() => new ComputerService(env, tenant).forkSnapshot(parent, batch));
    if (taken) connection = { seed: taken.id, connection: taken.connection, provider: taken.provider, at: taken.at };
  } catch (error) { if ((error as HttpError).code === "NO_SESSION") missing = error; else throw error; }
  let native: ChildComputerFork["native"];
  if (env.COMPUTER_CONTAINERS) {
    const name = nativeComputer(env, parent);
    const answer = await env.COMPUTER_CONTAINERS.getByName(name).forkSnapshot(batch, await setup());
    if (answer.ok) native = { snapshot: answer.snapshot, origin: { parent: name, agent: parent, batch, at: Date.now() } };
    else if (answer.code === "COMPUTER_STARTING") throw new HttpError(503, answer.message, "COMPUTER_STARTING");
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
  let fork: ChildComputerFork;
  if (options.connectionOnly) {
    const taken = await options.serialize(() => service.forkSnapshot(source, `api:${crypto.randomUUID()}`));
    if (!taken) throw new HttpError(404, "Unknown computer connection");
    fork = { connection: { seed: taken.id, connection: taken.connection, provider: taken.provider, at: taken.at } };
  } else fork = await forkChildComputers(env, tenant, source, `api:${crypto.randomUUID()}`, options.setup, options.serialize);
  const forks = fork.connection ? await service.forkInto(source, { id: fork.connection.seed, connection: fork.connection.connection!, provider: fork.connection.provider!, at: fork.connection.at! }, agents) : [];
  for (const agent of agents) {
    if (fork.native && env.COMPUTER_CONTAINERS) await env.COMPUTER_CONTAINERS.getByName(nativeComputer(env, agent)).seed(fork.native.snapshot, fork.native.origin);
    // An agent that has run already gets its new computer tools at its next turn.
    if (fork.connection) await env.AGENTS.getByName(agent).fetch(new Request("https://computer.internal/__computer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tenant, operation: "refresh" }) })).then(response => response.body?.cancel());
  }
  const snapshot = fork.connection
    ? { id: fork.connection.seed, provider: fork.connection.provider!, createdAt: fork.connection.at! }
    : { id: fork.native!.snapshot.id, provider: "cloudflare", createdAt: fork.native!.snapshot.createdAt };
  return { snapshot, forks, ...fork.native ? { native: { snapshot: fork.native.snapshot.id, agents } } : {} };
}

/** Give a child just made the computers its call chose: a fork's seeds, none, or (undefined) a fresh copy of the parent's connection. */
export async function attachChildComputers(env: Env, tenant: string, parent: string, child: string, computer?: "none" | ChildComputerFork) {
  if (computer === "none") return;
  await inheritComputer(env, tenant, parent, child, undefined, computer?.connection);
  if (computer?.native && env.COMPUTER_CONTAINERS) await env.COMPUTER_CONTAINERS.getByName(nativeComputer(env, child)).seed(computer.native.snapshot, computer.native.origin);
}

/**
 * A made child's work ended: its connection's session stops (in the child's own DO, whose serial queue owns its
 * computer calls) and its native computer is released (container, handles, the parent's snapshot reference).
 */
export async function releaseChildComputers(env: Env & { AGENTS: { getByName(name: string): { fetch(request: Request): Promise<Response> } } }, tenant: string, child: string) {
  const failures: unknown[] = [];
  try {
    const response = await env.AGENTS.getByName(child).fetch(new Request("https://computer.internal/__computer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tenant, operation: "release" }) }));
    if (!response.ok && response.status !== 404) failures.push(response.status);
    await response.body?.cancel();
  } catch (error) { failures.push(error); }
  if (env.COMPUTER_CONTAINERS) await env.COMPUTER_CONTAINERS.getByName(nativeComputer(env, child)).release("purge").catch(error => failures.push(error));
  if (failures.length) console.error(JSON.stringify({ type: "computer_release_failed", tenant, agent: child }));
}
