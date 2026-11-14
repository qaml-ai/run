import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Exercise the runtime methods with only their storage and computer dependencies replaced.
function method(file: string, name: string, globals: Record<string, unknown> = {}) {
  const text = readFileSync(new URL(`../src/${file}.ts`, import.meta.url), "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const selected = source.statements.flatMap(node => ts.isClassDeclaration(node) ? [...node.members] : [node]).filter(node =>
    (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name?.getText(source) === name ||
    ts.isVariableStatement(node) && node.declarationList.declarations.some(d => d.name.getText(source) === name));
  assert.equal(selected.length, 1);
  const declaration = selected[0].getText(source).replace(/^export /, "");
  const methodDeclaration = declaration.replace(/^private /, "").replace(/^(async )?/, "$1function ");
  const code = ts.transpileModule(ts.isMethodDeclaration(selected[0]) ? methodDeclaration : declaration, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  return runInNewContext(`${code}\n${name}`, globals);
}
const key = method("agent-lifecycle", "COMPUTER_ATTACHED");
const clearComputerAttached = method("agent-runtime", "clearComputerAttached", { COMPUTER_ATTACHED: key });

test("computer tool discovery remembers both attachment states", async () => {
  const data = new Map();
  let tools: { name: string }[] = [];
  const discover = method("agent-tools", "computerNamesImpl", {
    COMPUTER_ATTACHED: key, ComputerService: class { async tools() { return tools; } },
  });
  const runtime = { computerAttachmentGeneration: 0, env: { HYPERDRIVE: {} }, config: async () => ({ id: "agent", tenantId: "tenant" }),
    ctx: { storage: { put: async (key: string, value: unknown) => { data.set(key, value); } } } };
  assert.equal((await discover.call(runtime)).size, 0);
  assert.equal(data.get(key), false);
  tools = [{ name: "computer_start" }];
  assert.deepEqual([...(await discover.call(runtime))], ["computer_start"]);
  assert.equal(data.get(key), true);
});

test("discovery from before invalidation leaves the current attachment hint alone", async () => {
  for (const refresh of [false, true]) {
    const data = new Map([[key, false]]);
    const started = Promise.withResolvers<void>();
    const stale = Promise.withResolvers<{ name: string }[]>();
    let reads = 0;
    const discover = method("agent-tools", "computerNamesImpl", {
      COMPUTER_ATTACHED: key, ComputerService: class {
        async tools() {
          if (reads++ > 0) return [{ name: "computer_start" }];
          started.resolve();
          return stale.promise;
        }
      },
    });
    const runtime = {
      computerAttachmentGeneration: 0, clearComputerAttached,
      env: { HYPERDRIVE: {} }, config: async () => ({ id: "agent", tenantId: "tenant" }),
      ctx: { storage: {
        put: async (name: string, value: boolean) => { data.set(name, value); },
        delete: async (name: string) => data.delete(name),
      } },
    };
    const pending = discover.call(runtime);
    await started.promise;
    await runtime.clearComputerAttached();
    if (refresh) await discover.call(runtime);
    stale.resolve([]);
    await pending;
    assert.equal(data.get(key), refresh ? true : undefined);
  }
});

test("every computer operation clears the attachment hint before it runs", async () => {
  for (const operation of ["refresh", "remove", "fork", "release", "sweep", "confirm-cleanup", "computer_start"]) {
    for (const attached of [false, true]) {
      const data = new Map<string, unknown>([[key, attached]]);
      const check = async () => { assert.equal(data.has(key), false, operation); return {}; };
      const conf = { id: "agent", tenantId: "tenant" };
      const fetch = method("agent-http", "fetchRequestImpl", {
        URL, body: (request: Request) => request.json(),
        json: (value: unknown, status = 200) => Response.json(value, { status }),
        forkComputerInto: check,
        ComputerService: class { sweepAgent = check; remove = check; release = check; confirmCleanup = check; call = check; },
      });
      const runtime = { computerAttachmentGeneration: 0, clearComputerAttached,
        env: {}, config: async () => conf, refreshComputerTools: check, arm: check,
        serializeComputer: async (run: () => Promise<unknown>) => run(),
        ctx: { storage: { get: async () => conf, delete: async (key: string) => data.delete(key) } } };
      const response = await fetch.call(runtime, new Request("https://computer.internal/__computer", {
        method: "POST", body: JSON.stringify({ tenant: "tenant", operation, args: { agents: [] } }),
      }));
      assert.equal(response.status, operation === "fork" ? 201 : 200);
      assert.equal(data.has(key), false);
      assert.equal(runtime.computerAttachmentGeneration, 1);
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
        get: async (name: string) => name === key ? attached : name === "configuration" ? { id: "agent", tenantId: "tenant" } : name === key ? attached : undefined,
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

test("wake skips sweep only for a false attachment hint and processes only due decisions", async () => {
  const now = 100_000;
  const noop = async () => {};
  for (const [attached, deadline] of [[undefined, undefined], [false, now + 1], [true, now], [false, now - 1]] as const) {
    let expirations = 0, sweeps = 0;
    const wake = method("agent-lifecycle", "wakeImpl", {
      COMPUTER_ATTACHED: key, Date: { now: () => now }, restageInputMirrors: noop, flushScheduleOutcomes: noop,
      expireDecisions: async () => { expirations++; }, flushMonitors: noop, collectChecks: noop,
      ComputerService: class { async sweepAgent() { sweeps++; } },
    });
    const runtime = {
      env: {}, ctx: { storage: {
        get: async (name: string) => name === "decision-input-deadline" ? deadline :
          name === "configuration" ? { id: "agent", tenantId: "tenant" } : name === key ? attached : undefined,
        list: async () => new Map(),
      }, getWebSockets: () => [], waitUntil() {} },
      admission: Promise.resolve(), configurationQueue: { kick() {} }, promptPreparations: { sweep: noop },
      resumeKeptQueue: noop, restoreCancellations: noop, serializeComputer: (run: () => Promise<void>) => run(),
      flushBilling: noop, flushTerminalEvents: noop, closeHumanInputs: noop, kickInputPrompts() {},
      restoreHostAdmissions: noop, limits: { check: async () => false }, delegation: { recover: noop },
      notifications: { drain: noop }, outbox: { flush: noop }, batchQueue: { kick() {} }, records: async () => [],
      arm: noop,
    };
    await wake.call(runtime);
    assert.equal(sweeps, attached === false ? 0 : 1);
    assert.equal(expirations, deadline !== undefined && deadline <= now ? 1 : 0);
  }
});

test("startup recovers decisions only for configured live agents", async () => {
  const now = 100_000;
  const noop = async () => {};
  for (const state of ["live", "unconfigured", "deleted", "expired"]) {
    let expirations = 0;
    const restore = method("agent-lifecycle", "restorePendingImpl", {
      Date: { now: () => now }, SLOW_START_STEP_MS: 2000,
      timed: (_runtime: unknown, _step: string, run: () => Promise<void>) => run(),
      goneStart: noop, expireDecisions: async () => { expirations++; }, stageMissedEndings: noop, restageInputMirrors: noop,
    });
    const runtime = {
      constructedAt: now, ctx: { storage: {
        get: async (name: string) => name === "deleted" ? state === "deleted" :
          name === "configuration" && state !== "unconfigured" ? { expiresAt: state === "expired" ? now : now + 1 } : undefined,
        list: async () => new Map(),
      }, waitUntil() {} },
      configurationQueue: { kick() {} }, promptPreparations: { sweep: noop }, resumeKeptQueue: noop,
      restoreCancellations: noop, restoreHostAdmissions: noop, delegation: { recover: noop },
      notifications: { drain: noop }, outbox: { flush: noop }, records: async () => [],
      flushTerminalEvents: noop, batchQueue: { kick() {} }, kickInputPrompts() {},
      arm: noop, invalidateMaintenance() {},
    };
    await restore.call(runtime);
    assert.equal(expirations, state === "live" ? 1 : 0);
  }
});


test("connection writers commit before clearing the affected agent", async () => {
  for (const writer of ["create", "inherit", "fork", "detach local", "detach remote", "account delete"]) {
    const calls: string[] = [];
    const row = { id: "connection", agent: "target" };
    const sql = { async query(query: string) {
      if (/^(insert into|update|delete from) computer_connections/.test(query)) {
        calls.push("write");
        return { rows: writer === "account delete" ? [row, { agent: "removed:already" }] : [row], rowCount: 1 };
      }
      if (query.startsWith("insert into computer_attachment_clears")) calls.push("pending");
      if (query.startsWith("delete from computer_attachment_clears")) calls.push("ack");
      return { rows: [row], rowCount: 1 };
    } };
    const withSql = (_env: unknown, run: Function) => run(sql);
    const writeComputerConnections = method("computers/attachment-hint", "writeComputerConnections", {
      crypto, applyScope: { getStore: () => undefined },
      transaction: async (_env: unknown, write: Function) => {
        const result = await write(sql);
        calls.push("commit");
        return result;
      },
      clear: (env: unknown, agent: string, token: string, local: unknown) => clear(env, agent, token, local),
    });
    const clear = method("computers/attachment-hint", "clear", { withSql });
    const clearComputerAttached = async () => { calls.push("local"); return true; };
    const env = { AGENTS: { getByName(agent: string) {
      assert.equal(agent, 'target');
      return { async clearComputerAttached() { calls.push("rpc"); return true; } };
    } } };
    const globals = {
      withSql, writeComputerConnections, id: () => "new-id", seal: async () => ({}),
      connectionInput: () => ({ agent: "target" }), publicConnection: (row: unknown) => row,
      computerOwner: async () => "parent", ComputerService: class { credentials() { return {}; } },
      forkRows: { attachable: async () => ({ id: "seed" }) }, latest: async () => null,
    };
    // Create's duplicate check has no row. The other writers use the same mock connection.
    const query = sql.query.bind(sql);
    sql.query = async (text: string) => text.startsWith("select 1 from computer_connections")
      ? { rows: [], rowCount: 0 } : query(text);
    const attach = method("computers/service", "attachConnection", globals);
    const methods = { ...globals, attachConnection: attach };
    const runtime = { env, tenant: "tenant", stop: async () => {}, localAttachmentHint: writer === "detach local" ? { agent: "target", clearComputerAttached } : undefined };
    if (writer === "inherit") await method("computers/service", "inheritComputer", methods)(env, "tenant", "parent", "target");
    else if (writer === "fork") await method("computers/service", "forkInto", methods).call(runtime, "parent", { id: "seed" }, ["target"]);
    else if (writer === "account delete") await method("computers/service", "deleteTenantComputerConnections", methods)(env, "tenant");
    else if (writer.startsWith("detach")) await method("computers/service", "detach", methods).call(runtime, row);
    else await method("computers/service", "create", methods).call(runtime, {});
    assert.deepEqual(calls, ["write", "pending", "commit", writer === "detach local" ? "local" : "rpc", "ack"], writer);
  }
});

test("a failed post-commit clear stays pending and maintenance retries it", async () => {
  const calls: string[] = [];
  const row = { agent: "target", token: crypto.randomUUID() };
  const sql = { async query(query: string) {
    if (query.includes("set due_at")) { calls.push("claim"); return { rows: [row] }; }
    if (query.startsWith("insert")) calls.push("pending");
    if (query.startsWith("delete")) calls.push("ack");
    return { rows: [] };
  } };
  const withSql = (_env: unknown, run: Function) => run(sql);
  const clear = method("computers/attachment-hint", "clear", { withSql });
  const clearError = class extends Error {};
  const write = method("computers/attachment-hint", "writeComputerConnections", {
    clear, crypto, applyScope: { getStore: () => undefined }, ComputerHintClearError: clearError,
    transaction: async (_env: unknown, run: Function) => {
      const result = await run(sql);
      calls.push("commit");
      return result;
    },
  });
  let unavailable = true;
  const env = { AGENTS: { getByName: () => ({ async clearComputerAttached() {
    calls.push("rpc");
    if (unavailable) throw new Error("unavailable");
  } }) } };
  await assert.rejects(write(env, async () => ({ value: null, agents: [row.agent] })), clearError);
  assert.deepEqual(calls, ["pending", "commit", "rpc"]);
  unavailable = false;
  await method("computers/attachment-hint", "sweepComputerAttachmentClears", { withSql, clear })(env);
  assert.deepEqual(calls, ["pending", "commit", "rpc", "claim", "rpc", "ack"]);
});
