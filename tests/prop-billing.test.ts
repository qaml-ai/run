import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import { Accounts } from "../src/accounts.ts";
import { accrueUsage, postLedger, type LedgerEntry, type LedgerKind, type UsageCharge } from "../src/billing.ts";
import { ClientSessions } from "../src/client-sessions.ts";
import type { Db } from "../src/db.ts";
import { getModels } from "../src/pi-catalog.ts";
import { platformUsage } from "../src/platform-pricing.ts";
import { activeCharge, DEFAULT_PRICING, MICROS, purchaseFee, storageCharge, usageTier, usageTiers, pricingFromEnvironment } from "../src/pricing.ts";
import { Tenants } from "../src/tenants.ts";
import { usageCost } from "../src/webhooks.ts";
import { memoryStorage, type Storage } from "../shared/storage.ts";
import type { AppendLog, CommitEffect } from "../shared/append-log.ts";
import { postgresTail } from "../src/log-tail.ts";
import type { Claim } from "../src/ownership.ts";
import type { TranscriptRecord } from "../src/transcript.ts";
import type { AgentSupervisor } from "../src/supervisor.ts";
import { testDatabase } from "./database.ts";
import { check, fc } from "./prop-helpers.ts";

/**
 * I4 (billing equals service) and I5 (spend limits hold), at the unit level: the pricing arithmetic, the ledger
 * (`postLedger`, `accrueUsage`) on real Postgres against a model of balances, usage flushes under lost commits, and an
 * agent's spend counter, committed with its transcript (`ClientSessions.spendEffect`), under failed commits and
 * takeovers (hypothesis H3).
 */

// --- Pricing arithmetic (pure) ---------------------------------------------------------------------------------------

test("active time: charges add up to the charge of the total, within a micro-USD per part, and never go negative", async t => {
  await check(t, fc.property(fc.array(fc.double({ min: 0, max: 3_600_000 * 24, noNaN: true }), { minLength: 1, maxLength: 50 }), fc.nat({ max: 10 * MICROS }), (parts, agentHour) => {
    const pricing = { ...DEFAULT_PRICING, agentHour };
    const charged = parts.map(ms => activeCharge(pricing, ms));
    for (const amount of charged) assert.ok(Number.isSafeInteger(amount) && amount >= 0);
    const whole = activeCharge(pricing, parts.reduce((sum, ms) => sum + ms, 0));
    // Each part rounds once: split time is charged within half a micro-USD per part of the time it adds up to.
    assert.ok(Math.abs(charged.reduce((sum, amount) => sum + amount, 0) - whole) <= Math.ceil(parts.length / 2) + 1);
  }), { runs: 300 });
});

test("storage and purchase fees: integers, never negative; fees in whole cents within half a cent of the rate", async t => {
  await check(t, fc.property(fc.nat({ max: 1e13 }), fc.integer({ min: 28, max: 31 }), fc.nat({ max: 10_000 }), fc.nat({ max: 1_000 * MICROS }), (bytes, days, bps, amount) => {
    const charge = storageCharge(DEFAULT_PRICING, bytes, days);
    assert.ok(Number.isSafeInteger(charge) && charge >= 0);
    // A month of daily charges is the month's price, within half a micro-USD a day.
    assert.ok(Math.abs(charge * days - bytes * DEFAULT_PRICING.storageGbMonth / 1e9) <= days / 2 + 1e-6 * bytes * DEFAULT_PRICING.storageGbMonth / 1e9);
    const fee = purchaseFee({ ...DEFAULT_PRICING, purchaseFeeBps: bps }, amount);
    assert.ok(Number.isSafeInteger(fee) && fee >= 0 && fee % 10_000 === 0);
    assert.ok(Math.abs(fee - amount * bps / 10_000) <= 5_000);
  }), { runs: 300 });
});

test("usage tiers: parsed or refused with a message; a tenant's tier is the highest it has paid for", async t => {
  const tier = fc.record({ name: fc.oneof(fc.string({ maxLength: 45 }), fc.constant(""), fc.integer()), paidUsd: fc.oneof(fc.double({ min: -5, max: 5_000 }), fc.constant(Number.NaN), fc.string()), busyAgents: fc.oneof(fc.integer({ min: -2, max: 2_000 }), fc.double()) }, { requiredKeys: [] });
  // Valid lists too: from 0, ascending, each with a name and a positive count.
  const valid = fc.uniqueArray(fc.integer({ min: 1, max: 5_000 }), { maxLength: 5 }).map(paid => [0, ...paid.sort((a, b) => a - b)].map((paidUsd, index) => ({ name: `T${index}`, paidUsd, busyAgents: index + 1 })));
  const text = fc.oneof(fc.json(), fc.array(tier, { maxLength: 6 }).map(tiers => JSON.stringify(tiers)), valid.map(tiers => JSON.stringify(tiers)), fc.string());
  // What a tenant paid: anything, or right at (or a micro-USD either side of) a tier's threshold.
  const paidNear = fc.tuple(fc.nat({ max: 5 }), fc.integer({ min: -1, max: 1 }), fc.integer({ min: -1_000 * MICROS, max: 10_000 * MICROS }), fc.boolean());
  await check(t, fc.property(text, paidNear, (input, [pick, nudge, anything, near]) => {
    let tiers;
    try { tiers = usageTiers(input); }
    catch (error) { assert.ok(error instanceof Error && error.message.startsWith("AGENT_USAGE_TIERS"), `refused with ${String(error)}`); return; }
    assert.equal(tiers[0].paid, 0);
    const paid = near ? tiers[pick % tiers.length].paid + nudge : anything;
    const { tier: found, next } = usageTier(tiers, paid);
    assert.ok(found.paid <= Math.max(paid, 0));
    if (next) assert.ok(next.paid > paid);
    assert.ok(tiers.every(entry => entry.paid > paid || entry.paid <= found.paid), "no tier between its own and what it paid");
  }), { runs: 400 });
});

test("pricing from the environment: any values give a pricing or an error naming the variable, never NaN prices", async t => {
  const names = ["AGENT_PRICE_AGENT_HOUR_USD", "AGENT_PRICE_STORAGE_GB_MONTH_USD", "AGENT_PRICE_WEB_SEARCH_USD", "AGENT_CREDIT_FEE_PERCENT", "AGENT_CREDIT_MIN_PURCHASE_USD", "AGENT_CREDIT_MAX_PURCHASE_USD", "AGENT_OPENROUTER_CREDIT_MULTIPLIER", "AGENT_FREE_MAX_STORAGE_GB"];
  const value = fc.oneof(fc.string({ maxLength: 8 }), fc.double().map(String), fc.integer({ min: -5, max: 2_000 }).map(String));
  await check(t, fc.property(fc.dictionary(fc.constantFrom(...names), value, { maxKeys: 4 }), env => {
    let pricing;
    try { pricing = pricingFromEnvironment(env); }
    catch (error) { assert.ok(error instanceof Error && /AGENT_/.test(error.message), `refused with ${String(error)}`); return; }
    // Prices are amounts the ledger holds exactly: safe integers of micro-USD.
    for (const amount of [pricing.agentHour, pricing.storageGbMonth, pricing.minPurchase, pricing.maxPurchase, pricing.purchaseFeeBps, pricing.webSearch.exa, pricing.free.hourlySpend]) {
      assert.ok(Number.isSafeInteger(amount) && amount >= 0, `price ${amount}`);
    }
    // Storage limits are byte counts, compared, never posted: any non-negative number (one past 2^53 is effectively no limit).
    for (const bytes of [pricing.maxStorageBytes, pricing.free.maxStorageBytes]) assert.ok(bytes >= 0);
    assert.ok(Number.isFinite(pricing.openrouterCreditMultiplier) && pricing.openrouterCreditMultiplier >= 0);
  }), { runs: 400 });
});

const catalog = getModels("anthropic").slice(0, 8).map(model => ({ provider: "anthropic", id: model.id }));
const count = fc.oneof(fc.nat({ max: 2_000_000 }), fc.constantFrom(-1, Number.NaN, Number.POSITIVE_INFINITY, 0), fc.string({ maxLength: 3 }));
const reported = fc.record({ input: count, output: count, cacheRead: count, cacheWrite: count, cost: fc.record({ total: fc.oneof(fc.double(), fc.constant(1e9)) }) }, { requiredKeys: [] });

test("platform usage is priced from the catalog: whatever cost a response claims, finite and never negative", async t => {
  await check(t, fc.property(reported, fc.constantFrom(...catalog), fc.option(fc.nat({ max: 100_000 }), { nil: undefined }), (usage, model, chars) => {
    const priced = platformUsage(usage as Record<string, unknown>, model.provider, model.id, chars === undefined ? undefined : { chars });
    const usd = usageCost(priced.usage).usd;
    assert.ok(Number.isFinite(usd) && usd >= 0, `charged ${usd}`);
    // The cost the response carried is never what is charged: the same tokens with no claimed cost cost the same.
    const { cost: _claimed, ...tokens } = usage as Record<string, unknown>;
    assert.equal(usd, usageCost(platformUsage(tokens, model.provider, model.id, chars === undefined ? undefined : { chars }).usage).usd);
    assert.equal(priced.known, true);
  }), { runs: 400 });
});

// --- The ledger, on Postgres -----------------------------------------------------------------------------------------

let db: pg.Pool;
before(async () => { ({ db } = await testDatabase()); });
const run = () => randomBytes(4).toString("hex");
const balances = async (tenants: string[]) => new Map((await db.query("select tenant, balance, purchased from credit_accounts where tenant = any($1)", [tenants])).rows.map(row => [row.tenant, { balance: Number(row.balance), purchased: Number(row.purchased) }]));
const ledger = async (tenants: string[]) => (await db.query("select tenant, kind, amount, idempotency_key as key, metadata, created_at from credit_ledger where tenant = any($1) order by id", [tenants])).rows.map(row => ({ ...row, amount: Number(row.amount), created_at: Number(row.created_at) }));

test("postLedger: each key posts once, and every balance is the sum of its ledger", async t => {
  const entry = fc.record({ tenant: fc.constantFrom("a", "b", "c"), kind: fc.constantFrom<LedgerKind>("grant", "purchase", "usage", "storage", "adjustment", "refund"), amount: fc.integer({ min: -1e12, max: 1e12 }), key: fc.constantFrom("k1", "k2", "k3", "k4", "k5", "k6") });
  await check(t, fc.asyncProperty(fc.array(fc.array(entry, { maxLength: 6 }), { minLength: 1, maxLength: 6 }), async batches => {
    const id = run();
    const named = (name: string) => `${id}-${name}`;
    const first = new Map<string, LedgerEntry>();
    for (const batch of batches) {
      const entries = batch.map(({ tenant, kind, amount, key }) => ({ tenant: named(tenant), kind, amount, key: named(key) }));
      const posted = await postLedger(db, entries);
      // What it returns is what it appended: the entries whose keys were new, one per key.
      const fresh = new Map<string, LedgerEntry>();
      for (const candidate of [...entries].sort((a, b) => a.tenant.localeCompare(b.tenant) || a.key.localeCompare(b.key))) if (!first.has(candidate.key) && !fresh.has(candidate.key)) fresh.set(candidate.key, candidate);
      assert.deepEqual(posted.map(row => row.key).sort(), [...fresh.keys()].sort());
      for (const row of posted) {
        assert.ok(!first.has(row.key), `key ${row.key} posted twice`);
        first.set(row.key, { tenant: row.tenant, kind: row.kind, amount: Number(row.amount), key: row.key });
      }
    }
    const tenants = ["a", "b", "c"].map(named);
    const rows = await ledger(tenants);
    assert.equal(rows.length, first.size, "one row per key");
    const accounts = await balances(tenants);
    for (const tenant of tenants) {
      const mine = rows.filter(row => row.tenant === tenant);
      assert.equal(accounts.get(tenant)?.balance ?? 0, mine.reduce((sum, row) => sum + row.amount, 0), `${tenant}'s balance is its ledger's sum`);
      assert.equal(accounts.get(tenant)?.purchased ?? 0, mine.filter(row => row.kind === "purchase" || row.kind === "refund").reduce((sum, row) => sum + row.amount, 0));
    }
  }), { runs: 40 });
});

test("accrueUsage: one entry per tenant-hour, holding that hour's charges, and balances move by exactly what is charged", async t => {
  const HOUR = 3_600_000;
  const flush = fc.record({
    at: fc.integer({ min: 0, max: 3 * HOUR }),
    charges: fc.uniqueArray(fc.record({ tenant: fc.constantFrom("a", "b", "c"), amount: fc.integer({ min: 1, max: 5_000_000 }), tokens: fc.nat({ max: 1_000_000 }), activeMs: fc.nat({ max: 60_000 }) }), { selector: charge => charge.tenant, minLength: 1, maxLength: 3 }),
  });
  await check(t, fc.asyncProperty(fc.array(flush, { minLength: 1, maxLength: 8 }), async flushes => {
    const id = run();
    const base = Date.UTC(2026, 9, 6, 10, 0, 0);
    const expected = new Map<string, { amount: number; tokens: number; activeMs: number }>();
    const spent = new Map<string, number>();
    for (const { at, charges } of flushes) {
      const now = base + at;
      const hour = Math.floor(now / HOUR) * HOUR;
      await accrueUsage(db, charges.map(({ tenant, amount, tokens, activeMs }): UsageCharge => ({ tenant: `${id}-${tenant}`, amount, metadata: { tokens, activeMs } })), now);
      for (const { tenant, amount, tokens, activeMs } of charges) {
        const key = `usage:${id}-${tenant}:${new Date(hour).toISOString()}`;
        const sum = expected.get(key) ?? { amount: 0, tokens: 0, activeMs: 0 };
        expected.set(key, { amount: sum.amount - amount, tokens: sum.tokens + tokens, activeMs: sum.activeMs + activeMs });
        spent.set(`${id}-${tenant}`, (spent.get(`${id}-${tenant}`) ?? 0) + amount);
      }
    }
    const tenants = ["a", "b", "c"].map(name => `${id}-${name}`);
    const rows = await ledger(tenants);
    assert.deepEqual(new Set(rows.map(row => row.key)), new Set(expected.keys()), "one usage entry per tenant-hour charged");
    for (const row of rows) {
      const want = expected.get(row.key)!;
      assert.equal(row.amount, want.amount);
      assert.equal(row.metadata.tokens, want.tokens);
      assert.equal(row.metadata.activeMs, want.activeMs);
      assert.equal(row.kind, "usage");
    }
    const accounts = await balances(tenants);
    for (const tenant of tenants) assert.equal(accounts.get(tenant)?.balance ?? 0, 0 - (spent.get(tenant) ?? 0));
    const minutes = (await db.query("select tenant, sum(amount)::bigint as amount from credit_spend_minutes where tenant = any($1) group by tenant", [tenants])).rows;
    for (const row of minutes) assert.equal(Number(row.amount), spent.get(row.tenant));
  }), { runs: 25 });
});

// --- Usage flushes under lost commits --------------------------------------------------------------------------------

type Fault = "none" | "before-commit" | "lost-ack";
/** The pool, with each transaction's commit failing as the next fault says: rolled back, or applied with its answer lost. */
function faulty(pool: pg.Pool, faults: Fault[]): Db {
  const connect = async () => {
    const client = await pool.connect();
    return new Proxy(client, {
      get(target, property, receiver) {
        if (property !== "query") return Reflect.get(target, property, receiver);
        return async (text: unknown, ...rest: unknown[]) => {
          if (text === "commit") {
            const fault = faults.shift() ?? "none";
            if (fault === "before-commit") throw new Error("connection reset before commit");
            if (fault === "lost-ack") { await target.query("commit"); throw new Error("connection reset after commit"); }
          }
          return (target.query as (...args: unknown[]) => unknown)(text, ...rest);
        };
      },
    });
  };
  return new Proxy(pool, { get: (target, property, receiver) => property === "connect" ? connect : Reflect.get(target, property, receiver) }) as Db;
}
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
async function prepaid(names: string[]) {
  const tenants = new Tenants({ read: async () => JSON.stringify({ tenants: Object.fromEntries(names.map(name => [name, { tokenSha256: sha(name), billing: "prepaid" }])) }) });
  await tenants.reload();
  return tenants;
}

test("usage flushes: a commit that fails, or whose answer is lost, is retried and charged exactly once; rounding stays within bounds", async t => {
  const response = fc.record({ usd: fc.oneof(fc.double({ min: 0, max: 0.05, noNaN: true }), fc.double({ min: 0, max: 2e-6, noNaN: true })), platform: fc.boolean(), kind: fc.constantFrom("tokens", "search", "toolSearch"), activeMs: fc.nat({ max: 5_000 }) });
  const step = fc.oneof({ weight: 4, arbitrary: response.map(value => ({ t: "response" as const, ...value })) }, { weight: 1, arbitrary: fc.constantFrom<Fault>("none", "before-commit", "lost-ack").map(fault => ({ t: "flush" as const, fault })) });
  await check(t, fc.asyncProperty(fc.array(step, { minLength: 1, maxLength: 30 }), async steps => {
    const id = run();
    const flaky = `${id}-flaky`, steady = `${id}-steady`;
    const faults: Fault[] = [];
    const tenants = await prepaid([flaky, steady]);
    // The same usage, recorded and flushed at the same points by two nodes: one whose commits fail, one whose do not.
    const failing = new Accounts({ tenants, db: faulty(db, faults) });
    const working = new Accounts({ tenants, db });
    let exact = 0, batches = 0;
    const record = (accounts: Accounts, tenant: string, value: { usd: number; platform: boolean; kind: string; activeMs: number }) => {
      accounts.recordUsage(tenant, "agent", { provider: "anthropic", model: "m", platform: value.platform, usage: { cost: { total: value.usd } },
        ...(value.kind === "search" ? { searches: 1 } : value.kind === "toolSearch" ? { toolSearch: true, toolSearches: 1 } : {}) });
      accounts.recordActive(tenant, "agent", value.activeMs);
    };
    for (const next of steps) {
      if (next.t === "response") {
        record(failing, flaky, next);
        record(working, steady, next);
        exact += (next.platform ? next.usd * MICROS : 0) + next.activeMs * DEFAULT_PRICING.agentHour / 3_600_000;
        continue;
      }
      faults.push(next.fault);
      await failing.flushUsage().catch(() => {});
      await working.flushUsage();
      batches++;
    }
    // Then both flush until nothing is left (the failing node's retries carry no new faults).
    faults.length = 0;
    await failing.flushUsage();
    await working.flushUsage();
    batches++;
    const accounts = await balances([flaky, steady]);
    const charged = { flaky: -(accounts.get(flaky)?.balance ?? 0), steady: -(accounts.get(steady)?.balance ?? 0) };
    // Faults never change what is charged: each batch applied exactly once.
    assert.equal(charged.flaky, charged.steady, `charged ${charged.flaky} with faults, ${charged.steady} without`);
    // And rounding: each batch rounds each of its four parts once, so the total stays within 2 micro-USD per batch.
    assert.ok(Math.abs(charged.steady - exact) <= 2 * batches + 1e-6 * exact, `charged ${charged.steady} for ${exact} over ${batches} batches`);
    const rows = await ledger([flaky, steady]);
    for (const tenant of [flaky, steady]) assert.equal(rows.filter(row => row.tenant === tenant).reduce((sum, row) => sum + row.amount, 0), accounts.get(tenant)?.balance ?? 0);
  }), { runs: 25 });
});

// --- Agent spend limits (I5, H3) -------------------------------------------------------------------------------------

type SpendLimit = { usd: number; spent: number; setAt: number };
type SpendSession = { header: { id: string; tenant: string }; claim?: Claim; spend?: SpendLimit | null; unwritten?: number };
type SpendInternals = {
  spendEffect(session: SpendSession, record: TranscriptRecord): CommitEffect | undefined;
  spendWrite(session: SpendSession, cost: number): CommitEffect | undefined;
  counted(session: SpendSession, cost: number): void;
  spent(session: SpendSession, cost: number): void;
  setSpendLimit(session: SpendSession, usd: number | null): Promise<void>;
  spendOf(session: SpendSession): Promise<SpendLimit | null>;
  agentSpendLimit(session: SpendSession): Promise<string | undefined>;
  close(): Promise<void>;
};
const spendCleanup: (() => Promise<void>)[] = [];
after(async () => { for (const cleanup of spendCleanup) await cleanup(); });
function spendNode() {
  const supervisor = { agents: new Map(), flush: async () => {}, stop: async () => {} } as unknown as AgentSupervisor;
  const node = new ClientSessions(supervisor, { secret: "s".repeat(32), db, storage: {} as Storage }) as unknown as SpendInternals;
  spendCleanup.push(() => node.close());
  return node;
}

/**
 * How a transcript commit (a transaction) fails: rolled back before its commit, applied with its answer lost, or its
 * spend write failing inside it. Each transaction takes the next fault.
 */
type CommitFault = "none" | "before-commit" | "lost-ack" | "spend-write";
function failingCommits(pool: pg.Pool, faults: CommitFault[]): Db {
  const connect = async () => {
    const client = await pool.connect();
    let fault: CommitFault = "none";
    return new Proxy(client, {
      get(target, property, receiver) {
        if (property !== "query") return Reflect.get(target, property, receiver);
        return async (text: unknown, ...rest: unknown[]) => {
          if (text === "begin") fault = faults.shift() ?? "none";
          if (fault === "spend-write" && typeof text === "string" && text.startsWith("update agent_spend_limits")) throw new Error("connection reset in the spend write");
          if (text === "commit") {
            if (fault === "before-commit") throw new Error("connection reset before commit");
            if (fault === "lost-ack") { await target.query("commit"); throw new Error("connection reset after commit"); }
          }
          return (target.query as (...args: unknown[]) => unknown)(text, ...rest);
        };
      },
    });
  };
  // Its own methods bound to it: `query` takes a client through `this.connect`, with a callback.
  return new Proxy(pool, { get: (target, property) => property === "connect" ? connect : typeof target[property as keyof pg.Pool] === "function" ? (target[property as keyof pg.Pool] as Function).bind(target) : Reflect.get(target, property) }) as Db;
}

/** A model response as the agent's transcript records it; `id` tells the test which it was. */
const response = (id: number, usd: number): TranscriptRecord => ({ t: "message", message: { role: "assistant", content: [], api: "anthropic-messages", provider: "anthropic", model: "m", stopReason: "stop", timestamp: id, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: usd } } } as never });

/**
 * One agent's transcript and spend across owners. Each owner holds a claim (its `actor_owners` epoch) and appends to
 * the agent's transcript (a segment log over a Postgres tail, as on S3), each record with what commits with it
 * (`spendEffect`, as `AgentSupervisor` appends it), and counts in memory what its runs see (`counted`, `spent`).
 */
async function spendAgent() {
  const agent = `agent-${run()}`;
  const faults: CommitFault[] = [];
  const storage = memoryStorage(postgresTail(failingCommits(db, faults)));
  const key = `sessions/${agent}/transcript`;
  const node = spendNode();
  let epoch = 0;
  /** What each record carried to the agent's spend when it committed, by its id. */
  const carried = new Map<number, number>();
  let ids = 0;
  const owner = async () => {
    const claim: Claim = { actor: agent, session: randomUUID(), epoch: ++epoch };
    await db.query("insert into actor_owners (actor, node, session, epoch) values ($1, 'node', $2, $3) on conflict (actor) do update set node = excluded.node, session = excluded.session, epoch = excluded.epoch", [agent, claim.session, claim.epoch]);
    const session: SpendSession = { header: { id: agent, tenant: "t" }, claim };
    const log: AppendLog<TranscriptRecord> = storage.log(key, claim);
    await node.spendOf(session);
    return {
      session, log, broken: false,
      /** Commit a model response, as its agent does: true once it is durable (and its run sees it), false if the commit failed. */
      async respond(usd: number, fault: CommitFault) {
        const record = response(++ids, usd);
        const pending = session.unwritten ?? 0;
        carried.set(ids, usd + pending);
        const effect = node.spendEffect(session, record);
        log.append(record, effect);
        // A record with nothing to commit with it is one statement, not a transaction: no fault reaches it.
        if (effect) faults.push(fault);
        try { await log.flush(true); }
        catch { this.broken = true; return false; }
        finally { faults.length = 0; }
        node.counted(session, usd);
        return true;
      },
    };
  };
  /** What the history holds from record `from` on, and what it cost the agent (its responses, and what they carried). */
  const history = async () => {
    const records = await storage.log<TranscriptRecord>(key).read();
    return { length: records.length, cost: (from: number) => records.slice(from).reduce((sum, record) => sum + (record.t === "message" ? carried.get(record.message.timestamp) ?? 0 : 0), 0) };
  };
  return { agent, node, owner, history, faults };
}

type SpendStep =
  | { t: "response"; usd: number; fault: CommitFault }
  | { t: "compaction"; usd: number }
  | { t: "reset"; usd: number }
  | { t: "takeover"; clean: boolean };
/** A cost: none, or at least a hundredth of a cent (fast-check's doubles lean to values too small to tell apart). */
const usd = (max: number) => fc.oneof(fc.constant(0), fc.integer({ min: 1, max: max * 10_000 }).map(n => n / 10_000));
const spendStep: fc.Arbitrary<SpendStep> = fc.oneof(
  { weight: 8, arbitrary: fc.record({ t: fc.constant("response" as const), usd: usd(0.5), fault: fc.constantFrom<CommitFault>("none", "none", "none", "before-commit", "lost-ack", "spend-write") }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("compaction" as const), usd: usd(0.2) }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("reset" as const), usd: usd(5) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant("takeover" as const), clean: fc.boolean() }) },
);

/**
 * Spend an agent's budget across owners, checking I5 as it goes:
 * - a new owner reads exactly what the history it loads cost since the limit was set: a spend write never lands, or
 *   fails, apart from the commit of the response it is for, whatever fails, and a stale owner's commit is fenced;
 * - an owner's count is what its history cost, plus what it counted that no record has carried yet, so a response
 *   starts only while the agent is under its limit: only the response in flight may take it past.
 */
async function spendAcross(steps: SpendStep[]) {
  const { node, owner, history } = await spendAgent();
  let current = await owner();
  await node.setSpendLimit(current.session, 1);
  // Since the limit was set: the history from `base` on, spend written with no record (`extra`), and spend counted that
  // rides on the owner's next record (`riding`).
  let limit = 1, base = 0, extra = 0, riding = 0;
  for (const step of [...steps, { t: "takeover" as const, clean: true }]) {
    if (step.t === "takeover") {
      if (step.clean) {
        // As `unload`: the transcript closed (a failed commit is written now), then spend no record carried.
        await current.log.close();
        await node.spendWrite(current.session, 0)?.();
        extra += riding;
      }
      const stale = current;
      current = await owner();
      // A stale owner's commit after the takeover is fenced, its spend with it.
      if (!step.clean && await stale.respond(0.125, "none")) assert.fail("a stale owner committed after a takeover");
      riding = 0;
      const { cost } = await history();
      const read = current.session.spend!;
      assert.ok(Math.abs(read.spent - (cost(base) + extra)) < 1e-9, `the new owner read ${read.spent} spent; its history cost ${cost(base)}, and ${extra} more was written`);
      assert.equal(read.usd, limit);
      assert.equal(!!(await node.agentSpendLimit(current.session)), read.spent >= read.usd, "refused exactly when what it read reaches the limit");
      continue;
    }
    if (current.broken) continue;
    if (step.t === "reset") {
      await node.setSpendLimit(current.session, step.usd);
      ({ length: base } = await history());
      limit = step.usd;
      extra = riding = 0;
    } else if (step.t === "compaction") {
      node.spent(current.session, step.usd);
      if (step.usd > 0) riding += step.usd;
    } else {
      const { cost } = await history();
      const counted = current.session.spend!.spent;
      assert.ok(Math.abs(counted - (cost(base) + extra + riding)) < 1e-9, `the owner counts ${counted}; its history cost ${cost(base)}, ${extra} more was written, and ${riding} rides on the next record`);
      // A run's next model call: refused once the agent's count reaches its limit.
      if (await node.agentSpendLimit(current.session)) continue;
      assert.ok(cost(base) + extra < limit);
      // What rode on it is the record's, whether or not it commits.
      await current.respond(step.usd, step.fault);
      riding = 0;
    }
  }
}

test("spend limits: a new owner reads exactly what the history it loads cost, whatever commits fail", async t => {
  await check(t, fc.asyncProperty(fc.array(spendStep, { minLength: 1, maxLength: 25 }), spendAcross), { runs: 40 });
});

/**
 * H3 (fixed): `spent()` updated `agent_spend_limits` fire-and-forget, once, and only logged a failure, while the owner's
 * count went on: the next owner read a row lacking every failed increment, so an agent could spend past its limit by
 * the sum of all failed writes, across any number of takeovers. A response's spend now commits in the transaction that
 * appends it to the transcript, under the claim: the two land, or fail, together.
 */
test("H3 minimized: a spend write that fails fails its response's commit, so the next owner reads what its history cost", async () => {
  const { node, owner, history } = await spendAgent();
  const first = await owner();
  await node.setSpendLimit(first.session, 1);
  assert.equal(await first.respond(0.25, "spend-write"), false);
  assert.equal((await history()).length, 0, "the response is not history");
  const second = await owner();
  assert.equal(second.session.spend!.spent, 0);
  // Its answer lost: the response is history, and its spend was written once, though written again on close.
  assert.equal(await second.respond(0.5, "lost-ack"), false);
  await second.log.close();
  const third = await owner();
  assert.equal((await history()).length, 1);
  assert.equal(third.session.spend!.spent, 0.5);
});
test("H3: no failed commit makes a new owner under-count", async t => {
  const steps = fc.array(fc.oneof(spendStep, fc.record({ t: fc.constant("response" as const), usd: usd(0.5), fault: fc.constantFrom<CommitFault>("before-commit", "lost-ack", "spend-write") })), { minLength: 1, maxLength: 25 });
  await check(t, fc.asyncProperty(steps, spendAcross), { runs: 25 });
});
