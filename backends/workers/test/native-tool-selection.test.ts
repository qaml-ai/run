import assert from "node:assert/strict";
import test from "node:test";
import { selectAgentTools } from "../src/file-tool-selection.ts";
import { hasComputer } from "../../../src/core/computer-share.ts";
import { applyScope } from "../../../shared/apply-scope.ts";
import { attachChildComputers, forkChildComputers, forkComputerInto } from "../src/computers/child-fork.ts";

test("the Workers exposes bash and only the tools of an attached computer", () => {
  const tools = ["computer", "bash", "exec", "host_execute", "codemode", "computer_exec", "browser_click", "lookup"].map(name => ({ name }));
  const selected = (computers: string[], config = {}) => {
    const selection = selectAgentTools(tools, new Set(), config, new Set(computers));
    return {
      tools: selection.tools.map(tool => tool.name),
      modelTools: selection.modelTools.map(tool => tool.name),
    };
  };
  assert.deepEqual(selected([]), { tools: ["bash", "codemode", "lookup"], modelTools: ["bash", "codemode", "lookup"] });
  assert.deepEqual(selected(["computer_exec"], { codeMode: false }), {
    tools: ["bash", "computer_exec", "lookup"], modelTools: ["bash", "computer_exec", "lookup"],
  });
});

/** The rows the computer checks read: agents (their configuration), computer_shares, computer_connections. */
function world(agents: Record<string, { computer?: object }>, connections: string[] = []) {
  const shares = new Map<string, string | null>();
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
  const env = (compute = true) => ({
    ...(compute ? { CAMELFS_COMPUTE: "1", CAMELFS_URL: "https://example.invalid" } : {}),
    AGENTS: { idFromName: (name: string) => ({ toString: () => `do:${name}` }) },
  }) as never;
  const scoped = <T>(run: () => Promise<T>) => applyScope.run({ sql }, run);
  return { sql, shares, env, scoped };
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
  });
  assert.deepEqual(Object.fromEntries(w.shares), { [sharer]: declared, [off]: null, [c1]: null, [c2]: declared, [c3]: connected, [c4]: declared, [c5]: null, [c6]: null, [c7]: null });
});

test("forking requires an attached session", async () => {
  const w = world({ [plain]: {}, [declared]: { computer: {} }, [target]: {} });
  const serialize = <T>(run: () => Promise<T>) => run();
  await w.scoped(async () => {
    await assert.rejects(forkChildComputers(w.env(), "t", plain, "b1", serialize), (error: any) => error.code === "NO_SESSION");
    await assert.rejects(forkComputerInto(w.env(), "t", declared, [target], serialize), (error: any) => error.code === "NO_SESSION");
  });
});
