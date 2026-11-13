import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Exercise the runtime methods with only their storage and computer dependencies replaced.
function method(file: string, name: string, globals: Record<string, unknown> = {}) {
  const text = readFileSync(new URL(`../src/${file}.ts`, import.meta.url), "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const selected = source.statements.filter(node =>
    ts.isFunctionDeclaration(node) && node.name?.text === name ||
    ts.isVariableStatement(node) && node.declarationList.declarations.some(d => d.name.getText(source) === name));
  assert.equal(selected.length, 1);
  const code = ts.transpileModule(selected[0].getText(source).replace(/^export /, ""), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  return runInNewContext(`${code}\n${name}`, globals);
}
const key = method("agent-lifecycle", "COMPUTER_ATTACHED");

test("computer tool discovery remembers both attachment states", async () => {
  const data = new Map();
  let tools: { name: string }[] = [];
  const discover = method("agent-tools", "computerNamesImpl", {
    COMPUTER_ATTACHED: key, ComputerService: class { async tools() { return tools; } },
  });
  const runtime = { env: { HYPERDRIVE: {} }, config: async () => ({ id: "agent", tenantId: "tenant" }),
    ctx: { storage: { put: async (key: string, value: unknown) => { data.set(key, value); } } } };
  assert.equal((await discover.call(runtime)).size, 0);
  assert.equal(data.get(key), false);
  tools = [{ name: "computer_start" }];
  assert.deepEqual([...(await discover.call(runtime))], ["computer_start"]);
  assert.equal(data.get(key), true);
});

test("every computer operation clears the attachment hint before it runs", async () => {
  for (const operation of ["refresh", "remove", "fork", "release", "sweep", "confirm-cleanup", "computer_start"]) {
    for (const attached of [false, true]) {
      const data = new Map<string, unknown>([[key, attached]]);
      const check = async () => { assert.equal(data.has(key), false, operation); return {}; };
      const conf = { id: "agent", tenantId: "tenant" };
      const fetch = method("agent-http", "fetchRequestImpl", {
        COMPUTER_ATTACHED: key, URL, body: (request: Request) => request.json(),
        json: (value: unknown, status = 200) => Response.json(value, { status }),
        forkComputerInto: check,
        ComputerService: class { sweepAgent = check; remove = check; release = check; confirmCleanup = check; call = check; },
      });
      const runtime = { env: {}, config: async () => conf, refreshComputerTools: check, arm: check,
        serializeComputer: async (run: () => Promise<unknown>) => run(),
        ctx: { storage: { get: async () => conf, delete: async (key: string) => data.delete(key) } } };
      const response = await fetch.call(runtime, new Request("https://computer.internal/__computer", {
        method: "POST", body: JSON.stringify({ tenant: "tenant", operation, args: { agents: [] } }),
      }));
      assert.equal(response.status, operation === "fork" ? 201 : 200);
      assert.equal(data.has(key), false);
    }
  }
});

test("arming skips only a known absent computer and preserves live lease deadlines", async () => {
  const due = Date.now() + 60_000;
  for (const attached of [undefined, false, true]) {
    let queries = 0;
    const jobs: { time: number }[] = [];
    const arm = method("agent-lifecycle", "armImpl", {
      COMPUTER_ATTACHED: key, TERMINAL_EVENTS_PREFIX: "terminal:",
      ComputerService: class { async nextDeadline() { queries++; return due; } },
      inputAdmissionDeadline: () => Infinity, checkGcDeadline: async () => Infinity,
    });
    const runtime = {
      invalidateMaintenance() {}, maintenanceGeneration: 0,
      ctx: { storage: {
        get: async (name: string) => name === key ? attached : name === "configuration" ? { id: "agent", tenantId: "tenant" } : undefined,
        list: async () => new Map(),
      }, getWebSockets: () => [] },
      env: {}, records: async () => [], delegation: { children: async () => [] },
      cancellations: new Set(), notifications: { pending: async () => false },
      outbox: { deadline: async () => null }, promptPreparations: { deadline: async () => Infinity },
      batchQueue: { deadline: async () => Infinity }, limits: { deadline: async () => Infinity },
      lifecycle: { jobs: { push: async (job: { time: number }) => { jobs.push(job); } } },
    };
    await arm.call(runtime);
    assert.equal(queries, attached === false ? 0 : 1);
    assert.deepEqual(jobs.map(job => job.time), attached === false ? [] : [due]);
  }
});
