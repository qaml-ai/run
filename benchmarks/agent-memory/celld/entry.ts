/**
 * celld entry for the memory benchmark (benchmarks/agent-memory). The production Worker, unchanged, with the
 * adaptations celld forces:
 * - celld has no Hyperdrive and its variables must be strings, so `HYPERDRIVE_URL` (the same direct local connection
 *   string Hyperdrive's local mode hands the Worker) becomes `env.HYPERDRIVE = { connectionString }`.
 * - Async storage.transaction() is serialized per object without rollback (serialTransactions below).
 * - The code mode sandbox, a separate Worker on Cloudflare (backends/workers/codemode), is exported from this one:
 *   a celld fleet runs one application.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import worker, { CamelAgent as Agent, TenantAdmission as Admission, Volume as VolumeObject } from "../../../backends/workers/src/index.ts";
export { CodemodeSandbox } from "../../../backends/workers/codemode/index.ts";

type AnyEnv = Record<string, unknown> & { HYPERDRIVE_URL?: string };
const withPostgres = <E>(env: E): E => {
  const e = env as unknown as AnyEnv;
  if (e.HYPERDRIVE || !e.HYPERDRIVE_URL) return env;
  return { ...e, HYPERDRIVE: { connectionString: e.HYPERDRIVE_URL } } as unknown as E;
};

/**
 * celld 0.6.3 runs an async storage.transaction() inside blockConcurrencyWhile(), and that deadlocks when two events
 * open transactions at once (the agent's admit, its event cursor and Pi's Chord store do, on every first prompt): each
 * waited 30 s and the object was reset. workerd lets them interleave and commits each at its end. Here transactions on
 * one object run one at a time behind a promise chain (a nested one runs inside its parent), with no rollback: the
 * benchmark has no failing transaction, so it measures the same work. Not a production substitute.
 */
const insideTransaction = new AsyncLocalStorage<boolean>();
function serialTransactions(ctx: DurableObjectState) {
  const storage = ctx.storage as DurableObjectStorage & { transaction: (cb: (tx: unknown) => Promise<unknown>) => Promise<unknown> };
  let chain: Promise<unknown> = Promise.resolve();
  const tx = Object.assign(Object.create(storage), { rollback() { throw new Error("rollback is not supported by the benchmark's celld transaction shim"); } });
  storage.transaction = (callback) => {
    if (insideTransaction.getStore()) return callback(tx);
    const run = chain.then(() => insideTransaction.run(true, () => callback(tx)));
    chain = run.catch(() => {});
    return run;
  };
}
export class CamelAgent extends Agent { constructor(ctx: DurableObjectState, env: any) { serialTransactions(ctx); super(ctx, withPostgres(env)); } }
export class TenantAdmission extends Admission { constructor(ctx: DurableObjectState, env: any) { super(ctx, withPostgres(env)); } }
export class Volume extends VolumeObject { constructor(ctx: DurableObjectState, env: any) { super(ctx, withPostgres(env)); } }

const handlers = worker as unknown as Record<string, (...args: any[]) => unknown>;
export default Object.fromEntries(Object.entries(handlers).map(([name, handler]) =>
  [name, typeof handler === "function" ? (input: unknown, env: unknown, ctx: unknown) => handler.call(worker, input, withPostgres(env), ctx) : handler]));
