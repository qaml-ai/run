import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { fakeModel, OPERATOR, OTHER_OPERATOR, until, type T } from "../http.ts";
import type { ContractFixture, FixtureOptions, TenantSeed } from "../fixture.ts";

/** A real workerd process and an isolated local Postgres database. No production bindings. */
export async function createWorkersFixture(t: T, options: FixtureOptions = {}): Promise<ContractFixture> {
  let respond = options.respond ?? (() => ({ role: "assistant", content: "ok" }));
  let replyStart = 0;
  const cleanups: Array<() => Promise<void> | void> = [];
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    for (const cleanup of cleanups.reverse()) await cleanup();
  };
  t.after(close);
  const model = await fakeModel({ after: fn => cleanups.push(fn) }, (body, index) => respond(body, index - replyStart));
  // Dynamic import keeps workerd's binding types out of the Node TypeScript project.
  const fixtureModule = new URL("../../../backends/workers/test/fixture.ts", import.meta.url).href;
  const { startFixture } = await import(fixtureModule);
  const env = options.env ?? {};
  // This implementation-level operator is private to the fixture wrapper. Only
  // explicitly seeded credentials may reach it; OPERATOR is not a hidden key.
  const internalOperator = `contract-internal-${randomUUID()}`;
  const server = await startFixture({
    token: internalOperator,
    tenant: "alice",
    tenants: [],
    entrypoint: fileURLToPath(new URL("../../../backends/workers/test/contract-entry.ts", import.meta.url)),
    modelURL: env.AGENT_BASE_URL ?? model.url,
    vars: {
      ...env,
      API_TOKEN: internalOperator,
      TEST_MODE: "1", TEST_MODEL: "1", MODEL: env.AGENT_MODEL ?? "openai/gpt-4o-mini",
    },
  });
  cleanups.push(() => server.stop());
  // Operator credentials are not API keys. Keep them outside api_tokens so list,
  // revoke and key-count assertions observe the same initial state as Node.
  await server.db.query("create table contract_fixture_operators (sha256 text primary key, tenant text not null unique)");

  async function seedTenant(id: string, seed: TenantSeed = {}) {
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id)) throw new Error("Invalid fixture tenant id");
    const token = seed.token ?? `contract-operator-${id}-${randomUUID()}`;
    const config = seed.config ?? {};
    const billing = seed.billingMode ?? config.billing ?? (seed.operator === false ? "prepaid" : "none");
    if (billing !== "none" && billing !== "prepaid") throw new Error("Invalid fixture billing mode");
    const credits = seed.credits ?? 0;
    if (!Number.isSafeInteger(credits) || credits < 0) throw new Error("Fixture credit must be nonnegative integer micro-USD");
    const { tokenSha256, apiKeys, github, githubId, billing: _billing, ...limits } = config;
    const hash = tokenSha256 ?? createHash("sha256").update(token).digest("hex");
    await server.db.query(
      "insert into tenants(id,created_at,billing,limits,github,github_id) values($1,$2,$3,$4,$5,$6) on conflict(id) do update set billing=excluded.billing,limits=excluded.limits,github=excluded.github,github_id=excluded.github_id",
      [id, Date.now(), billing, JSON.stringify(limits), github ?? null, githubId ?? null],
    );
    if (seed.operator === false) {
      await server.db.query("delete from contract_fixture_operators where tenant=$1", [id]);
      await server.db.query(
        "insert into api_tokens(sha256,id,tenant,name,prefix,created_at) values($1,$2,$3,'fixture','fixture',$4) on conflict(sha256) do update set tenant=excluded.tenant",
        [hash, randomUUID(), id, Date.now()],
      );
    } else {
      await server.db.query(
        "insert into contract_fixture_operators(sha256,tenant) values($1,$2) on conflict(tenant) do update set sha256=excluded.sha256",
        [hash, id],
      );
    }
    if (seed.email) {
      const email = seed.email.trim().toLowerCase();
      await server.db.query(
        "insert into tenant_passwords(tenant,email,hash,set_at) values($1,$2,'fixture-disabled-password',$3) on conflict(tenant) do update set email=excluded.email",
        [id, email, Date.now()],
      );
      if (seed.suppressed) await server.db.query(
        "insert into billing_email_suppressions(email_hash,created_at) values($1,$2) on conflict do nothing",
        [createHash("sha256").update(email).digest("hex"), Date.now()],
      );
    }
    await server.db.query("insert into credit_accounts(tenant,balance,purchased) values($1,0,0) on conflict do nothing", [id]);
    if (credits) {
      await server.db.query(
        "with entry as (insert into credit_ledger(tenant,kind,amount,idempotency_key,created_at) values($1,'purchase',$2,$3,$4) returning tenant,amount) update credit_accounts a set balance=a.balance+entry.amount,purchased=a.purchased+entry.amount from entry where a.tenant=entry.tenant",
        [id, credits, `contract:seed:${randomUUID()}`, Date.now()],
      );
    }
    // Provider configuration is part of the tested implementation. The fake provider
    // itself remains a transport fixture, and does not emulate missing provider policy.
    return { id, token };
  }

  const seeds = (options.tenants as { tenants?: Record<string, Record<string, any>> } | undefined)?.tenants ?? {
    alice: { tokenSha256: createHash("sha256").update(OPERATOR).digest("hex") },
    bob: { tokenSha256: createHash("sha256").update(OTHER_OPERATOR).digest("hex") },
  };
  for (const [id, config] of Object.entries(seeds)) {
    await seedTenant(id, { token: id === "alice" ? OPERATOR : id === "bob" ? OTHER_OPERATOR : undefined, config });
  }

  const call: ContractFixture["call"] = async (path, init = {}) => {
    const token = init.token === undefined ? OPERATOR : init.token;
    const response = await fetch(server.url + path, {
      redirect: "manual",
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...init.headers,
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const text = await response.text();
    let json: any = text;
    try { json = JSON.parse(text); } catch { /* non-JSON HTTP response */ }
    return { status: response.status, json, text, headers: response.headers };
  };
  const prompt: ContractFixture["prompt"] = async (agent, text, token, extra = {}) => {
    const sent = await call(`/v1/agents/${agent}/prompt`, { body: { text, ...extra }, token });
    if (sent.status !== 202) throw new Error(`prompt: ${sent.status} ${sent.text}`);
    return until(async () => {
      const record = (await call(`/v1/agents/${agent}/requests/${sent.json.id}`, { token })).json;
      return record.state === "completed" && record;
    }, "the turn to end", 60_000);
  };
  return {
    base: server.url, call, prompt, model, seedTenant, close,
    get logs() { return server.worker.logs().split("\n"); },
    async setScheduleDueAt(agent, schedule, dueAt) {
      const result = await call(`/v1/agents/${agent}/__test/contract-schedule-due`, { body: { id: schedule, dueAt } });
      if (result.status !== 200) throw new Error(`Schedule fixture: ${result.status} ${result.text}`);
    },
    setModel(next) { respond = next; replyStart = model.bodies.length; },
    async now() { return Date.now(); },
    async advanceTime(milliseconds) {
      if (!Number.isFinite(milliseconds) || milliseconds < 0) throw new Error("Invalid clock advance");
      // Both backends use wall time. Waiting exercises real DO alarms and their persisted due times.
      await new Promise(resolve => setTimeout(resolve, milliseconds));
    },
  };
}

export const createContractFixture = createWorkersFixture;
