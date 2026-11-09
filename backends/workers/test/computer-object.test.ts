import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

test('an idle alarm waits for the exec deadline without blocking concurrent commands, then checks at completion', async () => {
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
  let now = 1000, alarm: number | null = null, release!: () => void;
  const alarms: number[] = [];
  const held = new Promise<void>(resolve => { release = resolve; });
  class Host {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) { this.ctx = ctx; this.env = env; }
  }
  class Clock extends Date { static now() { return now; } }
  const Computer = runInNewContext(outputText.replace(/\bexport \{\};?\s*$/, '') + '\nContainerComputer', {
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
