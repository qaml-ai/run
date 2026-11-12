import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

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

test('an idle alarm waits for the exec deadline without blocking concurrent commands, then checks at completion', async () => {
  let now = 1000, alarm: number | null = null, release!: () => void;
  const alarms: number[] = [];
  const held = new Promise<void>(resolve => { release = resolve; });
  class Host {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) { this.ctx = ctx; this.env = env; }
  }
  class Clock extends Date { static now() { return now; } }
  const Computer = runInNewContext(computerSource(), {
    DurableObject: Host, Date: Clock, AbortSignal, Promise,
    COMPUTER_LIMITS: { execMs: 120_000 }, sameComputerNetwork: () => true,
    computerToolError: (error: unknown) => error,
    operate: async (_provider: unknown, request: { command: string }) => {
      if (request.command === 'hold') await held;
      else release();
      return { exitCode: 0 };
    },
  });
  const computer = new Computer({ container: { running: true }, storage: {
    get: async () => undefined, delete: async () => true,
    getAlarm: async () => alarm,
    setAlarm: async (at: number) => { alarm = at; alarms.push(at); },
  } }, {});
  computer.network = () => ({ key: '' });
  computer.provider = () => ({ ready: async () => {} });
  const first = computer.operate({ op: 'exec', command: 'hold', timeoutMs: 40_000 });
  while (!computer.active.size) await Promise.resolve();
  await computer.alarm();
  assert.equal(alarm, 41_000, 'the alarm uses the running command deadline, not a one-second poll');
  now += 1000;
  await computer.alarm();
  assert.deepEqual(alarms, [41_000, 41_000]);
  await computer.operate({ op: 'exec', command: 'release', timeoutMs: 5000 });
  await first;
  await computer.queue;
  // The completion cleanup schedules an immediate idle check.
  for (let i = 0; i < 10 && alarm !== now; i++) await Promise.resolve();
  assert.equal(alarm, now);
});

test('a job object runs one job at a time, stops it on request, and its alarm destroys a container a dead run left', async () => {
  let now = 1000, alarm: number | null = null, destroyed = 0, release!: () => void;
  const data = new Map<string, unknown>();
  const storage = {
    get: async (key: string) => data.get(key), put: async (key: string, value: unknown) => { data.set(key, value); },
    delete: async (key: string) => data.delete(key), list: async () => new Map(),
    getAlarm: async () => alarm, setAlarm: async (at: number) => { alarm = at; },
  };
  const container = { running: false, destroy: async () => { destroyed++; container.running = false; } };
  class Host {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) { this.ctx = ctx; this.env = env; }
  }
  class Clock extends Date { static now() { return now; } }
  const held = new Promise<void>(resolve => { release = resolve; });
  const runs: { stop: AbortSignal; files?: unknown; meter?: unknown }[] = [];
  const Computer = runInNewContext(computerSource(), {
    DurableObject: Host, Date: Clock, AbortSignal, AbortController, Promise, Map, JSON, console,
    jobSpec: (value: { id: string; timeoutSeconds: number }) => value,
    jobLifetimeMs: (seconds: number) => seconds * 1000 + 720_000,
    inlineFiles: (files: unknown) => ({ inline: files }),
    volumeFiles: () => { throw new Error('no volume here'); },
    runContainerJob: async (spec: { id: string }, options: { stop: AbortSignal; files?: unknown; meter?: unknown }) => {
      runs.push(options);
      container.running = true;
      await Promise.race([held, new Promise(resolve => options.stop.addEventListener('abort', resolve))]);
      container.running = false;
      const stream = { bytes: new Uint8Array([111, 107]), size: 2, truncated: false };
      return options.stop.aborted ? { ok: false, id: spec.id, code: 'stopped' } : { ok: true, id: spec.id, stdout: stream, stderr: stream, outputs: {} };
    },
    ComputerMeter: class { async stopped() {} async alarm() {} },
    meterBilling: () => ({}),
    COMPUTER_LIMITS: { idleSeconds: { default: 60 } },
  });
  const computer = new Computer({ container, storage }, {});
  const first = computer.runJob({ id: 'j1', payer: { tenant: 't', agent: 'a' }, command: 'x', timeoutSeconds: 10, files: { a: new Uint8Array() } });
  while (!runs.length) await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(data.get('job:deadline'), 1000 + 10_000 + 720_000);
  assert.equal(alarm, 1000 + 10_000 + 720_000, 'the backstop alarm is set before the container starts');
  assert.equal(Object.keys((runs[0].files as { inline: object }).inline).join(), 'a');
  assert.equal(typeof (runs[0].meter as { admit?: unknown }).admit, 'function', 'every job is metered to its payer');
  // The same job asked again while it runs (its caller was evicted): it waits for this run, and starts none.
  const second = computer.runJob({ id: 'j1', payer: { tenant: 't', agent: 'a' }, command: 'x', timeoutSeconds: 10 });
  // Another job on this object while one runs is refused.
  assert.equal((await computer.runJob({ id: 'other', payer: { tenant: 't', agent: 'a' }, command: 'x', timeoutSeconds: 10 })).code, 'job_running');
  assert.equal((await computer.stopJob()).stopped, true);
  assert.equal((await first).code, 'stopped');
  assert.equal((await second).code, 'stopped', "the second call answers the first run's result");
  assert.equal(runs.length, 1, 'one run');
  assert.equal(data.has('job:deadline'), false);
  assert.equal((await computer.stopJob()).stopped, false);

  // A run whose object died: its deadline stays, its container may still run. The alarm waits for the deadline.
  const third = computer.runJob({ id: 'j2', payer: { tenant: 't', agent: 'a' }, command: 'x', timeoutSeconds: 10 });
  while (runs.length < 2) await new Promise(resolve => setTimeout(resolve, 0));
  release();
  assert.equal((await third).ok, true);
  // Asked again after it ended (its caller lost the answer): the result it kept, not a second run; dropped after an hour.
  const again = await computer.runJob({ id: 'j2', payer: { tenant: 't', agent: 'a' }, command: 'x', timeoutSeconds: 10 });
  assert.deepEqual([again.ok, again.id, runs.length], [true, 'j2', 2]);
  assert.equal(data.get('job:result').expiresAt, now + 3_600_000);
  data.set('job:deadline', 5000);
  container.running = true;
  computer.provider = () => ({ sleepIfIdle: async () => undefined, dropStale: async () => {} });
  computer.releasePermit = async () => { data.set('released', true); };
  now = 4000;
  await computer.alarm();
  assert.equal(destroyed, 0);
  assert.equal(alarm, 5000);
  now = 5000;
  await computer.alarm();
  assert.equal(destroyed, 1);
  assert.equal(container.running, false);
  assert.equal(data.has('job:deadline'), false);
  assert.equal(data.get('released'), true);
});
