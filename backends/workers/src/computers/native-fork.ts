import type { ComputerSnapshot } from "./provider.ts";

/**
 * Forking the native computer (a `ContainerComputer` DO per agent, keyed by the agent's DO id). The contract between
 * delegation (agent-delegation.ts) and the computer DOs:
 *
 * 1. The parent's computer: `forkSnapshot(batch, setup)`. One snapshot per batch (one call's children share it): of
 *    the running container, or, when it is not running, its saved base (a seed or the snapshot its last sleep took).
 *    Nothing to copy answers `{ ok: false, code: "NO_SESSION" }`. Errors cross DO RPC as plain values, not HttpErrors.
 * 2. Each child's computer: `seed(snapshot, origin, setup)`: its base becomes the snapshot (its first start restores
 *    it), and it tells the parent's computer `adopt(batch, child)`.
 * 3. When the child's work ends: `release("purge")` (a delegate child: container, handles, then `unref` at the parent)
 *    or `release("sleep")` (snapshot, then stop: a later turn resumes its disk). Agent deletion purges as before.
 * 4. The parent's computer drops a batch's snapshot once every child that adopted it has unreferenced it, or after
 *    FORK_LIMITS.dropGraceMs when none adopted it. Cloudflare has no Worker API to delete a snapshot: dropping
 *    forgets the handle and logs `computer_snapshot_unused` with its id (its registry tag can be deleted by hand).
 */
export type NativeForkOrigin = {
  /** The parent's computer DO name (the parent agent's DO id). */
  parent: string;
  /** The parent agent's id. */
  agent: string;
  batch: string;
  at: number;
};
export type NativeForkAnswer =
  | { ok: true; snapshot: ComputerSnapshot }
  | { ok: false; code: "NO_SESSION" | "COMPUTER_STARTING"; message: string };
export type NativeForkedFrom = NativeForkOrigin & { snapshot: string };
