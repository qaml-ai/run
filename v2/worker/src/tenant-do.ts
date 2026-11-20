import { DurableObject } from "cloudflare:workers";
import { CamelFsClient } from "./camelfs.ts";
import { mintChannelId, openSecret, randomId, sealSecret } from "./crypto.ts";
import { DEFAULT_MODEL_ID, getProviderLookupCandidates } from "./providers.ts";
import {
  ApiError,
  extractApiError,
  type AgentUpsertInput,
  type AuthContext,
  type Env,
  type ProviderCredentials,
  type RpcStub,
} from "./types.ts";

export interface TenantProfile {
  id: string;
  name: string;
  tier: string;
  balanceUsd: number;
  monthlyCapUsd: number;
  concurrencyLimit: number;
  rateLimitRpm: number;
  createdAt: number;
}

export interface ApiKeyView {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  createdAt: number;
  lastUsedAt: number | null;
}

export interface AgentIndexEntry {
  id: string;
  tenantId: string;
  key: string;
  tokenHash: string;
  sealedToken: string;
  model: string;
  repoId: string | null;
  branch: string;
  definition: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface RepoRecord {
  repoId: string;
  name: string;
  lineage: string;
  defaultRef: string;
  commit: string;
  createdAt: number;
}

export interface WebhookView {
  id: string;
  url: string;
  events: string[];
  enabled: boolean;
  createdAt: number;
}

export interface WebhookTargetRecord {
  id: string;
  url: string;
  events: string[];
  sealedSecret: string;
}

export interface ChannelView {
  id: string;
  kind: "slack" | "email" | "http";
  name: string;
  definition: string | null;
  outboundUrl: string | null;
  createdAt: number;
}

export interface ChannelInternalRecord extends ChannelView {
  tenantId: string;
  agentConfigJson: string;
  sealedSecret: string | null;
}

type SealedProviderRow = {
  provider: string;
  sealed_api_key: string;
  base_url: string | null;
  model_aliases_json: string | null;
};

export function platformCreditReserve(env: Env, tenantId: string) {
  if (tenantId === env.BUILDER_CUTOVER_CREDIT_TENANT_ID) {
    return { prefix: "builder-cutover-reserve:", note: "Temporary Camel Bots cutover credit reserve", code: "builder_credit_reserve" };
  }
  if (env.APP_RUNTIME_CREDIT_TENANT_IDS?.split(",").includes(tenantId)) {
    return { prefix: "app-runtime-reserve:", note: "App platform runtime credit reserve", code: "app_runtime_credit_reserve" };
  }
  return null;
}

export function getTenantStub(env: Env, tenantId: string): RpcStub<TenantDO> {
  if (!tenantId) {
    throw new ApiError(400, "missing_tenant", "Missing tenant identifier");
  }
  return env.TENANT_DO.get(env.TENANT_DO.idFromName(tenantId)) as unknown as RpcStub<TenantDO>;
}

export class TenantDO extends DurableObject<Env> {
  private schemaReady = false;
  private textRunSchemaReady = false;
  private legacyTextSchemaReady = false;
  private lastKeyTouchAt = new Map<string, number>();

  private ensureSql(): void {
    if (this.schemaReady) return;
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS tenant_profile (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        tenant_id TEXT NOT NULL,
        name TEXT NOT NULL,
        tier TEXT NOT NULL DEFAULT 'pro',
        balance_usd REAL NOT NULL DEFAULT 0,
        monthly_cap_usd REAL NOT NULL DEFAULT 1000,
        concurrency_limit INTEGER NOT NULL DEFAULT 25,
        rate_limit_rpm INTEGER NOT NULL DEFAULT 600,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL DEFAULT 'default',
        prefix TEXT NOT NULL,
        key_hash TEXT NOT NULL UNIQUE,
        scopes_json TEXT NOT NULL DEFAULT '["*"]',
        created_at INTEGER NOT NULL,
        last_used_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
      CREATE TABLE IF NOT EXISTS provider_keys (
        provider TEXT PRIMARY KEY,
        sealed_api_key TEXT NOT NULL,
        base_url TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS credit_ledger (
        id TEXT PRIMARY KEY,
        ref_id TEXT NOT NULL UNIQUE,
        amount_usd REAL NOT NULL,
        kind TEXT NOT NULL,
        note TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS usage_daily (
        day TEXT NOT NULL,
        model TEXT NOT NULL,
        runs_count INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        vm_ms INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        PRIMARY KEY (day, model)
      );
      CREATE TABLE IF NOT EXISTS definitions (
        slug TEXT PRIMARY KEY,
        config_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agents_index (
        id TEXT PRIMARY KEY,
        agent_key TEXT NOT NULL UNIQUE,
        token_hash TEXT NOT NULL UNIQUE,
        sealed_token TEXT NOT NULL,
        model TEXT NOT NULL,
        model_revision INTEGER NOT NULL DEFAULT 0,
        repo_id TEXT,
        branch TEXT NOT NULL DEFAULT 'refs/heads/main',
        definition_slug TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agents_token ON agents_index(token_hash);
      CREATE TABLE IF NOT EXISTS repos (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        lineage TEXT NOT NULL,
        default_ref TEXT NOT NULL DEFAULT 'refs/heads/main',
        commit_hash TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_repos_lineage ON repos(lineage);
      CREATE TABLE IF NOT EXISTS webhooks (
        id TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        events_json TEXT NOT NULL DEFAULT '["*"]',
        sealed_secret TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        definition_slug TEXT,
        agent_config_json TEXT NOT NULL DEFAULT '{}',
        outbound_url TEXT,
        sealed_secret TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS active_leases (
        run_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        acquired_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS rate_buckets (
        bucket_key TEXT PRIMARY KEY,
        tokens REAL NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    const providerColumns = this.ctx.storage.sql.exec<{ name: string }>("PRAGMA table_info(provider_keys)").toArray();
    if (!providerColumns.some(({ name }) => name === "model_aliases_json")) {
      this.ctx.storage.sql.exec("ALTER TABLE provider_keys ADD COLUMN model_aliases_json TEXT");
    }
    if (!this.ctx.storage.sql.exec<{ name: string }>("PRAGMA table_info(agents_index)")
      .toArray().some(({ name }) => name === "model_revision")) {
      this.ctx.storage.sql.exec("ALTER TABLE agents_index ADD COLUMN model_revision INTEGER NOT NULL DEFAULT 0");
    }
    this.schemaReady = true;
  }

  private readProfileOrNull(): TenantProfile | null {
    this.ensureSql();
    const row = this.ctx.storage.sql
      .exec<{
        tenant_id: string;
        name: string;
        tier: string;
        balance_usd: number;
        monthly_cap_usd: number;
        concurrency_limit: number;
        rate_limit_rpm: number;
        created_at: number;
      }>(`SELECT * FROM tenant_profile WHERE id = 1`)
      .toArray()[0];
    if (!row) return null;
    return {
      id: row.tenant_id,
      name: row.name,
      tier: row.tier,
      balanceUsd: Number(row.balance_usd),
      monthlyCapUsd: Number(row.monthly_cap_usd),
      concurrencyLimit: Number(row.concurrency_limit),
      rateLimitRpm: Number(row.rate_limit_rpm),
      createdAt: Number(row.created_at),
    };
  }

  private requireProfile(): TenantProfile {
    const profile = this.readProfileOrNull();
    if (!profile) {
      throw new ApiError(404, "tenant_not_found", "Tenant not found");
    }
    return profile;
  }

  private pruneExpiredLeases(now = Date.now()): void {
    this.ctx.storage.sql.exec(`DELETE FROM active_leases WHERE expires_at <= ?1`, now);
  }

  private countBusyAgents(now = Date.now()): number {
    this.pruneExpiredLeases(now);
    const rows = this.ctx.storage.sql
      .exec<{ cnt: number }>(`SELECT COUNT(DISTINCT agent_id) AS cnt FROM active_leases`)
      .toArray();
    return Number(rows[0]?.cnt ?? 0);
  }

  // ---- 1. Tenant Lifecycle & Auth ----

  async initTenant(input: {
    tenantId: string;
    name: string;
    tier?: string;
    initialCreditsUsd?: number;
    monthlyCapUsd?: number;
    concurrencyLimit?: number;
    rateLimitRpm?: number;
    keyId: string;
    keyPrefix: string;
    keyHash: string;
  }): Promise<TenantProfile> {
    this.ensureSql();
    const now = Date.now();
    const initialCredits = Number(input.initialCreditsUsd ?? 0);

    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `INSERT INTO tenant_profile (id, tenant_id, name, tier, balance_usd, monthly_cap_usd, concurrency_limit, rate_limit_rpm, created_at)
         VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
        input.tenantId,
        input.name,
        input.tier ?? "pro",
        initialCredits,
        input.monthlyCapUsd ?? 1000,
        input.concurrencyLimit ?? 25,
        input.rateLimitRpm ?? 600,
        now,
      );
      this.ctx.storage.sql.exec(
        `INSERT INTO api_keys (id, name, prefix, key_hash, scopes_json, created_at)
         VALUES (?1, 'default', ?2, ?3, '["*"]', ?4)`,
        input.keyId,
        input.keyPrefix,
        input.keyHash,
        now,
      );
      if (initialCredits !== 0) {
        this.ctx.storage.sql.exec(
          `INSERT INTO credit_ledger (id, ref_id, amount_usd, kind, note, created_at)
           VALUES (?1, 'initial_grant', ?2, 'grant', 'Initial tenant credits', ?3)`,
          randomId("led", 8),
          initialCredits,
          now,
        );
      }
    });

    this.lastKeyTouchAt.set(input.keyId, now);
    return this.requireProfile();
  }

  async getMe(): Promise<{
    tenantId: string;
    name: string;
    balanceUsd: number;
    tier: string;
    busyAgents: { active: number; limit: number };
  }> {
    const p = this.requireProfile();
    return {
      tenantId: p.id,
      name: p.name,
      balanceUsd: p.balanceUsd,
      tier: p.tier,
      busyAgents: {
        active: this.countBusyAgents(),
        limit: p.concurrencyLimit,
      },
    };
  }

  async getProfile(): Promise<TenantProfile | null> {
    return this.readProfileOrNull();
  }

  private verifyApiKeySync(
    profile: TenantProfile,
    keyHash: string,
  ): { tenantId: string; keyId: string; scopes: string[] } | null {
    const row = this.ctx.storage.sql
      .exec<{ id: string; scopes_json: string; last_used_at: number | null }>(
        `SELECT id, scopes_json, last_used_at FROM api_keys WHERE key_hash = ?1 LIMIT 1`,
        keyHash,
      )
      .toArray()[0];
    if (!row) return null;

    const now = Date.now();
    const lastTouched = this.lastKeyTouchAt.get(row.id) ?? row.last_used_at ?? 0;
    if (now - lastTouched >= 300_000) {
      this.lastKeyTouchAt.set(row.id, now);
      this.ctx.waitUntil(
        Promise.resolve().then(() => {
          try {
            this.ctx.storage.sql.exec(
              `UPDATE api_keys SET last_used_at = ?1 WHERE id = ?2`,
              now,
              row.id,
            );
          } catch {
            // Non-critical telemetry timestamp
          }
        }),
      );
    }

    let scopes = ["*"];
    try {
      scopes = JSON.parse(row.scopes_json) as string[];
    } catch {
      scopes = ["*"];
    }
    return {
      tenantId: profile.id,
      keyId: row.id,
      scopes,
    };
  }

  async verifyApiKey(
    keyHash: string,
  ): Promise<{ tenantId: string; keyId: string; scopes: string[] } | null> {
    const profile = this.readProfileOrNull();
    if (!profile) return null;
    return this.verifyApiKeySync(profile, keyHash);
  }

  private verifyAgentTokenSync(
    profile: TenantProfile,
    agentId: string,
    tokenHash: string,
  ): { tenantId: string; agentId: string } | null {
    const row = this.ctx.storage.sql
      .exec<{ id: string }>(
        `SELECT id FROM agents_index WHERE id = ?1 AND token_hash = ?2 LIMIT 1`,
        agentId,
        tokenHash,
      )
      .toArray()[0];
    if (!row) return null;

    return {
      tenantId: profile.id,
      agentId: row.id,
    };
  }

  async verifyAgentToken(
    agentId: string,
    tokenHash: string,
  ): Promise<{ tenantId: string; agentId: string } | null> {
    const profile = this.readProfileOrNull();
    if (!profile) return null;
    return this.verifyAgentTokenSync(profile, agentId, tokenHash);
  }

  async createApiKey(input: {
    id: string;
    name: string;
    prefix: string;
    keyHash: string;
    scopes: string[];
  }): Promise<ApiKeyView> {
    this.requireProfile();
    const createdAt = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO api_keys (id, name, prefix, key_hash, scopes_json, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      input.id,
      input.name,
      input.prefix,
      input.keyHash,
      JSON.stringify(input.scopes),
      createdAt,
    );
    this.lastKeyTouchAt.set(input.id, createdAt);
    return {
      id: input.id,
      name: input.name,
      prefix: input.prefix,
      scopes: input.scopes,
      createdAt,
      lastUsedAt: null,
    };
  }

  async listApiKeys(): Promise<ApiKeyView[]> {
    this.requireProfile();
    const rows = this.ctx.storage.sql
      .exec<{
        id: string;
        name: string;
        prefix: string;
        scopes_json: string;
        created_at: number;
        last_used_at: number | null;
      }>(`SELECT id, name, prefix, scopes_json, created_at, last_used_at FROM api_keys ORDER BY created_at DESC`)
      .toArray();
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      prefix: r.prefix,
      scopes: JSON.parse(r.scopes_json) as string[],
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
    }));
  }

  async deleteApiKey(keyId: string): Promise<boolean> {
    this.requireProfile();
    const existing = this.ctx.storage.sql
      .exec<{ id: string }>(`SELECT id FROM api_keys WHERE id = ?1 LIMIT 1`, keyId)
      .toArray();
    if (existing.length === 0) return false;
    this.ctx.storage.sql.exec(`DELETE FROM api_keys WHERE id = ?1`, keyId);
    return true;
  }

  // ---- 2. Provider Keys ----

  async setProviderSecret(
    provider: string,
    apiKey: string,
    baseUrl?: string | null,
    modelAliases?: Record<string, string>,
  ): Promise<{ provider: string; baseUrl: string | null; modelAliases?: Record<string, string>; updated: true }> {
    this.requireProfile();
    const norm = provider.toLowerCase();
    const sealed = await sealSecret(apiKey, this.env.VAULT_SECRET);
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO provider_keys (provider, sealed_api_key, base_url, updated_at, model_aliases_json)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(provider) DO UPDATE SET
         sealed_api_key = excluded.sealed_api_key,
         base_url = excluded.base_url,
         updated_at = excluded.updated_at,
         model_aliases_json = coalesce(excluded.model_aliases_json, provider_keys.model_aliases_json)`,
      norm,
      sealed,
      baseUrl ?? null,
      now,
      modelAliases === undefined ? null : JSON.stringify(modelAliases),
    );
    return { provider: norm, baseUrl: baseUrl ?? null, ...(modelAliases && { modelAliases }), updated: true };
  }

  async getProviderSecret(provider: string): Promise<ProviderCredentials | null> {
    if (!this.readProfileOrNull()) return null;
    const row = this.findSealedProviderRow([provider]);
    return row && await this.openProviderCredentials(row);
  }

  private async openProviderCredentials(row: SealedProviderRow): Promise<ProviderCredentials> {
    return {
      provider: row.provider,
      apiKey: await openSecret(row.sealed_api_key, this.env.VAULT_SECRET),
      baseUrl: row.base_url,
      ...(row.model_aliases_json && { modelAliases: JSON.parse(row.model_aliases_json) as Record<string, string> }),
    };
  }

  async listProviders(): Promise<
    Array<{ provider: string; baseUrl: string | null; updatedAt: number }>
  > {
    this.requireProfile();
    const rows = this.ctx.storage.sql
      .exec<{ provider: string; base_url: string | null; updated_at: number }>(
        `SELECT provider, base_url, updated_at FROM provider_keys ORDER BY provider ASC`,
      )
      .toArray();
    return rows.map((r) => ({
      provider: r.provider,
      baseUrl: r.base_url,
      updatedAt: r.updated_at,
    }));
  }

  async deleteProvider(provider: string): Promise<void> {
    this.requireProfile();
    this.ctx.storage.sql.exec(
      `DELETE FROM provider_keys WHERE provider = ?1`,
      provider.toLowerCase(),
    );
  }

  // ---- 3. Billing, Credits, Concurrency Slots & Rate Limits ----

  async getBillingSummary(): Promise<{
    balanceUsd: number;
    monthlyCapUsd: number;
    usage: Array<{
      day: string;
      model: string;
      runsCount: number;
      inputTokens: number;
      outputTokens: number;
      vmMs: number;
      costUsd: number;
    }>;
  }> {
    const p = this.requireProfile();
    const rows = this.ctx.storage.sql
      .exec<{
        day: string;
        model: string;
        runs_count: number;
        input_tokens: number;
        output_tokens: number;
        vm_ms: number;
        cost_usd: number;
      }>(`SELECT * FROM usage_daily ORDER BY day DESC, model ASC LIMIT 90`)
      .toArray();
    return {
      balanceUsd: p.balanceUsd,
      monthlyCapUsd: p.monthlyCapUsd,
      usage: rows.map((u) => ({
        day: u.day,
        model: u.model,
        runsCount: u.runs_count,
        inputTokens: u.input_tokens,
        outputTokens: u.output_tokens,
        vmMs: u.vm_ms,
        costUsd: u.cost_usd,
      })),
    };
  }

  async addCredits(input: {
    amountUsd: number;
    refId: string;
    note?: string;
  }): Promise<{ balanceUsd: number }> {
    const profile = this.requireProfile();
    const refId = input.refId.trim();
    const reserve = platformCreditReserve(this.env, profile.id);
    if (reserve && refId.startsWith(reserve.prefix)) {
      throw new ApiError(400, "invalid_credit_ref", "The credit reserve reference is reserved");
    }
    this.ctx.storage.transactionSync(() => {
      const existing = this.ctx.storage.sql
        .exec<{ id: string }>(`SELECT id FROM credit_ledger WHERE ref_id = ?1 LIMIT 1`, refId)
        .toArray();
      if (existing.length === 0) {
        if (reserve && input.amountUsd < 0 && profile.balanceUsd + input.amountUsd <= 0) {
          throw new ApiError(409, reserve.code, "The reserve tenant must retain a positive balance");
        }
        this.ctx.storage.sql.exec(
          `INSERT INTO credit_ledger (id, ref_id, amount_usd, kind, note, created_at)
           VALUES (?1, ?2, ?3, 'topup', ?4, ?5)`,
          randomId("led", 8),
          refId,
          input.amountUsd,
          input.note ?? null,
          Date.now(),
        );
        this.ctx.storage.sql.exec(
          `UPDATE tenant_profile SET balance_usd = balance_usd + ?1 WHERE id = 1`,
          input.amountUsd,
        );
      }
    });
    return { balanceUsd: this.requireProfile().balanceUsd };
  }

  async settleUsage(input: {
    refId: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    vmMs: number;
    costUsd: number;
    note?: string;
  }): Promise<{ settled: true }> {
    const profile = this.readProfileOrNull();
    if (!profile) return { settled: true };
    const now = Date.now();
    const day = new Date(now).toISOString().slice(0, 10);

    this.ctx.storage.transactionSync(() => {
      const existing = this.ctx.storage.sql
        .exec<{ id: string }>(`SELECT id FROM credit_ledger WHERE ref_id = ?1 LIMIT 1`, input.refId)
        .toArray();
      if (existing.length === 0) {
        // MONEY: Record both the full usage charge and any internal reserve grant atomically.
        const charge = Math.abs(input.costUsd);
        const remaining = profile.balanceUsd - charge;
        this.ctx.storage.sql.exec(
          `INSERT INTO credit_ledger (id, ref_id, amount_usd, kind, note, created_at)
           VALUES (?1, ?2, ?3, 'usage', ?4, ?5)`,
          randomId("led", 8),
          input.refId,
          -charge,
          input.note ?? null,
          now,
        );
        this.ctx.storage.sql.exec(
          `INSERT INTO usage_daily (day, model, runs_count, input_tokens, output_tokens, vm_ms, cost_usd)
           VALUES (?1, ?2, 1, ?3, ?4, ?5, ?6)
           ON CONFLICT(day, model) DO UPDATE SET
             runs_count = usage_daily.runs_count + 1,
             input_tokens = usage_daily.input_tokens + excluded.input_tokens,
             output_tokens = usage_daily.output_tokens + excluded.output_tokens,
             vm_ms = usage_daily.vm_ms + excluded.vm_ms,
             cost_usd = usage_daily.cost_usd + excluded.cost_usd`,
          day,
          input.model,
          input.inputTokens,
          input.outputTokens,
          input.vmMs,
          input.costUsd,
        );
        const reserve = platformCreditReserve(this.env, profile.id);
        if (reserve && remaining < 15) {
          this.ctx.storage.sql.exec(
            `INSERT INTO credit_ledger (id, ref_id, amount_usd, kind, note, created_at)
             VALUES (?1, ?2, ?3, 'grant', ?4, ?5)`,
            randomId("led", 8),
            reserve.prefix + input.refId,
            25 - remaining,
            reserve.note,
            now,
          );
          this.ctx.storage.sql.exec(`UPDATE tenant_profile SET balance_usd = 25 WHERE id = 1`);
        } else {
          this.ctx.storage.sql.exec(`UPDATE tenant_profile SET balance_usd = balance_usd - ?1 WHERE id = 1`, charge);
        }
      }
    });
    return { settled: true };
  }

  private acquireSlotSync(
    profile: TenantProfile | null,
    runId: string,
    agentId: string,
    ttlMs = 600_000,
  ): { acquired: true; balanceUsd: number; active: number; limit: number } {
    const limit = profile?.concurrencyLimit ?? 25;
    const balanceUsd = profile?.balanceUsd ?? 0;
    const now = Date.now();
    this.pruneExpiredLeases(now);

    const existingAgentLease = this.ctx.storage.sql
      .exec<{ run_id: string }>(
        `SELECT run_id FROM active_leases WHERE agent_id = ?1 LIMIT 1`,
        agentId,
      )
      .toArray();

    const currentActive = this.countBusyAgents(now);
    if (existingAgentLease.length === 0 && currentActive >= limit) {
      throw new ApiError(
        429,
        "concurrency_limit_exceeded",
        `Busy agent concurrency limit reached (${currentActive}/${limit})`,
      );
    }

    const expiresAt = now + ttlMs;
    this.ctx.storage.sql.exec(
      `INSERT INTO active_leases (run_id, agent_id, acquired_at, expires_at)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(run_id) DO UPDATE SET expires_at = excluded.expires_at`,
      runId,
      agentId,
      now,
      expiresAt,
    );

    return {
      acquired: true,
      balanceUsd,
      active: this.countBusyAgents(now),
      limit,
    };
  }

  async acquireSlot(
    runId: string,
    agentId: string,
    ttlMs = 600_000,
  ): Promise<{ acquired: true; balanceUsd: number; active: number; limit: number }> {
    return this.acquireSlotSync(this.readProfileOrNull(), runId, agentId, ttlMs);
  }

  async releaseSlot(runId: string): Promise<void> {
    this.ensureSql();
    this.ctx.storage.sql.exec(`DELETE FROM active_leases WHERE run_id = ?1`, runId);
  }

  async claimTextRun(key: string): Promise<void> {
    if (!this.textRunSchemaReady) {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS text_run_starts (
          request_key TEXT PRIMARY KEY,
          expires_at INTEGER NOT NULL
        );
      `);
      this.textRunSchemaReady = true;
    }
    const now = Date.now();
    // Keep only opaque keys. Expire them after 60s of work plus 60s of replay protection and prune on the next call.
    this.ctx.storage.sql.exec(`DELETE FROM text_run_starts WHERE expires_at <= ?1`, now);
    const rows = this.ctx.storage.sql.exec(
      `INSERT INTO text_run_starts (request_key, expires_at) VALUES (?1, ?2)
       ON CONFLICT DO NOTHING RETURNING request_key`,
      key, now + 120_000,
    ).toArray();
    if (rows.length === 0) throw new ApiError(409, "duplicate_request", "This text run has already been requested");
  }

  private prepareLegacyTextReceipts() {
    if (!this.legacyTextSchemaReady) {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS legacy_text_receipts (
          id TEXT PRIMARY KEY,
          fingerprint TEXT NOT NULL,
          started_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          body TEXT,
          billing TEXT
        )
      `);
      this.ctx.storage.sql.exec(`
        CREATE INDEX IF NOT EXISTS legacy_text_expiry ON legacy_text_receipts(expires_at) WHERE expires_at > 0
      `);
      this.legacyTextSchemaReady = true;
    }
    // The response can expire while the routing record still owns this key. Keep the claim and any unsettled charge.
    this.ctx.storage.sql.exec(`UPDATE legacy_text_receipts SET body = NULL, expires_at = 0 WHERE expires_at > 0 AND expires_at <= ?1`, Date.now());
  }

  private async scheduleLegacyTextExpiry() {
    const [{ expires_at }] = this.ctx.storage.sql.exec<{ expires_at: number | null }>(
      `SELECT MIN(expires_at) AS expires_at FROM legacy_text_receipts WHERE expires_at > 0`,
    ).toArray();
    if (expires_at === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(expires_at);
  }

  async alarm() {
    this.prepareLegacyTextReceipts();
    await this.scheduleLegacyTextExpiry();
  }

  private legacyTextReceipt(id: string) {
    return this.ctx.storage.sql.exec<{ fingerprint: string; started_at: number; expires_at: number; body: string | null }>(
      `SELECT fingerprint, started_at, expires_at, body FROM legacy_text_receipts WHERE id = ?1`, id,
    ).toArray()[0] ?? null;
  }

  async readLegacyTextReceipt(id: string) {
    this.prepareLegacyTextReceipts();
    return this.legacyTextReceipt(id);
  }

  async claimLegacyTextReceipt(id: string, fingerprint: string) {
    this.prepareLegacyTextReceipts();
    const now = Date.now();
    const inserted = this.ctx.storage.sql.exec(
      `INSERT INTO legacy_text_receipts (id, fingerprint, started_at, expires_at) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT DO NOTHING RETURNING id`, id, fingerprint, now, now + 120_000,
    ).toArray().length === 1;
    const receipt = this.legacyTextReceipt(id);
    if (!receipt) throw new Error("Legacy text receipt was not reserved");
    if (inserted) await this.scheduleLegacyTextExpiry();
    return { inserted, ...receipt };
  }

  async finishLegacyTextReceipt(id: string, fingerprint: string, startedAt: number, body: string, expiresAt: number, billing: string | null) {
    this.prepareLegacyTextReceipts();
    const saved = this.ctx.storage.sql.exec(
      `UPDATE legacy_text_receipts SET body = ?4, expires_at = ?5, billing = ?6
       WHERE id = ?1 AND fingerprint = ?2 AND started_at = ?3 AND body IS NULL AND expires_at > 0 RETURNING id`,
      id, fingerprint, startedAt, body, expiresAt, billing,
    ).toArray();
    if (!saved.length) throw new Error("Legacy text receipt is no longer owned by this execution");
    await this.scheduleLegacyTextExpiry();
  }

  async readLegacyTextBilling(id: string, fingerprint: string) {
    this.prepareLegacyTextReceipts();
    return this.ctx.storage.sql.exec<{ billing: string | null }>(
      `SELECT billing FROM legacy_text_receipts WHERE id = ?1 AND fingerprint = ?2`, id, fingerprint,
    ).toArray()[0]?.billing ?? null;
  }

  async ackLegacyTextBilling(id: string, fingerprint: string) {
    this.prepareLegacyTextReceipts();
    this.ctx.storage.sql.exec(
      `UPDATE legacy_text_receipts SET billing = '{"state":"settled"}'
       WHERE id = ?1 AND fingerprint = ?2 AND billing IS NOT NULL`, id, fingerprint,
    );
  }

  async checkRateLimit(bucketKey = "api", cost = 1): Promise<void> {
    const profile = this.readProfileOrNull();
    const capacity = Math.max(10, profile?.rateLimitRpm ?? 600);
    const refillPerMs = capacity / 60_000;
    const now = Date.now();

    const row = this.ctx.storage.sql
      .exec<{ tokens: number; updated_at: number }>(
        `SELECT tokens, updated_at FROM rate_buckets WHERE bucket_key = ?1`,
        bucketKey,
      )
      .toArray()[0];

    let tokens = capacity;
    if (row) {
      const elapsed = Math.max(0, now - row.updated_at);
      tokens = Math.min(capacity, row.tokens + elapsed * refillPerMs);
    }

    if (tokens < cost) {
      throw new ApiError(429, "rate_limited", "Tenant rate limit exceeded");
    }

    tokens -= cost;
    this.ctx.storage.sql.exec(
      `INSERT INTO rate_buckets (bucket_key, tokens, updated_at)
       VALUES (?1, ?2, ?3)
       ON CONFLICT(bucket_key) DO UPDATE SET tokens = excluded.tokens, updated_at = excluded.updated_at`,
      bucketKey,
      tokens,
      now,
    );
  }

  // ---- 4. Definitions ----

  async upsertDefinition(
    slug: string,
    config: AgentUpsertInput,
  ): Promise<{ slug: string; config: AgentUpsertInput; updatedAt: number }> {
    this.requireProfile();
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO definitions (slug, config_json, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?3)
       ON CONFLICT(slug) DO UPDATE SET config_json = excluded.config_json, updated_at = excluded.updated_at`,
      slug,
      JSON.stringify(config),
      now,
    );
    return { slug, config, updatedAt: now };
  }

  async getDefinition(slug: string): Promise<{
    slug: string;
    config: AgentUpsertInput;
    createdAt: number;
    updatedAt: number;
  } | null> {
    if (!this.readProfileOrNull()) return null;
    const row = this.ctx.storage.sql
      .exec<{ slug: string; config_json: string; created_at: number; updated_at: number }>(
        `SELECT slug, config_json, created_at, updated_at FROM definitions WHERE slug = ?1 LIMIT 1`,
        slug,
      )
      .toArray()[0];
    if (!row) return null;
    return {
      slug: row.slug,
      config: JSON.parse(row.config_json) as AgentUpsertInput,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async listDefinitions(): Promise<
    Array<{ slug: string; config: AgentUpsertInput; createdAt: number; updatedAt: number }>
  > {
    this.requireProfile();
    const rows = this.ctx.storage.sql
      .exec<{ slug: string; config_json: string; created_at: number; updated_at: number }>(
        `SELECT slug, config_json, created_at, updated_at FROM definitions ORDER BY slug ASC`,
      )
      .toArray();
    return rows.map((r) => ({
      slug: r.slug,
      config: JSON.parse(r.config_json) as AgentUpsertInput,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  async deleteDefinition(slug: string): Promise<boolean> {
    this.requireProfile();
    const existing = this.ctx.storage.sql
      .exec<{ slug: string }>(`SELECT slug FROM definitions WHERE slug = ?1 LIMIT 1`, slug)
      .toArray();
    if (existing.length === 0) return false;
    this.ctx.storage.sql.exec(`DELETE FROM definitions WHERE slug = ?1`, slug);
    return true;
  }

  // ---- 5. Agents Directory (`agents_index`) ----

  private findSealedProviderRow(candidates: string[]): SealedProviderRow | null {
    for (const candidate of candidates) {
      const row = this.ctx.storage.sql
        .exec<SealedProviderRow>(
          `SELECT provider, sealed_api_key, base_url, model_aliases_json FROM provider_keys WHERE provider = ?1 LIMIT 1`,
          candidate.toLowerCase(),
        )
        .toArray()[0];
      if (row) return row;
    }
    return null;
  }

  private resolveAgentSync(profile: TenantProfile, idOrKey: string): AgentIndexEntry | null {
    const row = this.ctx.storage.sql
      .exec<{
        id: string;
        agent_key: string;
        token_hash: string;
        sealed_token: string;
        model: string;
        repo_id: string | null;
        branch: string;
        definition_slug: string | null;
        created_at: number;
        updated_at: number;
      }>(
        `SELECT * FROM agents_index WHERE id = ?1 OR agent_key = ?1 LIMIT 1`,
        idOrKey,
      )
      .toArray()[0];
    if (!row) return null;
    return {
      id: row.id,
      tenantId: profile.id,
      key: row.agent_key,
      tokenHash: row.token_hash,
      sealedToken: row.sealed_token,
      model: row.model,
      repoId: row.repo_id,
      branch: row.branch,
      definition: row.definition_slug,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async resolveAgent(idOrKey: string): Promise<AgentIndexEntry | null> {
    const profile = this.readProfileOrNull();
    if (!profile) return null;
    return this.resolveAgentSync(profile, idOrKey);
  }

  /**
   * Single-RPC fast path for `PUT /v2/agents/:key`:
   * verifies tenant API key + loads optional definition & repo + upserts `agents_index`
   * inside one `transactionSync()`, plus pre-reads provider secret if `preacquireRunId` is set.
   */
  async authorizeAndPrepareAgent(params: {
    credKind: "tenant" | "agent";
    tokenHash: string;
    agentIdFromToken?: string;
    key: string;
    input: AgentUpsertInput;
    defaultModel: string;
    candidateAgentId: string;
    candidateTokenHash: string;
    candidateSealedToken: string;
    preacquireRunId?: string;
  }): Promise<{
    tenantId: string;
    balanceUsd: number;
    created: boolean;
    agentId: string;
    sealedToken: string;
    model: string;
    repoId: string | null;
    lineage: string | null;
    branch: string;
    definitionSlug: string | null;
    definitionConfig: AgentUpsertInput | null;
    slotAcquired: boolean;
    prefetchedProvider?: { model: string; credentials: ProviderCredentials | null };
  }> {
    const profile = this.readProfileOrNull();
    if (!profile) {
      throw new ApiError(401, "unauthorized", "Invalid API key");
    }

    if (params.credKind === "agent") {
      const ok = this.verifyAgentTokenSync(
        profile,
        params.agentIdFromToken ?? "",
        params.tokenHash,
      );
      if (!ok) throw new ApiError(401, "unauthorized", "Invalid agent token");
      throw new ApiError(
        403,
        "forbidden",
        "Agent-scoped tokens cannot access tenant management routes",
      );
    }

    const verified = this.verifyApiKeySync(profile, params.tokenHash);
    if (!verified) {
      throw new ApiError(401, "unauthorized", "Invalid API key");
    }

    const txResult = this.ctx.storage.transactionSync(() => {
      let defCfg: AgentUpsertInput | null = null;
      if (params.input.definition) {
        const defRow = this.ctx.storage.sql
          .exec<{ config_json: string }>(
            `SELECT config_json FROM definitions WHERE slug = ?1 LIMIT 1`,
            params.input.definition,
          )
          .toArray()[0];
        if (!defRow) {
          throw new ApiError(
            404,
            "definition_not_found",
            `Definition '${params.input.definition}' not found`,
          );
        }
        defCfg = JSON.parse(defRow.config_json) as AgentUpsertInput;
      }

      const existing = this.resolveAgentSync(profile, params.key);
      const created = !existing;
      const agentId = existing?.id ?? params.candidateAgentId;
      const tokenHash = existing?.tokenHash ?? params.candidateTokenHash;
      const sealedToken = existing?.sealedToken ?? params.candidateSealedToken;

      const model =
        params.input.model ??
        defCfg?.model ??
        existing?.model ??
        params.defaultModel ??
        DEFAULT_MODEL_ID;
      const repoId =
        params.input.repoId !== undefined
          ? params.input.repoId
          : (defCfg?.repoId ?? existing?.repoId ?? null);
      const branch = params.input.branch ?? defCfg?.branch ?? existing?.branch ?? "refs/heads/main";
      const definitionSlug = params.input.definition ?? existing?.definition ?? null;

      let lineage: string | null = null;
      if (repoId) {
        const repoRow = this.ctx.storage.sql
          .exec<{ lineage: string }>(`SELECT lineage FROM repos WHERE id = ?1 LIMIT 1`, repoId)
          .toArray()[0];
        if (!repoRow) {
          throw new ApiError(404, "repo_not_found", `Repository '${repoId}' not found`);
        }
        lineage = repoRow.lineage;
      }

      const now = Date.now();
      this.ctx.storage.sql.exec(
        `INSERT INTO agents_index (id, agent_key, token_hash, sealed_token, model, repo_id, branch, definition_slug, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
         ON CONFLICT(id) DO UPDATE SET
           repo_id = excluded.repo_id,
           branch = excluded.branch,
           definition_slug = COALESCE(excluded.definition_slug, agents_index.definition_slug),
           updated_at = excluded.updated_at`,
        agentId,
        params.key,
        tokenHash,
        sealedToken,
        model,
        repoId,
        branch,
        definitionSlug,
        now,
      );

      let slotAcquired = false;
      let sealedProviderRow: SealedProviderRow | null = null;

      if (params.preacquireRunId) {
        this.acquireSlotSync(profile, params.preacquireRunId, agentId);
        slotAcquired = true;
        const lookup = getProviderLookupCandidates(this.env, model);
        if (!lookup.isMock) {
          sealedProviderRow = this.findSealedProviderRow(lookup.candidates);
        }
      }

      return {
        created,
        agentId,
        sealedToken,
        model,
        repoId,
        lineage,
        branch,
        definitionSlug,
        defCfg,
        slotAcquired,
        sealedProviderRow,
      };
    });

    let prefetchedProvider: { model: string; credentials: ProviderCredentials | null } | undefined;
    if (params.preacquireRunId) {
      const row = txResult.sealedProviderRow;
      prefetchedProvider = { model: txResult.model, credentials: row && await this.openProviderCredentials(row) };
    }

    return {
      tenantId: profile.id,
      balanceUsd: profile.balanceUsd,
      created: txResult.created,
      agentId: txResult.agentId,
      sealedToken: txResult.sealedToken,
      model: txResult.model,
      repoId: txResult.repoId,
      lineage: txResult.lineage,
      branch: txResult.branch,
      definitionSlug: txResult.definitionSlug,
      definitionConfig: txResult.defCfg,
      slotAcquired: txResult.slotAcquired,
      prefetchedProvider,
    };
  }

  /**
   * Single-RPC fast path for agent-scoped routes & `POST /v2/agents/:idOrKey/runs`:
   * verifies credentials, enforces operation ACL, resolves agentId, optionally
   * pre-acquires a concurrency slot, and loads provider credentials in one TenantDO call.
   */
  async authorizeAndPrepareRun(params: {
    credKind: "tenant" | "agent";
    tokenHash: string;
    agentIdFromToken?: string;
    idOrKey: string;
    defaultModel: string;
    operation?: "read" | "run" | "input" | "admin";
    includeProviderCredentials?: boolean;
    preacquireRunId?: string;
  }): Promise<{
    auth: AuthContext;
    agentId: string;
    balanceUsd: number;
    slotAcquired: boolean;
    prefetchedProvider: { model: string; credentials: ProviderCredentials | null } | undefined;
    modelIndexUpdates?: true;
  }> {
    const profile = this.readProfileOrNull();
    if (!profile) {
      throw new ApiError(
        401,
        "unauthorized",
        params.credKind === "agent" ? "Invalid agent token" : "Invalid API key",
      );
    }

    let auth: AuthContext;
    if (params.credKind === "tenant") {
      const verified = this.verifyApiKeySync(profile, params.tokenHash);
      if (!verified) throw new ApiError(401, "unauthorized", "Invalid API key");
      auth = {
        kind: "tenant",
        tenantId: verified.tenantId,
        keyId: verified.keyId,
        scopes: verified.scopes,
      };
    } else {
      const verified = this.verifyAgentTokenSync(
        profile,
        params.agentIdFromToken ?? "",
        params.tokenHash,
      );
      if (!verified) throw new ApiError(401, "unauthorized", "Invalid agent token");
      auth = {
        kind: "agent",
        tenantId: verified.tenantId,
        agentId: verified.agentId,
        scopes: ["agent:run", "agent:read", "agent:input"],
      };
      if (params.operation === "admin") {
        throw new ApiError(403, "forbidden", "Agent token cannot perform admin operations");
      }
    }

    let agentId: string;
    let model: string;

    if (auth.kind === "agent" && auth.agentId === params.idOrKey) {
      const row = this.resolveAgentSync(profile, auth.agentId);
      agentId = auth.agentId;
      model = row?.model ?? params.defaultModel;
    } else {
      const row = this.resolveAgentSync(profile, params.idOrKey);
      if (!row) {
        throw new ApiError(404, "agent_not_found", `Agent '${params.idOrKey}' not found`);
      }
      if (auth.kind === "agent" && auth.agentId !== row.id) {
        throw new ApiError(403, "forbidden", "Agent token is scoped to a different agent");
      }
      agentId = row.id;
      model = row.model;
    }

    let slotAcquired = false;
    if (params.preacquireRunId) {
      this.acquireSlotSync(profile, params.preacquireRunId, agentId);
      slotAcquired = true;
    }

    const wantProvider = params.includeProviderCredentials ?? Boolean(params.preacquireRunId);
    let prefetchedProvider: { model: string; credentials: ProviderCredentials | null } | undefined;
    if (wantProvider) {
      const lookup = getProviderLookupCandidates(this.env, model);
      const sealedRow = lookup.isMock ? null : this.findSealedProviderRow(lookup.candidates);
      prefetchedProvider = { model, credentials: sealedRow && await this.openProviderCredentials(sealedRow) };
    }

    return {
      auth,
      agentId,
      balanceUsd: profile.balanceUsd,
      slotAcquired,
      prefetchedProvider,
      ...(params.operation === "admin" ? { modelIndexUpdates: true } : {}),
    };
  }

  async upsertAgentIndex(entry: {
    id: string;
    key: string;
    tokenHash: string;
    sealedToken: string;
    model: string;
    repoId: string | null;
    branch: string;
    definitionSlug: string | null;
  }): Promise<void> {
    this.requireProfile();
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO agents_index (id, agent_key, token_hash, sealed_token, model, repo_id, branch, definition_slug, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
       ON CONFLICT(id) DO UPDATE SET
         model = excluded.model,
         repo_id = excluded.repo_id,
         branch = excluded.branch,
         definition_slug = COALESCE(excluded.definition_slug, agents_index.definition_slug),
         updated_at = excluded.updated_at`,
      entry.id,
      entry.key,
      entry.tokenHash,
      entry.sealedToken,
      entry.model,
      entry.repoId,
      entry.branch,
      entry.definitionSlug,
      now,
    );
  }

  async updateAgentModel(agentId: string, model: string, revision: number): Promise<void> {
    this.requireProfile();
    this.ctx.storage.sql.exec(
      "UPDATE agents_index SET model = ?1, model_revision = ?2 WHERE id = ?3 AND model_revision <= ?2",
      model,
      revision,
      agentId,
    );
  }

  async updateAgentRepo(agentId: string, repoId: string, branch: string): Promise<void> {
    if (!this.readProfileOrNull()) return;
    this.ctx.storage.sql.exec(
      `UPDATE agents_index SET repo_id = ?1, branch = ?2, updated_at = ?3 WHERE id = ?4`,
      repoId,
      branch,
      Date.now(),
      agentId,
    );
  }

  async listAgents(): Promise<
    Array<{
      id: string;
      key: string;
      model: string;
      repoId: string | null;
      branch: string;
      definition: string | null;
      createdAt: number;
      updatedAt: number;
    }>
  > {
    this.requireProfile();
    const rows = this.ctx.storage.sql
      .exec<{
        id: string;
        agent_key: string;
        model: string;
        repo_id: string | null;
        branch: string;
        definition_slug: string | null;
        created_at: number;
        updated_at: number;
      }>(`SELECT * FROM agents_index ORDER BY updated_at DESC LIMIT 200`)
      .toArray();
    return rows.map((r) => ({
      id: r.id,
      key: r.agent_key,
      model: r.model,
      repoId: r.repo_id,
      branch: r.branch,
      definition: r.definition_slug,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  async deleteAgentIndex(agentId: string): Promise<void> {
    if (!this.readProfileOrNull()) return;
    this.ctx.storage.sql.exec(`DELETE FROM agents_index WHERE id = ?1`, agentId);
  }

  // ---- 6. Repos Directory (`repos`) ----

  async createRepo(body?: {
    repoId?: string;
    name?: string;
    existingLineage?: string;
    defaultRef?: string;
    commit?: string;
  }): Promise<RepoRecord> {
    const profile = this.requireProfile();
    const repoId = body?.repoId || randomId("repo", 8);
    const name = body?.name?.trim() || repoId;
    const createdAt = Date.now();

    let lineage = body?.existingLineage ?? "";
    let defaultRef = body?.defaultRef ?? "refs/heads/main";
    let commit = body?.commit ?? "";

    if (!lineage) {
      const cfs = new CamelFsClient(this.env, profile.id);
      const created = await cfs.createLineage();
      lineage = created.lineage;
      defaultRef = created.defaultRef || "refs/heads/main";
      commit = created.commit;
    }

    this.ctx.storage.sql.exec(
      `INSERT INTO repos (id, name, lineage, default_ref, commit_hash, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      repoId,
      name,
      lineage,
      defaultRef,
      commit,
      createdAt,
    );

    return {
      repoId,
      name,
      lineage,
      defaultRef,
      commit,
      createdAt,
    };
  }

  async listRepos(): Promise<RepoRecord[]> {
    this.requireProfile();
    const rows = this.ctx.storage.sql
      .exec<{
        id: string;
        name: string;
        lineage: string;
        default_ref: string;
        commit_hash: string;
        created_at: number;
      }>(`SELECT * FROM repos ORDER BY created_at DESC`)
      .toArray();
    return rows.map((r) => ({
      repoId: r.id,
      name: r.name,
      lineage: r.lineage,
      defaultRef: r.default_ref,
      commit: r.commit_hash,
      createdAt: r.created_at,
    }));
  }

  async getRepo(repoId: string): Promise<RepoRecord> {
    this.requireProfile();
    const row = this.ctx.storage.sql
      .exec<{
        id: string;
        name: string;
        lineage: string;
        default_ref: string;
        commit_hash: string;
        created_at: number;
      }>(`SELECT * FROM repos WHERE id = ?1 LIMIT 1`, repoId)
      .toArray()[0];
    if (!row) {
      throw new ApiError(404, "not_found", `Repository '${repoId}' not found`);
    }
    return {
      repoId: row.id,
      name: row.name,
      lineage: row.lineage,
      defaultRef: row.default_ref,
      commit: row.commit_hash,
      createdAt: row.created_at,
    };
  }

  async updateRepoCommit(repoId: string, commit: string): Promise<void> {
    if (!this.readProfileOrNull() || !commit) return;
    this.ctx.storage.sql.exec(
      `UPDATE repos SET commit_hash = ?1 WHERE id = ?2`,
      commit,
      repoId,
    );
  }

  async deleteRepo(repoId: string): Promise<{ deleted: true }> {
    const profile = this.requireProfile();
    const repo = await this.getRepo(repoId);
    const cfs = new CamelFsClient(this.env, profile.id);
    try {
      await cfs.deleteLineage(repo.lineage);
    } catch (err) {
      const apiErr = extractApiError(err);
      if (!apiErr || apiErr.status !== 404) {
        throw err;
      }
    }
    this.ctx.storage.sql.exec(`DELETE FROM repos WHERE id = ?1`, repoId);
    return { deleted: true };
  }

  // ---- 7. Webhooks & Channels ----

  async createWebhook(input: {
    url: string;
    events?: string[];
    secret?: string;
  }): Promise<WebhookView & { secret: string }> {
    this.requireProfile();
    const id = randomId("wh", 8);
    const secret = input.secret?.trim() || randomId("whsec", 16);
    const sealedSecret = await sealSecret(secret, this.env.VAULT_SECRET);
    const events = input.events && input.events.length > 0 ? input.events : ["*"];
    const createdAt = Date.now();

    this.ctx.storage.sql.exec(
      `INSERT INTO webhooks (id, url, events_json, sealed_secret, enabled, created_at)
       VALUES (?1, ?2, ?3, ?4, 1, ?5)`,
      id,
      input.url,
      JSON.stringify(events),
      sealedSecret,
      createdAt,
    );

    return { id, url: input.url, events, enabled: true, createdAt, secret };
  }

  async listWebhooks(): Promise<WebhookView[]> {
    this.requireProfile();
    const rows = this.ctx.storage.sql
      .exec<{
        id: string;
        url: string;
        events_json: string;
        enabled: number;
        created_at: number;
      }>(`SELECT id, url, events_json, enabled, created_at FROM webhooks ORDER BY created_at DESC`)
      .toArray();
    return rows.map((r) => ({
      id: r.id,
      url: r.url,
      events: JSON.parse(r.events_json) as string[],
      enabled: Boolean(r.enabled),
      createdAt: r.created_at,
    }));
  }

  async listEnabledWebhookTargets(): Promise<WebhookTargetRecord[]> {
    if (!this.readProfileOrNull()) return [];
    const rows = this.ctx.storage.sql
      .exec<{ id: string; url: string; events_json: string; sealed_secret: string }>(
        `SELECT id, url, events_json, sealed_secret FROM webhooks WHERE enabled = 1`,
      )
      .toArray();
    return rows.map((r) => ({
      id: r.id,
      url: r.url,
      events: JSON.parse(r.events_json) as string[],
      sealedSecret: r.sealed_secret,
    }));
  }

  async deleteWebhook(webhookId: string): Promise<boolean> {
    this.requireProfile();
    const existing = this.ctx.storage.sql
      .exec<{ id: string }>(`SELECT id FROM webhooks WHERE id = ?1 LIMIT 1`, webhookId)
      .toArray();
    if (existing.length === 0) return false;
    this.ctx.storage.sql.exec(`DELETE FROM webhooks WHERE id = ?1`, webhookId);
    return true;
  }

  async createChannel(input: {
    kind?: "slack" | "email" | "http";
    name?: string;
    definition?: string;
    agentConfig?: AgentUpsertInput;
    outboundUrl?: string;
    secret?: string;
  }): Promise<ChannelView> {
    const profile = this.requireProfile();
    const id = mintChannelId(profile.id);
    const kind = input.kind === "slack" || input.kind === "email" ? input.kind : "http";
    const name = input.name?.trim() || `${kind}-${id}`;
    const sealedSecret = input.secret
      ? await sealSecret(input.secret, this.env.VAULT_SECRET)
      : null;
    const createdAt = Date.now();

    this.ctx.storage.sql.exec(
      `INSERT INTO channels (id, kind, name, definition_slug, agent_config_json, outbound_url, sealed_secret, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      id,
      kind,
      name,
      input.definition ?? null,
      JSON.stringify(input.agentConfig ?? {}),
      input.outboundUrl ?? null,
      sealedSecret,
      createdAt,
    );

    return {
      id,
      kind,
      name,
      definition: input.definition ?? null,
      outboundUrl: input.outboundUrl ?? null,
      createdAt,
    };
  }

  async listChannels(): Promise<ChannelView[]> {
    this.requireProfile();
    const rows = this.ctx.storage.sql
      .exec<{
        id: string;
        kind: "slack" | "email" | "http";
        name: string;
        definition_slug: string | null;
        outbound_url: string | null;
        created_at: number;
      }>(`SELECT id, kind, name, definition_slug, outbound_url, created_at FROM channels ORDER BY created_at DESC`)
      .toArray();
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      name: r.name,
      definition: r.definition_slug,
      outboundUrl: r.outbound_url,
      createdAt: r.created_at,
    }));
  }

  async getChannelInternal(channelId: string): Promise<ChannelInternalRecord | null> {
    const profile = this.readProfileOrNull();
    if (!profile) return null;
    const row = this.ctx.storage.sql
      .exec<{
        id: string;
        kind: "slack" | "email" | "http";
        name: string;
        definition_slug: string | null;
        agent_config_json: string;
        outbound_url: string | null;
        sealed_secret: string | null;
        created_at: number;
      }>(`SELECT * FROM channels WHERE id = ?1 LIMIT 1`, channelId)
      .toArray()[0];
    if (!row) return null;
    return {
      id: row.id,
      tenantId: profile.id,
      kind: row.kind,
      name: row.name,
      definition: row.definition_slug,
      agentConfigJson: row.agent_config_json,
      outboundUrl: row.outbound_url,
      sealedSecret: row.sealed_secret,
      createdAt: row.created_at,
    };
  }

  async deleteChannel(channelId: string): Promise<boolean> {
    this.requireProfile();
    const existing = this.ctx.storage.sql
      .exec<{ id: string }>(`SELECT id FROM channels WHERE id = ?1 LIMIT 1`, channelId)
      .toArray();
    if (existing.length === 0) return false;
    this.ctx.storage.sql.exec(`DELETE FROM channels WHERE id = ?1`, channelId);
    return true;
  }
}
