import test from 'node:test';
import assert from 'node:assert/strict';
import { loadQuickJSWasm } from '@earendil-works/pi-codemode';
import { RemoteCodemodeSandbox, serveCodemodeRemote } from '@earendil-works/pi-codemode/portable';
import { SANDBOX_INTERRUPT_BUDGET } from '../codemode/limits.ts';

test('the remote CPU budget interrupts non-yielding scripts and cannot be raised by the client', { timeout: 10_000 }, async () => {
  const wasm = await loadQuickJSWasm();
  const sandbox = new RemoteCodemodeSandbox({
    tools: [], interruptBudget: 1_000_000,
    remote: () => ({ execute: (request, exchange) => serveCodemodeRemote(request, exchange, { wasm, maxInterruptBudget: SANDBOX_INTERRUPT_BUDGET }) }),
  });
  try {
    const result = await sandbox.execute('while (true) {}');
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.kind, 'timeout');
    assert.match(result.error.message, /interrupt budget of 10000/);
    const next = await sandbox.execute('return 42');
    assert.equal(next.ok && next.value, 42, 'the next script remains usable after interruption');
  } finally { await sandbox.close(); }
});
