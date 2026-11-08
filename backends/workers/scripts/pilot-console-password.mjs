#!/usr/bin/env node
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { checkPassword, normalizeEmail } from "../src/account-passwords.ts";
import { withPilotOperator, PILOT_URL } from "./pilot-operator.mjs";

export async function readPassword(input = process.stdin, output = process.stderr) {
  if (!input.isTTY || !output.isTTY) throw new Error("Run this command yourself in an interactive terminal.");
  // Readline owns raw mode and line editing; its output (including echo) is discarded.
  const muted = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const wasRaw = input.isRaw;
  const reader = createInterface({ input, output: muted, terminal: true, historySize: 0 });
  let pending;
  const cancel = () => pending?.(new Error("Password entry cancelled."));
  reader.on("SIGINT", cancel);
  reader.on("close", cancel);
  process.on("SIGTERM", cancel);
  const ask = prompt => new Promise((resolve, reject) => {
    pending = reject;
    output.write(prompt);
    reader.question("", answer => { pending = undefined; output.write("\n"); resolve(answer); });
  });
  try {
    const password = checkPassword(await ask("Password: "));
    if (password !== await ask("Confirm password: ")) throw new Error("Passwords do not match.");
    return password;
  } finally {
    pending = undefined;
    reader.close();
    input.setRawMode(wasRaw ?? false);
    muted.destroy();
    process.removeListener("SIGTERM", cancel);
  }
}


/** --generate: a random password, saved to a 0600 file and copied to the clipboard; never printed. */
export function generatePassword() {
  const password = randomBytes(24).toString("base64url");
  const dir = join(homedir(), ".config", "camelrun");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "pilot-console-password"), password + "\n", { mode: 0o600 });
  try { execFileSync("pbcopy", { input: password }); } catch {}
  return password;
}

export async function setConsolePassword(tenant, email, { read = readPassword, operate = withPilotOperator } = {}) {
  if (!/^pilot-[a-z0-9-]{1,33}$/.test(tenant)) throw new Error("Use an existing pilot-* tenant ID (at most 39 characters).");
  email = normalizeEmail(email);
  if (!email) throw new Error("Use a valid email address.");
  const password = await read();
  await operate({ tenantIds: [tenant] }, async ({ request }) => {
    await request(`/v1/tenants/${tenant}/password`, { method: "PUT", body: { email, password } });
  });
  return `Password set for ${email} on ${tenant}. Sign in at ${PILOT_URL}/console`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2), generate = args.includes("--generate"), [tenant, email] = args.filter(arg => arg !== "--generate");
    if (!tenant || !email) throw new Error("Usage: node backends/workers/scripts/pilot-console-password.mjs <tenant> <email> [--generate]");
    console.log(await setConsolePassword(tenant, email, generate ? { read: async () => generatePassword() } : {}));
    if (generate) console.log("A generated password is on your clipboard and in ~/.config/camelrun/pilot-console-password (only you can read it).");
  } catch {
    // Do not echo exception text: a dependency could include request data.
    console.error("Password setup failed. Use an interactive terminal, an existing pilot-* tenant, a valid email, and matching passwords of 12–256 characters; check pilot access if it persists.");
    process.exitCode = 1;
  }
}
