import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { ARM_AGENT } from "../src/agent-internals.ts";

test("the Durable Object exposes only its existing entry points and forwards the original context", () => {
  const methods = [
    "purgeAccountData", "admitDelegateWake", "receiveAgentMessage", "receiveAgentProgress",
    "hasBackgroundChild", "cancelRequest", "fetch", "onStart", "onJob",
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
  for (const name of [...methods, "arm"]) Object.defineProperty(Runtime.prototype, name, {
    value: function (...args: unknown[]) { calls.push({ name, args, receiver: this }); return result; },
  });
  class Host {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) { this.ctx = ctx; this.env = env; }
  }
  const script = outputText.replace(/\bexport \{\};?\s*$/, "");
  const Agent = runInNewContext(`${script}\nCamelAgent`, { DurableObject: Host, AgentRuntime: Runtime, ARM_AGENT });
  const ctx = {}, env = {}, agent = new Agent(ctx, env);
  assert.deepEqual(Object.getOwnPropertyNames(Agent.prototype), ["constructor", ...methods]);
  assert.deepEqual(Object.getOwnPropertySymbols(Agent.prototype), [ARM_AGENT]);
  assert.deepEqual(Reflect.ownKeys(agent), ["ctx", "env"], "the runtime cannot be read through an RPC property");
  assert.deepEqual(constructed, [ctx, env, agent]);
  const inputs = [{}, {}, {}, {}];
  for (const name of methods) assert.equal(agent[name](...inputs), result, name);
  assert.deepEqual(calls.map(call => call.name), methods);
  assert.ok(calls.every(call => call.receiver instanceof Runtime));
  assert.equal(calls[0].args[0], inputs[0], "argument identity is preserved");
  assert.equal(calls[0].args[1], inputs[1]);
  assert.equal(agent[ARM_AGENT](123), result);
  assert.deepEqual(calls.at(-1)?.args, [123]);
  assert.equal(calls.at(-1)?.name, "arm", "the subclass capability uses the runtime alarm implementation");
});
