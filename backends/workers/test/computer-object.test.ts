import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { ComputerMeter, type ComputerCharge, type ComputerSession } from '../src/computers/meter.ts';

/** objects.ts without its imports, for a context that supplies each name the test reaches. */
function computerSource() {
  const source = readFileSync(new URL('../src/computers/objects.ts', import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    transformers: { before: [context => root => ts.visitEachChild(root, node => {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return undefined;
      if (ts.isClassDeclaration(node)) return context.factory.updateClassDeclaration(node,
        node.modifiers?.filter(modifier => modifier.kind !== ts.SyntaxKind.ExportKeyword),
        node.name, node.typeParameters, node.heritageClauses, node.members);
      return node;
    }, context)] },
  });
  return outputText.replace(/\bexport \{\};?\s*$/, '') + '\nContainerComputer';
}

function fixture() {
  const now = Date.now();
  const state = new Map<string, unknown>();
  const open: ComputerSession = {
    id: 'legacy-session', tenant: 't', agent: 'a', instance: 'standard-1',
    startedAt: now - 20_000, usedAt: now - 10_000, idleMs: 60_000,
    cpuAt: now - 20_000, cpuBaseUsec: 0, cpuUsec: 0,
  };
  state.set('meter:session', open);
  state.set('computer:snapshots', { saved: 'handle' });
  state.set('computer:permit', { tenant: 't', machine: 'native:a' });
  let alarm: number | undefined, stops = 0, failCharge = true, failStop = false;
  const attempted: ComputerCharge[] = [], released: string[] = [];
  const storage = {
    get: async (key: string) => state.get(key),
    put: async (key: string, value: unknown) => { state.set(key, value); },
    delete: async (key: string) => state.delete(key),
    list: async ({ prefix }: { prefix: string }) => new Map([...state].filter(([key]) => key.startsWith(prefix))),
    deleteAll: async () => { state.clear(); },
    deleteAlarm: async () => { alarm = undefined; },
    setAlarm: async (at: number) => { alarm = at; },
  };
  const container = {
    running: true,
    exec: async (argv: string[]) => {
      assert.deepEqual([...argv], ['cat', '/sys/fs/cgroup/cpu.stat']);
      return { stdout: new Response('usage_usec 250000\n').body, exitCode: Promise.resolve(0) };
    },
    destroy: async () => {
      stops++;
      if (failStop) throw new Error('stop unavailable');
      container.running = false;
    },
  };
  class Host {
    readonly ctx: unknown;
    readonly env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  }
  const Computer = runInNewContext(computerSource(), {
    DurableObject: Host, guardAlarms: () => {}, AbortSignal, TextDecoder,
    COMPUTER_LIMITS: { idleSeconds: { default: 60 } }, ComputerMeter,
    meterBilling: () => ({
      async charge(charge: ComputerCharge) {
        attempted.push(charge);
        if (failCharge) throw new Error('billing unavailable');
      },
    }),
    withSql: (_env: unknown, run: (sql: unknown) => Promise<void>) => run({}),
    releaseComputer: async (_sql: unknown, tenant: string, machine: string) => {
      assert.equal(container.running, false);
      released.push(tenant + '/' + machine);
    },
  });
  return {
    computer: new Computer({ container, storage }, {}),
    state, container, attempted, released,
    allowCharge: () => { failCharge = false; },
    stopFailure: (fail: boolean) => { failStop = fail; },
    get stops() { return stops; },
    get alarm() { return alarm; },
  };
}

test('retirement stops once, persists an unsettled charge and retries it under the same receipt', async () => {
  const f = fixture();
  const draining = f.computer.drain();
  assert.equal(f.computer.drain(), draining);
  assert.equal((await draining).settled, false);
  assert.equal(f.stops, 1);
  assert.equal(f.state.has('meter:session'), false);
  assert.equal(f.state.has('meter:unsettled:legacy-session'), true);
  assert.equal(f.attempted[0].cpuSeconds, 0.25);
  assert.deepEqual(f.released, ['t/native:a']);
  assert.ok(f.alarm && f.alarm > Date.now());

  f.allowCharge();
  await f.computer.alarm();
  assert.deepEqual(f.attempted.map(charge => charge.id), ['legacy-session', 'legacy-session']);
  assert.equal((await f.computer.drain()).settled, true);
  assert.equal(f.stops, 1);
  assert.equal(f.state.has('meter:unsettled:legacy-session'), false);
  assert.equal(f.alarm, undefined);
});

test('a failed stop keeps its open meter and admission permit until the container is stopped', async () => {
  const f = fixture();
  f.stopFailure(true);
  await assert.rejects(f.computer.drain(), /stop unavailable/);
  assert.equal(f.container.running, true);
  assert.equal(f.state.has('meter:session'), true);
  assert.equal(f.state.has('computer:permit'), true);
  assert.deepEqual(f.released, []);
  assert.deepEqual(f.attempted, []);
  assert.ok(f.alarm && f.alarm > Date.now());

  f.stopFailure(false);
  f.allowCharge();
  assert.equal((await f.computer.drain()).settled, true);
  assert.equal(f.stops, 2);
  assert.deepEqual(f.released, ['t/native:a']);
});

test('agent deletion retains its storage through settlement, then erases old snapshot metadata', async () => {
  const f = fixture();
  assert.equal((await f.computer.purge()).settled, false);
  assert.equal(f.state.has('computer:snapshots'), true);
  f.allowCharge();
  assert.equal((await f.computer.drain()).settled, true);
  assert.equal(f.state.has('computer:snapshots'), true, 'an operator drain preserves snapshot handles');
  assert.equal((await f.computer.purge()).settled, true);
  assert.equal(f.state.size, 0);
});
