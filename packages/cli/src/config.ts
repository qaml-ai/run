import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Credentials } from "./api.ts";

export const DEFAULT_URL = "https://run.camelai.com";

/** Where `camelrun login` keeps the key: $CAMELRUN_CONFIG, else $XDG_CONFIG_HOME/camelrun, else ~/.config/camelrun. */
export function configPath(env = process.env) {
  if (env.CAMELRUN_CONFIG) return env.CAMELRUN_CONFIG;
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "camelrun", "credentials.json");
}

export function readSaved(env = process.env): Partial<Credentials> {
  const path = configPath(env);
  if (!existsSync(path)) return {};
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return {}; }
}

export function save(credentials: Credentials, env = process.env) {
  const path = configPath(env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(credentials, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

export function forget(env = process.env) {
  const path = configPath(env);
  const had = existsSync(path);
  rmSync(path, { force: true });
  return had ? path : undefined;
}

/** Flags first, then CAMELAI_API_KEY / CAMELAI_URL, then what `camelrun login` saved. */
export function resolve(flags: { apiKey?: string; url?: string }, env = process.env): Credentials {
  const saved = readSaved(env);
  const apiKey = flags.apiKey || env.CAMELAI_API_KEY || saved.apiKey;
  if (!apiKey) throw new Error("No API key: run `camelrun login`, or set CAMELAI_API_KEY (create one under API tokens at https://run.camelai.com/console)");
  return { apiKey, url: flags.url || env.CAMELAI_URL || saved.url || DEFAULT_URL };
}
