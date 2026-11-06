#!/usr/bin/env node
/** Laptop orchestrator. The benchmark itself runs under a Sprite pool lease.
 * Only a pipe carries the one-hour scoped operator credential to the Sprite.
 */
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withPilotOperator } from './pilot-operator.mjs';
import { loadTenantIds } from './pilot-load.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const fakeBaseUrl = process.env.PILOT_FAKE_URL;
if (!fakeBaseUrl) throw new Error('Set PILOT_FAKE_URL to the deployed camelrun-pilot-fakemodel URL');
const runId = randomBytes(5).toString('hex');
const tenantIds = loadTenantIds(runId, Number(process.env.PILOT_LOAD_TENANTS ?? 20));
const fifo = `/tmp/camelrun-pilot-load-${runId}`;
const outputPath = resolve(root, process.env.PILOT_LOAD_REPORT ?? `backends/workers/measurements/pilot-load-${runId}.json`);
const stages = process.env.PILOT_LOAD_STAGES?.split(',').map(Number);
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

try {
  const report = await withPilotOperator({ tenantIds }, operator => new Promise((resolveRun, reject) => {
    // FIFO is not a regular file: the credential is consumed from kernel memory.
    const shell = `set -eu; umask 077; mkfifo ${quote(fifo)}; trap 'rm -f ${quote(fifo)}' EXIT; echo PILOT_LOAD_STDIN_READY; node backends/workers/scripts/pilot-load.mjs --stdin < ${quote(fifo)}`;
    const child = spawn(resolve(root, 'scripts/sprite-test'), [process.env.PILOT_REF ?? 'HEAD', 'bash', '-c', shell], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let buffer = '', sprite, sent = false, foundReport;
    const timer = setTimeout(() => { child.kill('SIGINT'); reject(new Error('Pilot load exceeded its 45-minute operator window')); }, 45 * 60_000);
    const sendCredential = () => {
      if (sent || !sprite || !buffer.includes('PILOT_LOAD_STDIN_READY')) return;
      sent = true;
      const writer = spawn('sprite', ['exec', '-o', process.env.SPRITE_ORG ?? 'camelai', '-s', sprite, '--stdin', '--', 'sh', '-c', `cat > ${quote(fifo)}`], { stdio: ['pipe', 'ignore', 'pipe'] });
      // No shell interpolation, environment variable, regular file or CLI argument
      // contains the credential. Child stdin feeds the remote FIFO directly.
      writer.stdin.end(JSON.stringify({ operatorBaseUrl: operator.baseUrl, operatorToken: operator.token, tenantIds, fakeBaseUrl, ...(stages ? { stages } : {}), modelDelayMs: Number(process.env.PILOT_LOAD_DELAY_MS ?? 5000) }));
      writer.on('error', () => { child.kill('SIGINT'); reject(new Error('Could not feed the scoped credential to the Sprite')); });
      writer.on('exit', code => { if (code) { child.kill('SIGINT'); reject(new Error('Sprite credential pipe failed')); } });
    };
    const output = bytes => {
      const text = bytes.toString();
      if (text.includes(operator.token)) { child.kill('SIGINT'); reject(new Error('Suppressed unsafe benchmark output')); return; }
      process.stdout.write(text);
      buffer += text;
      sprite ??= buffer.match(/== sprite-test .* on (rt-pool-\d+) \(/)?.[1];
      sendCredential();
      for (const line of text.split('\n')) {
        if (!line.startsWith('{"type":"load_report"')) continue;
        try { foundReport = JSON.parse(line).report; } catch { /* a later chunk completes it */ }
      }
      if (!foundReport) {
        const line = buffer.split('\n').find(line => line.startsWith('{"type":"load_report"'));
        if (line) try { foundReport = JSON.parse(line).report; } catch { /* incomplete */ }
      }
    };
    child.stdout.on('data', output); child.stderr.on('data', output);
    child.on('error', () => { clearTimeout(timer); reject(new Error('Could not start scripts/sprite-test')); });
    child.on('exit', code => {
      clearTimeout(timer);
      if (foundReport) resolveRun(foundReport);
      else reject(new Error(`Sprite benchmark ended without a report (exit ${code})`));
    });
  }));
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(report, null, 2) + '\n');
  console.log(`Sanitized pilot load report: ${outputPath}`);
  if (report.stoppedReason || report.cleanup.failures.length) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Pilot load orchestration failed');
  process.exitCode = 1;
}
