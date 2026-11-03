import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { memoryStorage } from "../shared/storage.ts";
import { ClientSessions } from "../src/client-sessions.ts";
import { makeChild, type DelegationContext } from "../src/client-sessions/delegation.ts";
import { postgresTail } from "../src/log-tail.ts";
import { AgentSupervisor } from "../src/supervisor.ts";
import { createHash } from "node:crypto";
import { Accounts } from "../src/accounts.ts";
import { postLedger } from "../src/billing.ts";
import { BoatRefused, type Machine, type ManagedMachines } from "../src/computers/managed.ts";
import { Computers } from "../src/computers/service.ts";
import { CreditHolds } from "../src/credit-holds.ts";
import { EndUserCredits } from "../src/end-user-credits.ts";
import { Outbound } from "../src/outbound.ts";
import { DEFAULT_PRICING, micros } from "../src/pricing.ts";
import { Tenants } from "../src/tenants.ts";
import { testDatabase } from "./database.ts";

export const HOUR = 3_600_000;

/** What Boat bills a small machine: a billable second every two seconds, at 1e-5 dollars each. */
export const cost = (ms: number) => Math.floor(ms / 2000) * 10;

/** Boat as these tests need it: a machine per key, what it has cost by the clock, and refusals when told to refuse. */
export function fakeBoat(clock: () => number) {
  const machines = new Map<string, { id: string; tenant: string; createdAt: number; since: string; ttlUntil: number }>();
  const state = { refusals: [] as { code: string; retryAfterMs?: number }[], loseAnswer: false, creates: 0, removed: [] as string[], extended: [] as number[], runs: [] as { command: string; timeoutSeconds: number }[], listFails: false, removeFails: false, stderr: "", hidden: new Set<string>(), dollars: undefined as number | undefined };
  let since = "2026-10-01T00:00:00.000Z";
  const expire = () => { for (const [key, machine] of machines) if (machine.ttlUntil <= clock()) machines.delete(key); };
  const boat: ManagedMachines = {
    async create(computer, tenant, ttlSeconds) {
      const refusal = state.refusals.shift();
      if (refusal) throw new BoatRefused(refusal);
      state.creates++;
      let machine = machines.get(computer);
      if (!machine) machines.set(computer, machine = { id: `bx_${machines.size + state.creates}`, tenant, createdAt: clock(), since, ttlUntil: clock() + ttlSeconds * 1000 });
      if (state.loseAnswer) { state.loseAnswer = false; throw new Error("the answer was lost"); }
      return { id: machine.id };
    },
    async extend(id, ttlSeconds) { state.extended.push(ttlSeconds); for (const machine of machines.values()) if (machine.id === id) machine.ttlUntil = clock() + ttlSeconds * 1000; },
    async remove(id) { if (state.removeFails) throw new Error("provider down"); state.removed.push(id); for (const [key, machine] of machines) if (machine.id === id) machines.delete(key); },
    async list(computer) {
      if (state.listFails) throw new Error("provider down");
      expire();
      return [...machines].filter(([key]) => computer ? key === computer : !state.hidden.has(key)).map(([key, machine]): Machine => {
        const start = Math.max(machine.createdAt, Date.parse(since) > machine.createdAt ? Date.parse(since) : 0);
        const micro = cost(clock() - start);
        return { id: machine.id, computer: key, tenant: machine.tenant, createdAt: machine.createdAt, since, seconds: micro / 10, dollars: state.dollars ?? micro / 1e6 };
      });
    },
    async run(_id, command, timeoutSeconds) { state.runs.push({ command, timeoutSeconds }); return { exitCode: 0, stdout: "done", stderr: state.stderr, truncated: false }; },
  };
  return { boat, state, machines, rollover: (at: string) => { since = at; } };
}

export async function fixture(options: { billing?: "prepaid" | "none"; flag?: boolean; platformKey?: boolean; adminKey?: boolean; purchased?: boolean; balance?: number; payer?: { id: string; bucket: string }; price?: number; extraAgents?: string[]; outbound?: any } = {}) {
  const { db } = await testDatabase();
  for (const [agent, tenant] of [["a", "payg"], ["b", "payg"], ["c", "rich"], ...(options.extraAgents ?? []).map(id => [id, "payg"])]) await db.query("insert into agents(id,tenant,header,revision,name,type,model) values ($1,$2,'{}',1,'A','test','x')", [agent, tenant]);
  const entry = (name: string, extra = {}) => ({ tokenSha256: createHash("sha256").update(name).digest("hex"), apiKeys: {}, billing: options.billing ?? "prepaid", ...extra });
  const tenants = new Tenants({ read: async () => JSON.stringify({ tenants: { payg: entry("payg", options.adminKey ? { apiKeys: { boat: "admin-key" } } : {}), rich: entry("rich") }, platformKeys: options.platformKey === false ? {} : { boat: "platform-key" } }) });
  await tenants.reload();
  const accounts = new Accounts({ db, tenants, pricing: { ...DEFAULT_PRICING, ...options.price ? { computerHour: options.price } : {} }, secretsKey: "ab".repeat(32) });
  const endUsers = new EndUserCredits(db), credit = new CreditHolds(db, accounts.billing);
  const balanceAtStart = options.balance ?? micros(10);
  await postLedger(db, [options.purchased === false ? { tenant: "payg", kind: "grant", amount: balanceAtStart, key: "fund" } : { tenant: "payg", kind: "purchase", amount: balanceAtStart, key: "fund" }, { tenant: "rich", kind: "purchase", amount: micros(10), key: "fund-rich" }]);
  accounts.billing.invalidate(["payg", "rich"]);
  let now = Date.now();
  const { boat, state, machines, rollover } = fakeBoat(() => now);
  const keys: string[] = [], waits: number[] = [];
  const make = (flag: boolean) => new Computers({ db, accounts, outbound: options.outbound ?? new Outbound(), now: () => now, enabled: flag, runtime: "https://run.test", endUsers: () => endUsers, credit: () => credit, payer: () => options.payer, machines: options.outbound ? undefined : key => { keys.push(key); return boat; }, sleep: async ms => { waits.push(ms); },
    driver: () => ({ async create(id: string) { return { id }; }, async call() { return { exitCode: 0, stdout: "byo" }; }, async close() {} }) });
  const service = make(options.flag !== false);
  const logged: any[] = [], error = console.error;
  console.error = (line: string) => { try { logged.push(JSON.parse(line)); } catch { error(line); } };
  const row = async (agent = "a") => (await db.query("select * from managed_computers where agent=$1 order by ended_at is null desc, created_at desc limit 1", [agent])).rows[0];
  const rows = async () => (await db.query("select * from managed_computers")).rows;
  const balance = async (tenant = "payg") => Number((await db.query("select balance from credit_accounts where tenant=$1", [tenant])).rows[0]?.balance ?? 0);
  const spent = async (tenant = "payg") => (tenant === "payg" ? balanceAtStart : micros(10)) - await balance(tenant);
  const holds = async () => (await db.query("select * from end_user_holds")).rows;
  const connect = (tenant = "payg", agent = "a", input: Record<string, number> = {}, on = service) => on.create(tenant, { agent, provider: "boat", ...input });
  const start = (tenant = "payg", agent = "a", key = "start", on = service) => on.call(tenant, agent, "computer_start", {}, key);
  const stop = (tenant = "payg", agent = "a", key = "stop") => service.call(tenant, agent, "computer_stop", {}, key);
  const exec = (key: string, args: Record<string, unknown> = {}) => service.call("payg", "a", "computer_exec", { command: "make", ...args }, key);
  return { db, accounts, endUsers, credit, service, make, state, machines, rollover, keys, waits, logged, row, rows, balance, spent, holds, connect, start, stop, exec, advance: (ms: number) => { now += ms; }, now: () => now, done: () => { console.error = error; } };
}

export const pass = (f: { service: Computers }) => f.service.managed.pass();

export const fund = async (f: Awaited<ReturnType<typeof fixture>>, amount = micros(1)) => { await f.endUsers.setSettings("payg", { enabled: true }); await f.endUsers.post("payg", "u", { kind: "grant", amount, key: "grant" }); };

export const USER = { id: "u", bucket: "work" };

// Exercise the shared child factory used by delegate, spawn_agent and run_workflow.
export async function family(t: { after(fn: () => Promise<void> | void): void }, subagents?: boolean) {
  const f = await fixture();
  const root = await mkdtemp(join(tmpdir(), "computer-children-"));
  const storage = memoryStorage(postgresTail(f.db, { unfenced: true }));
  const supervisor = new AgentSupervisor(root, { storage });
  const sessions = new ClientSessions(supervisor, { db: f.db, storage, secret: "computer-children-test-secret-32-chars", computers: f.service });
  // One teardown, in order: the sessions and their log tail stop before the database they use closes, or the tail keeps
  // retrying against a closed pool and the file never exits.
  t.after(async () => { await sessions.close(); await supervisor.close(); await rm(root, { recursive: true, force: true }); await f.done(); });
  // No model calls are needed: the factory attaches computers before any child is prompted.
  const model = { id: "fixture", name: "Fixture", api: "openai-completions", provider: "openai", baseUrl: "http://127.0.0.1:9/v1", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1024 } as Model<Api>;
  const parent = (await sessions.create([], { model }, "computer-parent", {}, "payg")).id;
  if (subagents !== undefined) await f.service.create("payg", { agent: parent, provider: "boat", subagents, leaseSeconds: 600, dailySeconds: 1200 });
  sessions.options.createAgent = (tenant, params, key, parent) => sessions.create([], { model }, key, {}, tenant, undefined, params.mounts, undefined, undefined, { parent });
  const ctx = (sessions as unknown as { delegationContext: DelegationContext }).delegationContext;
  const child = (of: string, key: string) => makeChild(ctx, sessions.sessions.get(of)!, { id: "run" } as Parameters<typeof makeChild>[2], undefined, key, key, 1);
  return { ...f, sessions, parent, child };
}
