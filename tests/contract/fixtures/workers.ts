import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { EndUserCredits } from "../../../src/end-user-credits.ts";
import { configuredModel } from "../../../src/model.ts";
import { modelReference } from "../../../src/virtual-models.ts";
import { tenantsFromEnvironment } from "../../../src/tenants.ts";
import { seedJourneyAccount } from "./journey-state.ts";
import { fakeModel, OPERATOR, OTHER_OPERATOR, until, untilRequestState, type T } from "../http.ts";
import type { ContractFixture, FixtureOptions, TenantSeed } from "../fixture.ts";
import { fixtureSigner } from "./signing.ts";
import { observePollingResponse } from "../polling.ts";

/** A real workerd process and an isolated local Postgres database. No production bindings. */
export async function createWorkersFixture(t: T, options: FixtureOptions = {}): Promise<ContractFixture> {
  let respond = options.respond ?? (() => ({ role: "assistant", content: "ok" }));
  let replyStart = 0;
  const cleanups: Array<() => Promise<void> | void> = [];
  const startup = new AbortController();
  let closed = false;
  const dispose = async () => {
    const failures: unknown[] = [];
    for (const cleanup of cleanups.splice(0).reverse()) {
      try { await cleanup(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, "Workers fixture cleanup failed");
  };
  const close = async () => {
    if (closed) return;
    closed = true;
    startup.abort();
    await dispose();
  };
  t.after(close);
  try {
  const model = await fakeModel({ after: fn => cleanups.push(fn) }, (body, index) => respond(body, index - replyStart));
  if (closed) {
    await dispose();
    throw new Error("Workers fixture startup was cancelled");
  }
  // Dynamic import keeps workerd's binding types out of the Node TypeScript project.
  const fixtureModule = new URL("../../../backends/workers/test/fixture.ts", import.meta.url).href;
  const { startFixture } = await import(fixtureModule);
  const env: Record<string, string> = {
    AGENT_SESSION_SECRET: "server-test-session-secret-with-32-chars",
    AGENT_SECRETS_KEY: randomBytes(32).toString("hex"),
    AGENT_PUBLIC_URL: "https://agents.example.test",
    AGENT_PROVIDER: "openrouter", AGENT_MODEL: "openai/gpt-4o-mini", AGENT_BASE_URL: model.url,
    AGENT_OUTBOUND_ALLOW_HTTP: "false", AGENT_OUTBOUND_ALLOW_CIDRS: "",
    ...options.env,
  };
  let configuredTenants = options.tenants;
  if (env.AGENT_TENANTS_FILE === "" && env.AGENT_TENANT) {
    // Use the source parser, then express the same seeded tenant through the
    // Worker's supported JSON configuration input.
    const source = await tenantsFromEnvironment(env);
    const id = env.AGENT_TENANT;
    configuredTenants = { tenants: { [id]: {
      tokenSha256: createHash("sha256").update(env.AGENT_OPERATOR_TOKEN).digest("hex"),
      apiKeys: Object.fromEntries(source.providers(id).map(provider => [provider, source.apiKey(id, provider)])),
    } } };
  }
  const tenants: any = structuredClone(configuredTenants ?? { tenants: {
    alice: { tokenSha256: createHash("sha256").update(OPERATOR).digest("hex"), apiKeys: { openrouter: "fixture-model-key" } },
    bob: { tokenSha256: createHash("sha256").update(OTHER_OPERATOR).digest("hex"), apiKeys: { openrouter: "fixture-model-key" } },
  } });
  // This private implementation token signs agent-scoped credentials. Public
  // requests retain their original bearer token and use the real auth service.
  const internalOperator = `contract-internal-${randomUUID()}`;
  const server = await startFixture({
    signal: startup.signal,
    token: internalOperator,
    tenant: "alice",
    tenants: [],
    entrypoint: fileURLToPath(new URL("../../../backends/workers/test/contract-entry.ts", import.meta.url)),
    modelURL: env.AGENT_BASE_URL || model.url,
    vars: {
      ...env,
      API_TOKEN: internalOperator,
      AGENT_TENANTS_JSON: JSON.stringify(tenants),
      ...(env.AGENT_GITHUB_WEB_URL ? { TEST_GITHUB_WEB_URL: env.AGENT_GITHUB_WEB_URL } : {}),
      ...(env.AGENT_GITHUB_API_URL ? { TEST_GITHUB_API_URL: env.AGENT_GITHUB_API_URL } : {}),
      ...(env.AGENT_GOOGLE_ISSUER ? { TEST_GOOGLE_ISSUER: env.AGENT_GOOGLE_ISSUER } : {}),
      // Point the real Worker mail transport at the same local sink. Its raw
      // EmailMessageBuilder payload is not an SES envelope: no fixture code
      // invents EmailTags, ConfigurationSetName, or sender formatting for it.
      ...(env.AWS_ENDPOINT_URL_SESV2 && !env.MAIL_TEST_URL ? { MAIL_TEST_URL: new URL("/v2/email/outbound-emails", env.AWS_ENDPOINT_URL_SESV2).href } : {}),
      TEST_MODE: "1", TEST_MODEL: "1", MODEL: modelReference(configuredModel(env)),
      ...(options.failImageResizeOnce ? { TEST_IMAGE_RESIZE_FAILURE_ONCE: "1" } : {}),
      // An explicitly supplied gateway speaks the configured provider API.
      // The default fake responder speaks OpenAI completions for every model.
      TEST_MODEL_API: options.env?.AGENT_BASE_URL ? configuredModel(env).api : "openai-completions",
    },
  });
  if (closed) {
    await server.stop();
    throw new Error("Workers fixture startup was cancelled");
  }
  cleanups.push(() => server.stop());
  // The local wrapper reads the complete config on each request, corresponding
  // to Node's tenant-file reload. It never substitutes the credential or policy.
  await server.db.query("create table contract_fixture_configuration (singleton boolean primary key check(singleton), configuration jsonb not null)");
  await server.db.query("insert into contract_fixture_configuration values(true,$1)", [JSON.stringify(tenants)]);

  async function seedTenant(id: string, seed: TenantSeed = {}, initial = false) {
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id)) throw new Error("Invalid fixture tenant id");
    const token = seed.token ?? (seed.operator === false ? `art_${randomBytes(32).toString("hex")}` : `contract-operator-${id}-${randomUUID()}`);
    const config: Record<string, any> = initial ? seed.config ?? {} : {
      ...tenants.tenants[id], tokenSha256: createHash("sha256").update(token).digest("hex"),
      apiKeys: { openrouter: "fixture-model-key" }, ...seed.config,
      ...(seed.billingMode ? { billing: seed.billingMode } : {}),
    };
    const billing = seed.billingMode ?? config.billing ?? (seed.operator === false ? "prepaid" : "none");
    if (billing !== "none" && billing !== "prepaid") throw new Error("Invalid fixture billing mode");
    const hash = createHash("sha256").update(token).digest("hex");
    if (seed.operator === false) {
      await server.db.query("insert into tenants(id,created_at,billing) values($1,$2,$3) on conflict(id) do nothing", [id, Date.now(), seed.billingMode ?? "prepaid"]);
      await server.db.query(
        "insert into api_tokens(sha256,id,tenant,name,prefix,created_at) values($1,$2,$3,'contract','fixture',$4) on conflict(sha256) do nothing",
        [hash, randomUUID(), id, Date.now()],
      );
    } else {
      tenants.tenants[id] = config;
      await server.db.query("update contract_fixture_configuration set configuration=$1 where singleton=true", [JSON.stringify(tenants)]);
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
    if (seed.credits !== undefined) {
      if (!Number.isSafeInteger(seed.credits) || seed.credits < 0) throw new Error("Fixture credits must be nonnegative integer micro-USD");
      await server.db.query("insert into tenants(id,created_at,billing) values($1,$2,$3) on conflict(id) do update set billing=excluded.billing", [id, Date.now(), billing]);
      if (seed.credits) await server.db.query(
        "with input as (insert into credit_ledger(tenant,kind,amount,idempotency_key,created_at) values($1,'purchase',$2,$3,$4) returning tenant,amount) insert into credit_accounts(tenant,balance,purchased) select tenant,amount,amount from input on conflict(tenant) do update set balance=credit_accounts.balance+excluded.balance,purchased=credit_accounts.purchased+excluded.purchased",
        [id, seed.credits, `contract:${randomUUID()}`, Date.now()],
      );
    }
    // Provider configuration is part of the tested implementation. The fake provider
    // itself remains a transport fixture, and does not emulate missing provider policy.
    return { id, token };
  }

  for (const [id, config] of Object.entries(tenants.tenants) as [string, Record<string, unknown>][]) {
    await seedTenant(id, { token: id === "alice" ? OPERATOR : id === "bob" ? OTHER_OPERATOR : undefined, config }, true);
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
    observePollingResponse(path, response.status, json, init.method ?? (init.body === undefined ? "GET" : "POST"));
    return { status: response.status, json, text, headers: response.headers };
  };
  const prompt: ContractFixture["prompt"] = async (agent, text, token, extra = {}) => {
    const sent = await call(`/v1/agents/${agent}/prompt`, { body: { text, ...extra }, token });
    if (sent.status !== 202) throw new Error(`prompt: ${sent.status} ${sent.text}`);
    return untilRequestState(async () => (await call(`/v1/agents/${agent}/requests/${sent.json.id}`, { token })).json,
      "completed", "the turn to end", 60_000);
  };
  return {
    base: server.url, call, prompt, model, seedTenant, close,
    stop: () => server.worker.stop(),
    restart: settings => server.restart(settings?.env, settings?.crash),
    signFileToken: (grant, expiresAt) => fixtureSigner(server.db, env.AGENT_SECRETS_KEY, server.url).fileToken(grant, expiresAt),
    signIdentityToken: (audience, claims) => fixtureSigner(server.db, env.AGENT_SECRETS_KEY, server.url).token(audience, claims),
    get logs() { return server.worker.logs().split("\n"); },
    async setScheduleDueAt(agent, schedule, dueAt) {
      const result = await call(`/v1/agents/${agent}/__test/contract-schedule-due`, { body: { id: schedule, dueAt } });
      if (result.status !== 200) throw new Error(`Schedule fixture: ${result.status} ${result.text}`);
    },
    async seedIdempotencyLock({ tenant, key, fingerprint, createdAt }) {
      await server.db.query("insert into idempotency_keys(tenant,key,fingerprint,created_at) values($1,$2,$3,$4)", [tenant, key, fingerprint, createdAt]);
    },
    async setScheduleLegacyHistory(agent, schedule, history) {
      const result = await call(`/v1/agents/${agent}/__test/contract-schedule-due`, { body: { id: schedule, dueAt: 0, history } });
      if (result.status !== 200) throw new Error(`Schedule fixture: ${result.status} ${result.text}`);
    },
    async resetChildSettlement(parent) {
      const result = await call(`/v1/agents/${parent}/__test/contract-child-settlement`, { body: {} });
      if (result.status !== 200) throw new Error(`Child settlement fixture: ${result.status} ${result.text}`);
    },
    async countOAuthRefreshTokens() {
      return (await server.db.query("select count(*)::int as n from oauth_tokens where kind='refresh' and grant_id is not null")).rows[0].n;
    },
    async ageUsedOAuthRefreshToken(token, milliseconds) {
      const result = await server.db.query("update oauth_tokens set used_at=used_at-$2 where sha256=$1", [createHash("sha256").update(token).digest("hex"), milliseconds]);
      if (result.rowCount !== 1) throw new Error("Fixture refresh token not found");
    },
    async revokeOAuthGrants() { await server.db.query("delete from oauth_grants"); },
    async seedOAuthAccessToken(grant) {
      await server.db.query("insert into oauth_grants(id,tenant,client_id,client_name,login,scope,resource,created_at) values($1,$2,$3,$4,$5,$6,$7,$8)", [grant.grantId, grant.tenant, grant.clientId, grant.clientName, grant.login, grant.scope, grant.resource, Date.now()]);
      await server.db.query("insert into oauth_tokens(sha256,kind,grant_id,expires_at) values($1,'access',$2,$3)", [createHash("sha256").update(grant.token).digest("hex"), grant.grantId, grant.expiresAt]);
    },
    async expireAccountEmailLinks() { await server.db.query("update account_email_links set expires_at=$1", [Date.now() - 1]); },
    async seedConsoleIdentity(tenant, identity) {
      const now = Date.now(), raw = randomBytes(32).toString("base64url");
      if (identity.method === "google") await server.db.query("insert into tenants(id,google_sub,google_email,created_at) values($1,$2,$3,$4)", [tenant, identity.subject, identity.email ?? null, now]);
      else await server.db.query("insert into tenants(id,github,github_id,created_at) values($1,$2,$3,$4)", [tenant, identity.login, identity.subject, now]);
      await server.db.query("insert into console_sessions(sha256,tenant,login,method,created_at,expires_at) values($1,$2,$3,$4,$5,$6)", [createHash("sha256").update(raw).digest("hex"), tenant, identity.login, identity.method, now, now + 3_600_000]);
      return `ar_session=${raw}`;
    },
    async seedEndUserUsage({ tenant, endUser, bucket, amount, key, metadata, at }) {
      await new EndUserCredits(server.db).charge(tenant, endUser, bucket, amount, key, metadata, at);
    },
    async seedStripeCustomer(tenant, { customer, legacyCustomer }) {
      await server.db.query("insert into billing_stripe_customers(tenant,livemode,request_id,customer,created_at) values($1,false,$2,$3,$4)", [tenant, randomUUID(), customer, Date.now()]);
      if (legacyCustomer) await server.db.query("insert into credit_accounts(tenant,balance,stripe_customer) values($1,0,$2) on conflict(tenant) do update set stripe_customer=excluded.stripe_customer", [tenant, legacyCustomer]);
    },
    async setRejectRunEvents(enabled) {
      if (enabled) await server.db.query(`create function reject_run_event() returns trigger language plpgsql as $$ begin
        if new.body->>'type' = 'run.completed' then raise exception 'run event unavailable'; end if;
        return new; end $$;
        create trigger reject_run_event before insert on webhook_deliveries for each row execute function reject_run_event()`);
      else await server.db.query("drop trigger reject_run_event on webhook_deliveries; drop function reject_run_event()");
    },
    async updateLegacyUsageWebhook(url) { await server.db.query("update usage_webhooks set url=$1 where tenant='alice'", [url]); },
    seedJourneyAccount: input => seedJourneyAccount(server.db, input),
    async drain() { throw new Error("Unsupported fixture lifecycle: deployed Workers have no Node SIGTERM/HTTP server drain boundary"); },
    async waitForAgentIdle(agent) {
      await until(async () => {
        const state = await call(`/v1/agents/${agent}/state`);
        if (state.status !== 200 || !Array.isArray(state.json.requests)) throw new Error(`Agent quiescence fixture: ${state.status} ${state.text}`);
        return state.json.requests.every((request: { state: string }) => request.state !== "running");
      }, "the agent's requests to finish before a cold reload", 20_000);
      // workerd has no Node owner lease. Restart the real local process to evict
      // live DOs, preserving its SQLite/R2 directory and Postgres database.
      await server.restart();
    },
    async failAgentLoad(_agent) { throw new Error("Unsupported fixture state: Workers agents do not resume from versioned Postgres agent headers"); },
    async agentRecovery(_agent) { throw new Error("Unsupported fixture state: Workers agents have no Postgres resume_failures or resume_after"); },
    async setAgentRecovery(_agent, _state) { throw new Error("Unsupported fixture state: Workers agents have no Postgres resume_failures or resume_after"); },
    async failNextAdmissionWrite(_agent) { throw new Error("Unsupported fixture state: Workers request admission does not update Postgres pending_runs"); },
    setModel(next) { respond = next; replyStart = model.bodies.length; },
    async imageResizeFailureCount() {
      const response = await call("/__test/image-resize-failures");
      if (response.status !== 200) throw new Error(`Image resize fixture: ${response.status} ${response.text}`);
      return response.json.count;
    },
    async restartWithLegacyModel(agent, legacyModel) {
      const token = `cat_${createHmac("sha256", internalOperator).update(`camelrun-cloudflare:agent:${agent}`).digest("hex")}`;
      const result = await call(`/clients/${agent}/__test/contract-legacy-model`, { token, body: { model: { ...legacyModel, baseUrl: model.url } } });
      if (result.status !== 200) throw new Error(`Legacy model fixture: ${result.status} ${result.text}`);
      await server.restart();
    },
    async now() { return Date.now(); },
    async advanceTime(milliseconds) {
      if (!Number.isFinite(milliseconds) || milliseconds < 0) throw new Error("Invalid clock advance");
      // Both backends use wall time. Waiting exercises real DO alarms and their persisted due times.
      await new Promise(resolve => setTimeout(resolve, milliseconds));
    },
  };
  } catch (error) {
    try { await close(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], "Workers fixture startup and cleanup failed"); }
    throw error;
  }
}

export const createContractFixture = createWorkersFixture;
