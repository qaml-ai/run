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
    COMPUTER_LIMITS: { execMs: 120_000, idleSeconds: { default: 60 } }, sameComputerNetwork: () => true,
    computerToolError: (error: unknown) => error,
    // No metered session here: the alarm's spend check has nothing to admit.
    ComputerMeter: class { async openPayer() { return undefined; } async isOpen() { return false; } }, meterBilling: () => ({}),
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
      return options.stop.aborted ? { ok: false, id: spec.id, code: 'stopped' } : { ok: true, id: spec.id };
    },
    ComputerMeter: class { async stopped() {} async alarm() {} async openPayer() { return undefined; } async isOpen() { return false; } },
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
  const second = await computer.runJob({ id: 'j1', payer: { tenant: 't', agent: 'a' }, command: 'x', timeoutSeconds: 10 });
  assert.equal(second.code, 'job_running');
  assert.equal((await computer.stopJob()).stopped, true);
  assert.equal((await first).code, 'stopped');
  assert.equal(data.has('job:deadline'), false);
  assert.equal((await computer.stopJob()).stopped, false);

  // A run whose object died: its deadline stays, its container may still run. The alarm waits for the deadline.
  const third = computer.runJob({ id: 'j2', payer: { tenant: 't', agent: 'a' }, command: 'x', timeoutSeconds: 10 });
  while (runs.length < 2) await new Promise(resolve => setTimeout(resolve, 0));
  release();
  assert.equal((await third).ok, true);
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

test('a running container whose payer may no longer spend is stopped: at its alarm, and when an operation is refused for spend', async () => {
  const now = 1000;
  class Host { ctx: any; env: unknown; constructor(ctx: unknown, env: unknown) { this.ctx = ctx; this.env = env; } }
  class Clock extends Date { static now() { return now; } }
  const refusal = Object.assign(new Error('This tenant has reached its monthly spend limit of $1.00'), { status: 402, code: 'SPEND_LIMIT' });
  let refuse: Error | undefined = refusal, session: { tenant: string; agent: string } | undefined = { tenant: 't', agent: 'a' }, bound: any;
  const logged: any[] = [], limitStops: number[] = [];
  const container = { running: true, destroy: async () => { container.running = false; } };
  const Computer = runInNewContext(computerSource(), {
    DurableObject: Host, Date: Clock, Promise, JSON, Map, Number, AbortSignal,
    console: { error: (line: string) => logged.push(JSON.parse(line)) },
    COMPUTER_LIMITS: { idleSeconds: { default: 60 } }, meterBilling: () => ({}),
    ComputerMeter: class {
      async openPayer() { return session; }
      async isOpen() { return !!session; }
      async admit() { if (refuse) throw refuse; }
      async stopped() {}
      async alarm() {}
      async started() {}
    },
    computerSpec: () => ({ instance: 'standard-1' }),
    // The provider's own stop (provider.ts stopForLimit: saves a sleeping computer's disk, else halts): seen here as a count.
    ContainerProvider: class {
      constructor(...args: any[]) { bound = args[5]; }
      async stopForLimit() { limitStops.push(now); container.running = false; return { saved: false }; }
      async sleepIfIdle() { return undefined; } async dropStale() {}
    },
  });
  const data = new Map<string, unknown>([['computer:permit', { tenant: 't', machine: 'native:a' }]]);
  let alarm: number | null = null;
  const computer = new Computer({ container, storage: {
    get: async (key: string) => data.get(key), put: async (key: string, value: unknown) => { data.set(key, value); }, delete: async (key: string) => data.delete(key),
    getAlarm: async () => alarm, setAlarm: async (at: number) => { alarm = at; },
  } }, {});
  let released = 0;
  computer.releasePermit = async () => { released++; data.delete('computer:permit'); };
  computer.network = () => ({ key: '', idleMs: 60_000 });

  // At its alarm: refused, so the container is stopped by the provider (charged up to now) and its slot given back.
  await computer.alarm();
  assert.equal(limitStops.length, 1);
  assert.equal(container.running, false);
  assert.equal(released >= 1, true);
  assert.deepEqual(logged.filter(line => line.type === 'computer_limit_stop').map(line => [line.tenant, line.status, line.code]), [['t', 402, 'SPEND_LIMIT']]);

  // An operation refused for the session's own payer: it fails, and the container stops at once.
  container.running = true; logged.length = 0;
  computer.provider({ settings: {}, identity: { claims: { tenant: 't', agent: 'a' } } });
  await assert.rejects(bound.admit(), (error: unknown) => error === refusal);
  assert.equal(limitStops.length, 2, 'stopped rather than idling out');

  // A shared computer: the session bills the owner, and a child at its own spend limit fails only its operation.
  container.running = true; logged.length = 0;
  session = { tenant: 't', agent: 'owner' };
  computer.provider({ settings: {}, shared: true, identity: { claims: { tenant: 't', agent: 'child' } } });
  await assert.rejects(bound.admit(), (error: unknown) => error === refusal);
  assert.equal(container.running, true, "the owner's container keeps running");
  assert.equal(limitStops.length, 2);
  assert.deepEqual(logged, []);

  // Anything else (the database unreadable) stops nothing: it is said, and the next alarm tries again.
  session = { tenant: 't', agent: 'a' };
  refuse = Object.assign(new Error('Query read timeout'), { status: 503 });
  await computer.alarm();
  assert.equal(container.running, true);
  assert.deepEqual(logged.map(line => line.type), ['computer_limits_read_failed']);
  // Within a minute it is admitted again.
  assert.equal(alarm !== null && alarm <= now + 60_000, true);
});
