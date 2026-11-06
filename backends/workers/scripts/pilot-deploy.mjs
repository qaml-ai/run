#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

const cwd = fileURLToPath(new URL('../', import.meta.url));
const bin = resolve(cwd, 'node_modules/wrangler/bin/wrangler.js');
const account = '85bbd288051330fb51ee1c86031a299b';
const originLimit = Number(process.env.PILOT_ORIGIN_CONNECTION_LIMIT ?? 12);
if (!Number.isInteger(originLimit) || originLimit < 5 || originLimit > 100)
  throw new Error('PILOT_ORIGIN_CONNECTION_LIMIT must be an integer from 5 to 100');
async function run(args, { input, quiet = false } = {}) {
  return new Promise((yes, no) => {
    const child = spawn(process.execPath, [bin, ...args], { cwd,
      env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: account, WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: resolve(tmpdir(), 'camelrun-pilot-wrangler'), CI: 'true' },
      stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', b => { output += b; if (!quiet) process.stdout.write(b); });
    child.stderr.on('data', b => { output += b; if (!quiet) process.stderr.write(b); });
    child.stdin.end(input ?? 'y\n');
    child.on('error', no);
    child.on('exit', code => code === 0 ? yes(output) : no(new Error(`Wrangler ${args[0]} failed (${code})`)));
  });
}
// Named resources and configs are exclusively pilot resources. Never rotate a
// signing/encryption secret on a repeat deploy: that would invalidate stored data.
const buckets = await run(['r2', 'bucket', 'list'], { quiet: true });
if (!buckets.includes('camelrun-pilot-files')) await run(['r2', 'bucket', 'create', 'camelrun-pilot-files']);
const queues = await run(['queues', 'list'], { quiet: true });
if (!queues.includes('camelrun-pilot-delivery')) await run(['queues', 'create', 'camelrun-pilot-delivery']);
await run(['hyperdrive', 'update', '3e6d68e844ec480589e766119f52dead', '--origin-connection-limit', String(originLimit), '--caching-disabled', 'true'], { quiet: true });
await run(['deploy', '-c', 'codemode/wrangler.pilot.jsonc']);
await run(['deploy', '-c', 'pilot-fakemodel/wrangler.jsonc']);
await run(['deploy', '-c', 'wrangler.pilot.jsonc']);
const configured = await run(['secret', 'list', '-c', 'wrangler.pilot.jsonc'], { quiet: true });
const missing = {};
for (const name of ['API_TOKEN', 'FILE_SIGNING_SECRET', 'AGENT_SECRETS_KEY']) {
  if (!configured.includes(`"${name}"`)) missing[name] = randomBytes(32).toString('hex');
}
if (Object.keys(missing).length) {
  await run(['secret', 'bulk', '-c', 'wrangler.pilot.jsonc'], { input: JSON.stringify(missing), quiet: true });
  console.log(`Created missing pilot signing/encryption secrets: ${Object.keys(missing).join(', ')} (values never displayed).`);
}
console.log('Pilot deployed: https://run-pilot.camelai.dev');
