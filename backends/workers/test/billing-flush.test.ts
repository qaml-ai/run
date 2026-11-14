import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { AgentInvocation } from "../src/agent-invocation.ts";

const source = readFileSync(new URL("../src/agent-billing.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source.slice(source.indexOf("export async function flushBillingImpl")), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
});

function fixture(settleTurn: () => Promise<void>) {
  const exports = {} as { flushBillingImpl: (invocation: AgentInvocation, propagate?: boolean) => Promise<void> };
  runInNewContext(outputText, {
    exports,
    flushAttachmentTranscriptions: async () => {},
    flushAgentMediaUsage: async () => {},
    settleTurn,
  });
  const receipts = new Map([["billing:request", { tenantId: "tenant", agentId: "agent", requestId: "request" }]]);
  const lists: number[] = [];
  const releases: string[] = [];
  const retries: number[] = [];
  const runtime = {
    billingFlush: undefined as Promise<void> | undefined,
    instanceId: "test-instance",
    ctx: { storage: {
      list: async ({ prefix }: { prefix: string }) => {
        if (prefix !== "billing:") return new Map();
        lists.push(receipts.size);
        return new Map(receipts);
      },
      delete: async (key: string) => receipts.delete(key),
    } },
    env: { TENANTS: { getByName: () => ({ release: async (id: string) => { releases.push(id); } }) } },
    dbProfile: { run: (_phase: string, action: () => Promise<void>) => action() },
    testStorage: { get: async () => undefined },
    arm: async (at: number) => { retries.push(at); },
  };
  const flush = (propagate?: boolean) => exports.flushBillingImpl.call(runtime, new AgentInvocation(), propagate);
  return { flush, runtime, lists, releases, retries };
}

test("queued flushes list storage after the active pass acknowledges the receipt", async () => {
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const { flush, runtime, lists, releases } = fixture(async () => {
    started.resolve();
    await finish.promise;
  });
  const first = flush();
  await started.promise;
  const second = flush(true);
  const third = flush();
  await setImmediate();
  assert.deepEqual(lists, [1]);
  finish.resolve();
  await Promise.all([first, second, third]);
  assert.deepEqual(lists, [1, 0, 0]);
  assert.deepEqual(releases, ["agent:request"]);
  assert.equal(runtime.billingFlush, undefined);
});

test("flushes run in call order and each caller applies its own propagate flag", async () => {
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const errors = [new Error("first"), new Error("second"), new Error("third")];
  let attempts = 0;
  const { flush, lists, releases, retries } = fixture(async () => {
    const attempt = attempts++;
    if (attempt === 0) {
      started.resolve();
      await finish.promise;
    }
    if (attempt < errors.length) throw errors[attempt];
  });
  const first = assert.rejects(flush(true), error => error === errors[0]);
  await started.promise;
  const second = flush(false);
  const third = assert.rejects(flush(true), error => error === errors[2]);
  const fourth = flush(false);
  await setImmediate();
  assert.equal(attempts, 1);
  finish.resolve();
  await Promise.all([first, second, third, fourth]);
  assert.equal(attempts, 4);
  assert.deepEqual(lists, [1, 1, 1, 1]);
  assert.equal(retries.length, 3);
  assert.deepEqual(releases, ["agent:request"]);
});
