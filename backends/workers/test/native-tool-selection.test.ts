import assert from "node:assert/strict";
import test from "node:test";
import { selectAgentTools } from "../src/file-tool-selection.ts";
import { hasComputer } from "../../../src/core/computer-share.ts";
import { applyScope } from "../../../shared/apply-scope.ts";
import { attachChildComputers, forkChildComputers, forkComputerInto, hasNativeComputer } from "../src/computers/child-fork.ts";

test("the native computer tool requires an agent that has a computer, and enabled codemode", () => {
  const tools = ["computer", "exec", "host_execute", "codemode", "computer_exec", "browser_click", "lookup"].map(name => ({ name }));
  const selected = (nativeComputer: boolean, config = {}) => {
    const selection = selectAgentTools(tools, new Set(), config, new Set(), nativeComputer);
    return {
      tools: selection.tools.map(tool => tool.name),
      modelTools: selection.modelTools.map(tool => tool.name),
    };
  };
  const ordinary = { tools: ["codemode", "lookup"], modelTools: ["codemode", "lookup"] };
  assert.deepEqual(selected(false), ordinary, "an agent without a computer is not offered the tool, to the model or to code");
  const native = { tools: ["computer", "codemode", "lookup"], modelTools: ["computer", "codemode", "lookup"] };
  assert.deepEqual(selected(true), native, "an agent with a computer gets the registered tool");
  assert.deepEqual(selected(true, { codeMode: false }), { tools: ["lookup"], modelTools: ["lookup"] }, "disabling codemode also hides the native tool");
});

/** The rows the computer checks read: agents (their configuration), computer_shares, computer_connections. */
function world(agents: Record<string, { computer?: object }>, connections: string[] = []) {
  const shares = new Map<string, string | null>(), touched: string[] = [];
  const sql = {
    async query(text: string, values: any[] = []) {
      const rows = (found: unknown[]) => ({ rows: found as any[], rowCount: found.length });
      if (/^select owner from computer_shares/.test(text)) return rows(shares.has(values[1]) ? [{ owner: shares.get(values[1]) }] : []);
      if (/^insert into computer_shares/.test(text)) { if (!shares.has(values[1])) shares.set(values[1], values[2] ?? null); return rows([]); }
      if (/^select header, revoked from agents/.test(text)) return rows(agents[values[0]] ? [{ header: { id: values[0], tenantId: "t", config: agents[values[0]], initialized: true }, revoked: false }] : []);
      if (/^select 1 from agents/.test(text)) return rows(agents[values[1]] ? [{}] : []);
      if (/from computer_connections/.test(text)) return rows(connections.includes(values[1]) ? [{ id: `cmp_${values[1]}`, agent: values[1] }] : []);
      throw new Error(`unexpected query: ${text}`);
    },
  };
  const computers = { getByName(name: string) { touched.push(name); return { forkSnapshot: async () => ({ ok: false, code: "NO_SESSION" }), hasDisk: async () => false }; } };
  const env = (containers = true) => ({ ...(containers ? { COMPUTER_CONTAINERS: computers } : {}), AGENTS: { idFromName: (name: string) => ({ toString: () => `do:${name}` }) } }) as never;
  const scoped = <T>(run: () => Promise<T>) => applyScope.run({ sql }, run);
  return { sql, shares, touched, env, scoped };
}

/** Agent ids as the directory makes them. */
const id = (name: string) => `client_${Buffer.from(name).toString("hex").padEnd(40, "0")}`;
const [plain, declared, sized, child, off, connected, sharer, target, c1, c2, c3, c4, c5, c6, c7] = ["plain", "declared", "sized", "child", "off", "connected", "sharer", "target", "c1", "c2", "c3", "c4", "c5", "c6", "c7"].map(id);

test("an agent has a computer when its configuration declares one or it shares its parent's; a deployment that offers them gives none", async () => {
  const w = world({ [plain]: {}, [declared]: { computer: {} }, [sized]: { computer: { instance: "standard-1" } }, [child]: {}, [off]: { computer: {} } });
  w.shares.set(child, declared);
  w.shares.set(off, null);
  assert.equal(await hasComputer(w.sql, "t", plain, false), false);
  assert.equal(await hasComputer(w.sql, "t", declared, true), true);
  assert.equal(await hasComputer(w.sql, "t", child, false), true, "a share is a computer");
  assert.equal(await hasComputer(w.sql, "t", off, true), false, "computer: \"none\" wins over a declaration");
  await w.scoped(async () => {
    assert.equal(await hasNativeComputer(w.env(), "t", plain), false, "containers bound, nothing declared: no computer");
    assert.equal(await hasNativeComputer(w.env(), "t", declared), true, "computer: {} is the default computer");
    assert.equal(await hasNativeComputer(w.env(), "t", sized), true);
    assert.equal(await hasNativeComputer(w.env(), "t", child), true);
    assert.equal(await hasNativeComputer(w.env(), "t", off), false);
    assert.equal(await hasNativeComputer(w.env(false), "t", declared), false, "no native computers on this deployment");
  });
});

test("a child shares only a computer its parent has: without one the default is none", async () => {
  const w = world({ [plain]: {}, [declared]: { computer: {} }, [connected]: {}, [sharer]: {}, [off]: { computer: {} } }, [connected]);
  w.shares.set(sharer, declared);
  w.shares.set(off, null);
  await w.scoped(async () => {
    await attachChildComputers(w.env(), "t", plain, c1, "share");
    await attachChildComputers(w.env(), "t", declared, c2, "share");
    await attachChildComputers(w.env(), "t", connected, c3, "share");
    await attachChildComputers(w.env(), "t", sharer, c4, "share");
    await attachChildComputers(w.env(), "t", off, c5, "share");
    await attachChildComputers(w.env(), "t", declared, c6, "none");
    await attachChildComputers(w.env(false), "t", declared, c7, "share");
    for (const made of [c1, c5, c6, c7]) assert.equal(await hasNativeComputer(w.env(), "t", made), false, made);
    for (const made of [c2, c4]) assert.equal(await hasNativeComputer(w.env(), "t", made), true, made);
  });
  assert.deepEqual(Object.fromEntries(w.shares), { [sharer]: declared, [off]: null, [c1]: null, [c2]: declared, [c3]: connected, [c4]: declared, [c5]: null, [c6]: null, [c7]: null });
  assert.deepEqual(w.touched, [], "deciding starts no container");
});

test("forking an agent without a computer reaches no container, and a fork goes only to agents that have one", async () => {
  const w = world({ [plain]: {}, [declared]: { computer: {} }, [target]: {} });
  const serialize = <T>(run: () => Promise<T>) => run(), setup = async () => ({}) as never;
  await w.scoped(async () => {
    await assert.rejects(forkChildComputers(w.env(), "t", plain, "b1", setup, serialize), (error: any) => error.code === "NO_SESSION");
    assert.deepEqual(w.touched, [], "its computer object is never reached");
    await assert.rejects(forkComputerInto(w.env(), "t", declared, [target], { setup, serialize }),
      (error: any) => error.status === 409 && error.code === "NO_COMPUTER" && /add `computer` to its definition/.test(error.message));
    assert.deepEqual(w.touched, []);
    await assert.rejects(forkChildComputers(w.env(), "t", declared, "b2", setup, serialize), (error: any) => error.code === "NO_SESSION");
    assert.deepEqual(w.touched, [`do:${declared}`], "an agent with a computer is asked for its snapshot");
  });
});
