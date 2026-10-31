/**
 * What the runtime watches for on managed computers, whose machines run on the platform's account: a provider can
 * suspend the whole account for one tenant's abuse. Only logged, and only which signature matched: never the command.
 */
const SIGNATURES: readonly [string, RegExp][] = [
  ["miner", /\b(?:xmrig|minerd|cpuminer|cgminer|nanominer|lolminer)\b/i],
  ["mining_pool", /stratum\+(?:tcp|ssl|tls)|nicehash|unmineable|nanopool|2miners/i],
  ["mail_blast", /\b(?:swaks|sendmail)\b/i],
  ["scanner", /\b(?:masscan|zmap)\b/i],
];

/** The names of the signatures `text` matches. */
export function signatures(text: string) {
  return SIGNATURES.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

/**
 * Where a provider's machine for a managed computer gets anything it must have before an agent uses it: the place
 * egress rules go when they are decided. Nothing yet.
 */
export function machineSetup(): string | undefined { return undefined; }
