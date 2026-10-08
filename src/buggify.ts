/**
 * BUGGIFY, as FoundationDB has it: points in the runtime's code where a simulator may make something unusual but legal
 * happen (a renewal that fails, an append whose answer is lost, a tool call that fails, a stream that stalls), so its
 * runs reach the rare paths. In production nothing installs a simulation and `buggify` is always false: one load and a
 * comparison, with no allocation. Each site's name is a constant string, and each site does only what could happen
 * anyway.
 */
export type Buggify = (site: string, probability: number | undefined) => boolean;

let fire: Buggify | undefined;

/** Whether to misbehave at `site` now: never in production; in a simulation, as it chooses (about `probability` of the time, if given). */
export function buggify(site: string, probability?: number): boolean {
  return fire !== undefined && fire(site, probability);
}

/** For a simulator: decide each site (undefined: none fires again). Process-wide; a simulator tells nodes apart by their context. */
export function installBuggify(next: Buggify | undefined) {
  fire = next;
}
