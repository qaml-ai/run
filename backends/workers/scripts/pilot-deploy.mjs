#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { readFile, writeFile, rm } from 'node:fs/promises';

const cwd = fileURLToPath(new URL('../', import.meta.url));
const bin = resolve(cwd, 'node_modules/wrangler/bin/wrangler.js');
const account = '85bbd288051330fb51ee1c86031a299b';
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
await run(['deploy', '-c', 'codemode/wrangler.pilot.jsonc']);
await run(['deploy', '-c', 'pilot-fakemodel/wrangler.jsonc']);
const store = await run(['secrets-store', 'secret', 'list', 'c8c66b0210e64900864182073dcd5e09', '--per-page', '100', '--remote'], { quiet: true });
if (store.includes('CAMELRUN_PILOT_OPENROUTER_KEY')) {
  await run(['deploy', '-c', 'wrangler.pilot.jsonc']);
} else {
  // Cloudflare rejects nonexistent secret references (10182). Keep the desired
  // binding in source; omit it only from this temporary deployment manifest.
  const config = JSON.parse(await readFile(resolve(cwd, 'wrangler.pilot.jsonc'), 'utf8'));
  delete config.secrets_store_secrets;
  const pending = resolve(cwd, `.pilot-deploy-${randomBytes(8).toString('hex')}.jsonc`);
  try {
    await writeFile(pending, JSON.stringify(config));
    await run(['deploy', '-c', pending]);
  } finally { await rm(pending, { force: true }); }
  console.log('Model key pending: rerun scripts/pilot-deploy after creating CAMELRUN_PILOT_OPENROUTER_KEY.');
}
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
