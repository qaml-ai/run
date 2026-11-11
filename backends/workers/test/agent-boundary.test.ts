import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { ARM_AGENT, DUE_HUMAN_INPUTS } from "../src/agent-internals.ts";

test("the Durable Object preserves its RPC boundary and gates pilot counters", async () => {
  const methods = [
    "removeMember", "databaseProfile",
    "purgeAccountData", "admitDelegateWake", "receiveAgentMessage", "receiveProgress", "receiveEnding", "admitDelegated",
    "hasChild", "cancelRequest", "fetch", "onStart", "onJob",
    "webSocketMessage", "webSocketClose", "webSocketError",
  ];
  const source = readFileSync(new URL("../src/agent.ts", import.meta.url), "utf8");
  // Run the real wrapper with an inert runtime. Native private fields remain native,
  // so this checks the RPC boundary without loading workerd or invoking a model.
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    transformers: { before: [context => root => ts.visitEachChild(root, node => {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return undefined;
      if (ts.isClassDeclaration(node)) return context.factory.updateClassDeclaration(
        node, node.modifiers?.filter(modifier => modifier.kind !== ts.SyntaxKind.ExportKeyword),
        node.name, node.typeParameters, node.heritageClauses, node.members,
      );
      return node;
    }, context)] },
  });
  const calls: Array<{ name: string; args: unknown[]; receiver: unknown }> = [];
  const result = Promise.resolve("same promise");
  let constructed: unknown[] = [];
  class Runtime {
    constructor(...args: unknown[]) { constructed = args; }
  }
  for (const name of [...methods, "arm", "dueHumanInputs"]) Object.defineProperty(Runtime.prototype, name, {
    value: function (...args: unknown[]) { calls.push({ name, args, receiver: this }); return result; },
  });
  class Host {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) { this.ctx = ctx; this.env = env; }
  }
  const script = outputText.replace(/\bexport \{\};?\s*$/, "");
  const Agent = runInNewContext(`${script}\nCamelAgent`, { DurableObject: Host, AgentRuntime: Runtime, ARM_AGENT, DUE_HUMAN_INPUTS });
  const ctx = {}, env = { PILOT_DB_PROFILE: "1" }, agent = new Agent(ctx, env);
  assert.deepEqual(Object.getOwnPropertyNames(Agent.prototype), ["constructor", ...methods]);
  assert.deepEqual(Object.getOwnPropertySymbols(Agent.prototype), [ARM_AGENT, DUE_HUMAN_INPUTS]);
  assert.deepEqual(Reflect.ownKeys(agent), ["ctx", "env"], "the runtime cannot be read through an RPC property");
  assert.deepEqual(constructed, [ctx, env, agent]);
  const inputs = [{}, {}, {}, {}];
  for (const name of methods) assert.equal(agent[name](...inputs), result, name);
  assert.deepEqual(calls.map(call => call.name), methods);
  assert.ok(calls.every(call => call.receiver instanceof Runtime));
  assert.deepEqual(calls[0].args, [inputs[0]], "member removal forwards only the member ID");
  assert.equal(calls[1].args[0], inputs[0], "the profiling reset argument is preserved");
  assert.equal(calls[2].args[0], inputs[0], "argument identity is preserved");
  assert.equal(calls[2].args[1], inputs[1]);
  assert.equal(agent[ARM_AGENT](123), result);
  assert.deepEqual(calls.at(-1)?.args, [123]);
  assert.equal(calls.at(-1)?.name, "arm", "the subclass capability uses the runtime alarm implementation");
  assert.equal(agent[DUE_HUMAN_INPUTS](456), result);
  assert.deepEqual([calls.at(-1)?.name, calls.at(-1)?.args], ["dueHumanInputs", [456]], "the fixture capability uses the runtime's own expiry");
  const disabled = new Agent(ctx, {});
  await assert.rejects(disabled.databaseProfile(), /Pilot database profiling is disabled/);
  assert.equal(calls.at(-1)?.name, "dueHumanInputs", "disabled profiling never reaches the runtime");
});
