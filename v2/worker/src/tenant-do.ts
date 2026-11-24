import { DurableObject } from "cloudflare:workers";
import { CamelFsClient } from "./camelfs.ts";
import { mintChannelId, openSecret, randomId, sealSecret } from "./crypto.ts";
import { DEFAULT_MODEL_ID, getProviderLookupCandidates } from "./pi/models.ts";
import {
  compareSlug,
  normalizeAndValidateSkill,
  selectSkillsBySelectors,
  type SkillRecord,
  type SkillSummary,
  type SkillUpsertInput,
} from "./skills.ts";
import {
  ApiError,
  extractApiError,
  type AgentUpsertInput,
  type AuthContext,
  type Env,
  type ProviderApiStyle,
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
  keyScope?: string | null;
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

export interface OpsRegisteredTenant {
  tenantId: string;
  name: string | null;
  kind: "self_serve" | "operator_made" | "operator";
  signIn: "github" | "google" | "email" | null;
  email: string | null;
  login: string | null;
  signupSource?: { ref?: string; referrer?: string } | null;
  createdAt: number;
  updatedAt: number;
}

export interface TenantOpsSnapshot {
  profile: TenantProfile;
  busyAgents: number;
  activeLeaseAgentIds: string[];
  totalAgents: number;
  configuredModels?: Array<{
    model: string;
    count: number;
  }>;
  featureCounts?: Record<string, number>;
  earliestUsageAt?: number | null;
  agentsRanCurrent?: number;
  agentsRanPrevious?: number;
  endUsersCurrent?: number;
  endUsersPrevious?: number;
  topAgentUsage?: Array<{
    agentId: string;
    agentKey: string;
    model: string;
    deleted: boolean;
    responses: number;
    activeDays: number;
    lastAt: number;
    endUsers: number;
  }>;
  agents: Array<{
    id: string;
    key: string;
    model: string;
    repoId: string | null;
    branch: string;
    definition: string | null;
    running: boolean;
    createdAt: number;
    updatedAt: number;
  }>;
  usageDaily: Array<{
    day: string;
    model: string;
    runsCount: number;
    ownKeyRuns?: number;
    inputTokens: number;
    outputTokens: number;
    vmMs: number;
    costUsd: number;
  }>;
  ledger: Array<{
    id: string;
    refId: string;
    amountUsd: number;
    kind: string;
    note: string | null;
    createdAt: number;
  }>;
  ledgerSummary: {
    purchasedUsd: number;
    grantedUsd: number;
    refundedUsd: number;
    usageUsd: number;
    firstTopupAt: number | null;
  };
  providers: string[];
  channels: Array<{ kind: string; name: string }>;
  counts: {
    apiKeys: number;
    definitions: number;
    repos: number;
    webhooks: number;
    channels: number;
  };
}

type SealedProviderRow = {
  provider: string;
  sealed_api_key: string;
  base_url: string | null;
  model_aliases_json: string | null;
  sealed_headers_json?: string | null;
  api_style?: string | null;
  scope?: string | null;
};

function extractAgentFeatureKeys(input: {
  builtins?: unknown;
  skills?: unknown;
  mcpServers?: unknown;
  tools?: unknown;
  repoId?: string | null;
}): string[] {
  const keys = new Set<string>();
  if (Array.isArray(input.builtins)) {
    for (const item of input.builtins) {
      if (typeof item === "string" && item.trim()) keys.add(item.trim());
    }
  }
  if (Array.isArray(input.skills) && input.skills.length > 0) {
    keys.add("skills");
  }
  if (Array.isArray(input.mcpServers) && input.mcpServers.length > 0) {
    keys.add("mcp");
  }
  if (Array.isArray(input.tools) && input.tools.length > 0) {
    keys.add("app_tools");
  }
  if (input.repoId) {
    keys.add("workspace");
  }
  return [...keys].sort();
}

function parseAgentUsageNote(note: string): { agentKey: string; agentId: string } | null {
  const match = /^Agent (.+) \(([^()]+)\)$/.exec(note);
  if (!match) return null;
  return { agentKey: match[1]!, agentId: match[2]! };
}

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
  private voiceSchemaReady = false;
  private consoleAccountsSchemaReady = false;
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
      CREATE INDEX IF NOT EXISTS idx_credit_ledger_kind_created ON credit_ledger(kind, created_at);
      CREATE TABLE IF NOT EXISTS agent_actors_daily (
        day TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        actor TEXT NOT NULL,
        PRIMARY KEY (day, agent_id, actor)
      );
      CREATE TABLE IF NOT EXISTS usage_daily (
        day TEXT NOT NULL,
        model TEXT NOT NULL,
        runs_count INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
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
      CREATE TABLE IF NOT EXISTS skills (
        slug TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        tags_json TEXT NOT NULL DEFAULT '[]',
        version INTEGER NOT NULL DEFAULT 1,
        content_hash TEXT NOT NULL,
        markdown TEXT NOT NULL,
        files_json TEXT NOT NULL DEFAULT '{}',
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
      CREATE TABLE IF NOT EXISTS scoped_provider_keys (
        scope TEXT NOT NULL,
        provider TEXT NOT NULL,
        sealed_api_key TEXT NOT NULL,
        base_url TEXT,
        updated_at INTEGER NOT NULL,
        model_aliases_json TEXT,
        sealed_headers_json TEXT,
        api_style TEXT,
        PRIMARY KEY (scope, provider)
      );
    `);
    const providerColumns = this.ctx.storage.sql.exec<{ name: string }>("PRAGMA table_info(provider_keys)").toArray();
    if (!providerColumns.some(({ name }) => name === "model_aliases_json")) {
      this.ctx.storage.sql.exec("ALTER TABLE provider_keys ADD COLUMN model_aliases_json TEXT");
    }
    if (!providerColumns.some(({ name }) => name === "sealed_headers_json")) {
      this.ctx.storage.sql.exec("ALTER TABLE provider_keys ADD COLUMN sealed_headers_json TEXT");
    }
    if (!providerColumns.some(({ name }) => name === "api_style")) {
      this.ctx.storage.sql.exec("ALTER TABLE provider_keys ADD COLUMN api_style TEXT");
    }
    const agentColumns = this.ctx.storage.sql.exec<{ name: string }>("PRAGMA table_info(agents_index)").toArray();
    if (!agentColumns.some(({ name }) => name === "model_revision")) {
      this.ctx.storage.sql.exec("ALTER TABLE agents_index ADD COLUMN model_revision INTEGER NOT NULL DEFAULT 0");
    }
    if (!agentColumns.some(({ name }) => name === "key_scope")) {
      this.ctx.storage.sql.exec("ALTER TABLE agents_index ADD COLUMN key_scope TEXT");
    }
    if (!agentColumns.some(({ name }) => name === "features_json")) {
      this.ctx.storage.sql.exec("ALTER TABLE agents_index ADD COLUMN features_json TEXT");
    }
    const usageColumns = this.ctx.storage.sql.exec<{ name: string }>("PRAGMA table_info(usage_daily)").toArray();
    if (!usageColumns.some(({ name }) => name === "cache_read_tokens")) {
      this.ctx.storage.sql.exec("ALTER TABLE usage_daily ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0");
    }
    if (!usageColumns.some(({ name }) => name === "own_key_runs")) {
      this.ctx.storage.sql.exec("ALTER TABLE usage_daily ADD COLUMN own_key_runs INTEGER NOT NULL DEFAULT 0");
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
    tenant: string;
    name: string;
    balanceUsd: number;
    tier: string;
    busyAgents: { active: number; limit: number };
  }> {
    const p = this.requireProfile();
    return {
      tenantId: p.id,
      tenant: p.id,
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
    options?: {
      scope?: string | null;
      headers?: Record<string, string> | null;
      apiStyle?: ProviderApiStyle | null;
    },
  ): Promise<{
    provider: string;
    scope?: string;
    baseUrl: string | null;
    apiStyle?: ProviderApiStyle | null;
    modelAliases?: Record<string, string>;
    updated: true;
  }> {
    this.requireProfile();
    const norm = provider.toLowerCase();
    const scope = options?.scope?.trim() || null;
    const sealed = apiKey ? await sealSecret(apiKey, this.env.VAULT_SECRET) : "";
    const sealedHeaders = options?.headers !== undefined
      ? (options.headers && Object.keys(options.headers).length > 0
        ? await sealSecret(JSON.stringify(options.headers), this.env.VAULT_SECRET)
        : null)
      : undefined;
    const apiStyle = options?.apiStyle === undefined ? undefined : (options.apiStyle ?? null);
    const now = Date.now();
    if (scope) {
      this.ctx.storage.sql.exec(
        `INSERT INTO scoped_provider_keys (scope, provider, sealed_api_key, base_url, updated_at, model_aliases_json, sealed_headers_json, api_style)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(scope, provider) DO UPDATE SET
           sealed_api_key = excluded.sealed_api_key,
           base_url = excluded.base_url,
           updated_at = excluded.updated_at,
           model_aliases_json = coalesce(excluded.model_aliases_json, scoped_provider_keys.model_aliases_json),
           sealed_headers_json = CASE WHEN ?9 = 1 THEN excluded.sealed_headers_json ELSE scoped_provider_keys.sealed_headers_json END,
           api_style = CASE WHEN ?10 = 1 THEN excluded.api_style ELSE scoped_provider_keys.api_style END`,
        scope,
        norm,
        sealed,
        baseUrl ?? null,
        now,
        modelAliases === undefined ? null : JSON.stringify(modelAliases),
        sealedHeaders ?? null,
        apiStyle ?? null,
        options?.headers !== undefined ? 1 : 0,
        options?.apiStyle !== undefined ? 1 : 0,
      );
    } else {
      this.ctx.storage.sql.exec(
        `INSERT INTO provider_keys (provider, sealed_api_key, base_url, updated_at, model_aliases_json, sealed_headers_json, api_style)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(provider) DO UPDATE SET
           sealed_api_key = excluded.sealed_api_key,
           base_url = excluded.base_url,
           updated_at = excluded.updated_at,
           model_aliases_json = coalesce(excluded.model_aliases_json, provider_keys.model_aliases_json),
           sealed_headers_json = CASE WHEN ?8 = 1 THEN excluded.sealed_headers_json ELSE provider_keys.sealed_headers_json END,
           api_style = CASE WHEN ?9 = 1 THEN excluded.api_style ELSE provider_keys.api_style END`,
        norm,
        sealed,
        baseUrl ?? null,
        now,
        modelAliases === undefined ? null : JSON.stringify(modelAliases),
        sealedHeaders ?? null,
        apiStyle ?? null,
        options?.headers !== undefined ? 1 : 0,
        options?.apiStyle !== undefined ? 1 : 0,
      );
    }
    return {
      provider: norm,
      ...(scope ? { scope } : {}),
      baseUrl: baseUrl ?? null,
      ...(apiStyle !== undefined ? { apiStyle } : {}),
      ...(modelAliases && { modelAliases }),
      updated: true,
    };
  }

  async getProviderSecret(provider: string, scope?: string | null): Promise<ProviderCredentials | null> {
    if (!this.readProfileOrNull()) return null;
    const row = this.findSealedProviderRow([provider], scope);
    return row && await this.openProviderCredentials(row);
  }

  private async openProviderCredentials(row: SealedProviderRow): Promise<ProviderCredentials> {
    const headers = row.sealed_headers_json
      ? JSON.parse(await openSecret(row.sealed_headers_json, this.env.VAULT_SECRET)) as Record<string, string>
      : undefined;
    return {
      provider: row.provider,
      apiKey: row.sealed_api_key ? await openSecret(row.sealed_api_key, this.env.VAULT_SECRET) : "",
      baseUrl: row.base_url,
      ...(row.model_aliases_json && { modelAliases: JSON.parse(row.model_aliases_json) as Record<string, string> }),
      ...(headers && Object.keys(headers).length > 0 && { headers }),
      ...(row.api_style && { apiStyle: row.api_style as ProviderApiStyle }),
      ...(row.scope && { scope: row.scope }),
    };
  }

  async listProviders(scope?: string | null): Promise<
    Array<{
      provider: string;
      baseUrl: string | null;
      apiStyle: ProviderApiStyle | null;
      modelAliases?: Record<string, string>;
      updatedAt: number;
    }>
  > {
    this.requireProfile();
    const normScope = scope?.trim() || null;
    const rows = normScope
      ? this.ctx.storage.sql
        .exec<{ provider: string; base_url: string | null; api_style: string | null; model_aliases_json: string | null; updated_at: number }>(
          `SELECT provider, base_url, api_style, model_aliases_json, updated_at FROM scoped_provider_keys WHERE scope = ?1 ORDER BY provider ASC`,
          normScope,
        )
        .toArray()
      : this.ctx.storage.sql
        .exec<{ provider: string; base_url: string | null; api_style: string | null; model_aliases_json: string | null; updated_at: number }>(
          `SELECT provider, base_url, api_style, model_aliases_json, updated_at FROM provider_keys ORDER BY provider ASC`,
        )
        .toArray();
    return rows.map((r) => ({
      provider: r.provider,
      baseUrl: r.base_url,
      apiStyle: (r.api_style as ProviderApiStyle | null) ?? null,
      ...(r.model_aliases_json ? { modelAliases: JSON.parse(r.model_aliases_json) as Record<string, string> } : {}),
      updatedAt: r.updated_at,
    }));
  }

  async deleteProvider(provider: string, scope?: string | null): Promise<void> {
    this.requireProfile();
    const normScope = scope?.trim() || null;
    if (normScope) {
      this.ctx.storage.sql.exec(
        `DELETE FROM scoped_provider_keys WHERE scope = ?1 AND provider = ?2`,
        normScope,
        provider.toLowerCase(),
      );
    } else {
      this.ctx.storage.sql.exec(
        `DELETE FROM provider_keys WHERE provider = ?1`,
        provider.toLowerCase(),
      );
    }
  }

  async deleteKeyScope(scope: string): Promise<void> {
    this.requireProfile();
    const normScope = scope.trim();
    if (!normScope) return;
    this.ctx.storage.sql.exec(`DELETE FROM scoped_provider_keys WHERE scope = ?1`, normScope);
  }

  // ---- 3. Billing, Credits, Concurrency Slots & Rate Limits ----

  async getBillingSummary(): Promise<{
    balanceUsd: number;
    monthlyCapUsd: number;
    tier: string;
    rateLimitRpm: number;
    busyAgents: { busy: number; limit: number | null };
    usage: Array<{
      day: string;
      model: string;
      runsCount: number;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      vmMs: number;
      costUsd: number;
    }>;
    recent: Array<{
      id: string;
      refId: string;
      amountUsd: number;
      kind: string;
      note: string | null;
      createdAt: number;
    }>;
  }> {
    const p = this.requireProfile();
    const now = Date.now();
    this.ctx.storage.sql.exec(`DELETE FROM active_leases WHERE expires_at <= ?1`, now);
    const busyRow = this.ctx.storage.sql
      .exec<{ busy: number }>(`SELECT COUNT(DISTINCT agent_id) AS busy FROM active_leases WHERE expires_at > ?1`, now)
      .toArray()[0];
    const rows = this.ctx.storage.sql
      .exec<{
        day: string;
        model: string;
        runs_count: number;
        input_tokens: number;
        output_tokens: number;
        cache_read_tokens: number;
        vm_ms: number;
        cost_usd: number;
      }>(`SELECT * FROM usage_daily ORDER BY day DESC, model ASC LIMIT 90`)
      .toArray();
    const ledgerRows = this.ctx.storage.sql
      .exec<{
        id: string;
        ref_id: string;
        amount_usd: number;
        kind: string;
        note: string | null;
        created_at: number;
      }>(`SELECT id, ref_id, amount_usd, kind, note, created_at FROM credit_ledger ORDER BY created_at DESC LIMIT 50`)
      .toArray();
    return {
      balanceUsd: p.balanceUsd,
      monthlyCapUsd: p.monthlyCapUsd,
      tier: p.tier,
      rateLimitRpm: p.rateLimitRpm,
      busyAgents: {
        busy: Number(busyRow?.busy ?? 0),
        limit: p.concurrencyLimit > 0 ? p.concurrencyLimit : null,
      },
      usage: rows.map((u) => ({
        day: u.day,
        model: u.model,
        runsCount: u.runs_count,
        inputTokens: u.input_tokens,
        outputTokens: u.output_tokens,
        cacheReadTokens: Number(u.cache_read_tokens ?? 0),
        vmMs: u.vm_ms,
        costUsd: u.cost_usd,
      })),
      recent: ledgerRows.map((l) => ({
        id: l.id,
        refId: l.ref_id,
        amountUsd: Number(l.amount_usd),
        kind: l.kind,
        note: l.note,
        createdAt: Number(l.created_at),
      })),
    };
  }

  async getUsageDays(days = 30): Promise<
    Array<{
      day: string;
      model: string;
      kind: string;
      cost: number;
      platformCost: number;
      responses: number;
      input: number;
      output: number;
    }>
  > {
    this.requireProfile();
    const clamped = Math.min(365, Math.max(1, Math.floor(days)));
    const since = new Date(Date.now() - (clamped - 1) * 86_400_000).toISOString().slice(0, 10);
    const rows = this.ctx.storage.sql
      .exec<{
        day: string;
        model: string;
        runs_count: number;
        input_tokens: number;
        output_tokens: number;
        cost_usd: number;
      }>(`SELECT day, model, runs_count, input_tokens, output_tokens, cost_usd FROM usage_daily WHERE day >= ?1 ORDER BY day DESC, model ASC`, since)
      .toArray();
    return rows.map((u) => ({
      day: u.day,
      model: u.model,
      kind: "turn",
      cost: Number(u.cost_usd),
      platformCost: Number(u.cost_usd),
      responses: Number(u.runs_count),
      input: Number(u.input_tokens),
      output: Number(u.output_tokens),
    }));
  }

  async addCredits(input: {
    amountUsd: number;
    refId: string;
    note?: string;
    kind?: "topup" | "grant";
  }): Promise<{ balanceUsd: number }> {
    const profile = this.requireProfile();
    const refId = input.refId.trim();
    const kind = input.kind === "grant" ? "grant" : "topup";
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
           VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
          randomId("led", 8),
          refId,
          input.amountUsd,
          kind,
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
    cacheReadTokens?: number;
    vmMs: number;
    costUsd: number;
    note?: string;
    agentId?: string;
    actor?: string;
    byok?: boolean;
  }): Promise<{ settled: true }> {
    const profile = this.readProfileOrNull();
    if (!profile) return { settled: true };
    const now = Date.now();
    const day = new Date(now).toISOString().slice(0, 10);
    const isByok = input.byok === true;

    this.ctx.storage.transactionSync(() => {
      const existing = this.ctx.storage.sql
        .exec<{ id: string }>(`SELECT id FROM credit_ledger WHERE ref_id = ?1 LIMIT 1`, input.refId)
        .toArray();
      if (existing.length === 0) {
        // MONEY: Record both the full usage charge and any internal reserve grant atomically.
        // BYOK runs never drive platform balanceUsd negative.
        const rawCharge = Math.abs(input.costUsd);
        const charge = isByok
          ? Number(Math.min(Math.max(0, profile.balanceUsd), rawCharge).toFixed(8))
          : rawCharge;
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
          `INSERT INTO usage_daily (day, model, runs_count, own_key_runs, input_tokens, output_tokens, cache_read_tokens, vm_ms, cost_usd)
           VALUES (?1, ?2, 1, ?3, ?4, ?5, ?6, ?7, ?8)
           ON CONFLICT(day, model) DO UPDATE SET
             runs_count = usage_daily.runs_count + 1,
             own_key_runs = usage_daily.own_key_runs + excluded.own_key_runs,
             input_tokens = usage_daily.input_tokens + excluded.input_tokens,
             output_tokens = usage_daily.output_tokens + excluded.output_tokens,
             cache_read_tokens = usage_daily.cache_read_tokens + excluded.cache_read_tokens,
             vm_ms = usage_daily.vm_ms + excluded.vm_ms,
             cost_usd = usage_daily.cost_usd + excluded.cost_usd`,
          day,
          input.model,
          isByok ? 1 : 0,
          input.inputTokens,
          input.outputTokens,
          input.cacheReadTokens ?? 0,
          input.vmMs,
          charge,
        );
        if (input.agentId && input.actor && input.actor.trim()) {
          this.ctx.storage.sql.exec(
            `INSERT OR IGNORE INTO agent_actors_daily (day, agent_id, actor) VALUES (?1, ?2, ?3)`,
            day,
            input.agentId,
            input.actor.trim(),
          );
        }
        if (input.agentId) {
          this.ctx.storage.sql.exec(
            `UPDATE agents_index SET updated_at = MAX(updated_at, ?1) WHERE id = ?2`,
            now,
            input.agentId,
          );
        }
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
        } else if (charge > 0) {
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

  // ---- 4b. Tenant-Scoped Skills ----

  async upsertSkill(slug: string, input: SkillUpsertInput): Promise<SkillSummary> {
    this.requireProfile();
    const normalized = await normalizeAndValidateSkill(slug, input);
    const now = Date.now();
    const tagsJson = JSON.stringify(normalized.tags);
    const filesJson = JSON.stringify(normalized.files);
    const fileList = Object.keys(normalized.files).sort(compareSlug);

    return this.ctx.storage.transactionSync(() => {
      const existing = this.ctx.storage.sql
        .exec<{
          version: number;
          content_hash: string;
          created_at: number;
          updated_at: number;
        }>(
          `SELECT version, content_hash, created_at, updated_at FROM skills WHERE slug = ?1 LIMIT 1`,
          normalized.slug,
        )
        .toArray()[0];

      if (existing && existing.content_hash === normalized.contentHash) {
        return {
          slug: normalized.slug,
          name: normalized.name,
          description: normalized.description,
          tags: normalized.tags,
          version: Number(existing.version),
          contentHash: existing.content_hash,
          files: fileList,
          createdAt: Number(existing.created_at),
          updatedAt: Number(existing.updated_at),
        };
      }

      const version = existing ? Number(existing.version) + 1 : 1;
      const createdAt = existing ? Number(existing.created_at) : now;
      const updatedAt = now;

      this.ctx.storage.sql.exec(
        `INSERT INTO skills (slug, name, description, tags_json, version, content_hash, markdown, files_json, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT(slug) DO UPDATE SET
           name = excluded.name,
           description = excluded.description,
           tags_json = excluded.tags_json,
           version = excluded.version,
           content_hash = excluded.content_hash,
           markdown = excluded.markdown,
           files_json = excluded.files_json,
           updated_at = excluded.updated_at`,
        normalized.slug,
        normalized.name,
        normalized.description,
        tagsJson,
        version,
        normalized.contentHash,
        normalized.markdown,
        filesJson,
        createdAt,
        updatedAt,
      );

      return {
        slug: normalized.slug,
        name: normalized.name,
        description: normalized.description,
        tags: normalized.tags,
        version,
        contentHash: normalized.contentHash,
        files: fileList,
        createdAt,
        updatedAt,
      };
    });
  }

  async listSkills(opts?: { prefix?: string; tag?: string }): Promise<SkillSummary[]> {
    this.requireProfile();
    const rows = this.ctx.storage.sql
      .exec<{
        slug: string;
        name: string;
        description: string;
        tags_json: string;
        version: number;
        content_hash: string;
        files_json: string;
        created_at: number;
        updated_at: number;
      }>(
        `SELECT slug, name, description, tags_json, version, content_hash, files_json, created_at, updated_at
         FROM skills ORDER BY slug ASC`,
      )
      .toArray();

    const prefix = opts?.prefix?.trim() || "";
    const tagLower = opts?.tag?.trim().toLowerCase() || "";

    const out: SkillSummary[] = [];
    for (const r of rows) {
      if (prefix && !r.slug.startsWith(prefix)) continue;
      const tags = JSON.parse(r.tags_json) as string[];
      if (tagLower && !tags.some((t) => t.toLowerCase() === tagLower)) continue;
      const filesMap = JSON.parse(r.files_json) as Record<string, string>;
      out.push({
        slug: r.slug,
        name: r.name,
        description: r.description,
        tags,
        version: Number(r.version),
        contentHash: r.content_hash,
        files: Object.keys(filesMap).sort(compareSlug),
        createdAt: Number(r.created_at),
        updatedAt: Number(r.updated_at),
      });
    }
    return out;
  }

  async getSkill(slug: string): Promise<SkillRecord | null> {
    if (!this.readProfileOrNull()) return null;
    const clean = slug.trim();
    if (!clean) return null;
    const row = this.ctx.storage.sql
      .exec<{
        slug: string;
        name: string;
        description: string;
        tags_json: string;
        version: number;
        content_hash: string;
        markdown: string;
        files_json: string;
        created_at: number;
        updated_at: number;
      }>(
        `SELECT slug, name, description, tags_json, version, content_hash, markdown, files_json, created_at, updated_at
         FROM skills WHERE slug = ?1 LIMIT 1`,
        clean,
      )
      .toArray()[0];
    if (!row) return null;
    return {
      slug: row.slug,
      name: row.name,
      description: row.description,
      tags: JSON.parse(row.tags_json) as string[],
      version: Number(row.version),
      contentHash: row.content_hash,
      markdown: row.markdown,
      files: JSON.parse(row.files_json) as Record<string, string>,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  async deleteSkill(slug: string): Promise<{ deleted: boolean }> {
    this.requireProfile();
    const clean = slug.trim();
    if (!clean) return { deleted: false };
    const existing = this.ctx.storage.sql
      .exec<{ slug: string }>(`SELECT slug FROM skills WHERE slug = ?1 LIMIT 1`, clean)
      .toArray();
    if (existing.length === 0) return { deleted: false };
    this.ctx.storage.sql.exec(`DELETE FROM skills WHERE slug = ?1`, clean);
    return { deleted: true };
  }

  async resolveSkills(selectors: string[]): Promise<SkillRecord[]> {
    if (!this.readProfileOrNull()) return [];
    if (!Array.isArray(selectors) || selectors.length === 0) return [];
    const cleaned = selectors.map((s) => (typeof s === "string" ? s.trim() : "")).filter(Boolean);
    if (cleaned.length === 0) return [];

    const rows = this.ctx.storage.sql
      .exec<{
        slug: string;
        name: string;
        description: string;
        tags_json: string;
        version: number;
        content_hash: string;
        markdown: string;
        files_json: string;
        created_at: number;
        updated_at: number;
      }>(
        `SELECT slug, name, description, tags_json, version, content_hash, markdown, files_json, created_at, updated_at
         FROM skills ORDER BY slug ASC`,
      )
      .toArray();

    const matchedRows = selectSkillsBySelectors(rows, cleaned);
    return matchedRows.map((row) => ({
      slug: row.slug,
      name: row.name,
      description: row.description,
      tags: JSON.parse(row.tags_json) as string[],
      version: Number(row.version),
      contentHash: row.content_hash,
      markdown: row.markdown,
      files: JSON.parse(row.files_json) as Record<string, string>,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    }));
  }

  // ---- 5. Agents Directory (`agents_index`) ----

  private findSealedProviderRow(candidates: string[], scope?: string | null): SealedProviderRow | null {
    const normScope = scope?.trim() || null;
    if (normScope) {
      for (const candidate of candidates) {
        const row = this.ctx.storage.sql
          .exec<SealedProviderRow>(
            `SELECT scope, provider, sealed_api_key, base_url, model_aliases_json, sealed_headers_json, api_style
             FROM scoped_provider_keys WHERE scope = ?1 AND provider = ?2 LIMIT 1`,
            normScope,
            candidate.toLowerCase(),
          )
          .toArray()[0];
        if (row) return row;
      }
      return null;
    }
    for (const candidate of candidates) {
      const row = this.ctx.storage.sql
        .exec<SealedProviderRow>(
          `SELECT provider, sealed_api_key, base_url, model_aliases_json, sealed_headers_json, api_style
           FROM provider_keys WHERE provider = ?1 LIMIT 1`,
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
        key_scope: string | null;
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
      keyScope: row.key_scope ?? null,
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
    keyScope: string | null;
    repoId: string | null;
    lineage: string | null;
    branch: string;
    definitionSlug: string | null;
    definitionConfig: AgentUpsertInput | null;
    slotAcquired: boolean;
    prefetchedProvider?: { model: string; keyScope?: string | null; credentials: ProviderCredentials | null };
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
      const keyScope =
        params.input.keyScope !== undefined
          ? (params.input.keyScope?.trim() || null)
          : (defCfg?.keyScope !== undefined ? (defCfg.keyScope?.trim() || null) : (existing?.keyScope ?? null));
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

      const hasExplicitFeatures =
        params.input.builtins !== undefined ||
        params.input.skills !== undefined ||
        params.input.mcpServers !== undefined ||
        params.input.tools !== undefined ||
        defCfg !== null ||
        created;
      const featuresJson = hasExplicitFeatures
        ? JSON.stringify(
            extractAgentFeatureKeys({
              builtins: params.input.builtins ?? defCfg?.builtins,
              skills: params.input.skills ?? defCfg?.skills,
              mcpServers: params.input.mcpServers ?? defCfg?.mcpServers,
              tools: params.input.tools ?? defCfg?.tools,
              repoId,
            }),
          )
        : null;

      const now = Date.now();
      this.ctx.storage.sql.exec(
        `INSERT INTO agents_index (id, agent_key, token_hash, sealed_token, model, key_scope, repo_id, branch, definition_slug, features_json, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)
         ON CONFLICT(id) DO UPDATE SET
           key_scope = excluded.key_scope,
           repo_id = excluded.repo_id,
           branch = excluded.branch,
           definition_slug = COALESCE(excluded.definition_slug, agents_index.definition_slug),
           features_json = COALESCE(excluded.features_json, agents_index.features_json),
           updated_at = excluded.updated_at`,
        agentId,
        params.key,
        tokenHash,
        sealedToken,
        model,
        keyScope,
        repoId,
        branch,
        definitionSlug,
        featuresJson,
        now,
      );

      let slotAcquired = false;
      let sealedProviderRow: SealedProviderRow | null = null;

      if (params.preacquireRunId) {
        this.acquireSlotSync(profile, params.preacquireRunId, agentId);
        slotAcquired = true;
        const lookup = getProviderLookupCandidates(this.env, model, keyScope);
        if (!lookup.isMock) {
          sealedProviderRow = this.findSealedProviderRow(lookup.candidates, keyScope);
        }
      }

      return {
        created,
        agentId,
        sealedToken,
        model,
        keyScope,
        repoId,
        lineage,
        branch,
        definitionSlug,
        defCfg,
        slotAcquired,
        sealedProviderRow,
      };
    });

    let prefetchedProvider: { model: string; keyScope?: string | null; credentials: ProviderCredentials | null } | undefined;
    if (params.preacquireRunId) {
      const row = txResult.sealedProviderRow;
      prefetchedProvider = {
        model: txResult.model,
        keyScope: txResult.keyScope,
        credentials: row && await this.openProviderCredentials(row),
      };
    }

    return {
      tenantId: profile.id,
      balanceUsd: profile.balanceUsd,
      created: txResult.created,
      agentId: txResult.agentId,
      sealedToken: txResult.sealedToken,
      model: txResult.model,
      keyScope: txResult.keyScope,
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
    keyScopeOverride?: string | null;
    operation?: "read" | "run" | "input" | "admin";
    includeProviderCredentials?: boolean;
    preacquireRunId?: string;
  }): Promise<{
    auth: AuthContext;
    agentId: string;
    balanceUsd: number;
    slotAcquired: boolean;
    prefetchedProvider: { model: string; keyScope?: string | null; credentials: ProviderCredentials | null } | undefined;
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
    let keyScope: string | null = null;

    if (auth.kind === "agent" && auth.agentId === params.idOrKey) {
      const row = this.resolveAgentSync(profile, auth.agentId);
      agentId = auth.agentId;
      model = row?.model ?? params.defaultModel;
      keyScope = row?.keyScope ?? null;
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
      keyScope = row.keyScope ?? null;
    }
    if (params.keyScopeOverride !== undefined) {
      keyScope = params.keyScopeOverride?.trim() || null;
    }

    let slotAcquired = false;
    if (params.preacquireRunId) {
      this.acquireSlotSync(profile, params.preacquireRunId, agentId);
      slotAcquired = true;
    }

    const wantProvider = params.includeProviderCredentials ?? Boolean(params.preacquireRunId);
    let prefetchedProvider: { model: string; keyScope?: string | null; credentials: ProviderCredentials | null } | undefined;
    if (wantProvider) {
      const lookup = getProviderLookupCandidates(this.env, model, keyScope);
      const sealedRow = lookup.isMock ? null : this.findSealedProviderRow(lookup.candidates, keyScope);
      prefetchedProvider = {
        model,
        keyScope,
        credentials: sealedRow && await this.openProviderCredentials(sealedRow),
      };
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

  async updateAgentModel(agentId: string, model: string, revision: number, keyScope?: string | null): Promise<void> {
    this.requireProfile();
    if (keyScope !== undefined) {
      this.ctx.storage.sql.exec(
        "UPDATE agents_index SET model = ?1, model_revision = ?2, key_scope = ?3 WHERE id = ?4 AND model_revision <= ?2",
        model,
        revision,
        keyScope?.trim() || null,
        agentId,
      );
      return;
    }
    this.ctx.storage.sql.exec(
      "UPDATE agents_index SET model = ?1, model_revision = ?2 WHERE id = ?3 AND model_revision <= ?2",
      model,
      revision,
      agentId,
    );
  }

  async updateAgentRepo(agentId: string, repoId: string | null, branch: string): Promise<void> {
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
      running: boolean;
      createdAt: number;
      updatedAt: number;
    }>
  >;
  async listAgents(opts: {
    limit?: number;
    cursor?: string;
    prefix?: string;
    definitionId?: string;
  }): Promise<{
    agents: Array<{
      id: string;
      key: string;
      model: string;
      repoId: string | null;
      branch: string;
      definition: string | null;
      running: boolean;
      createdAt: number;
      updatedAt: number;
    }>;
    nextCursor?: string;
    total: number;
  }>;
  async listAgents(opts?: {
    limit?: number;
    cursor?: string;
    prefix?: string;
    definitionId?: string;
  }): Promise<
    | Array<{
        id: string;
        key: string;
        model: string;
        repoId: string | null;
        branch: string;
        definition: string | null;
        running: boolean;
        createdAt: number;
        updatedAt: number;
      }>
    | {
        agents: Array<{
          id: string;
          key: string;
          model: string;
          repoId: string | null;
          branch: string;
          definition: string | null;
          running: boolean;
          createdAt: number;
          updatedAt: number;
        }>;
        nextCursor?: string;
        total: number;
      }
  > {
    this.requireProfile();
    const now = Date.now();
    this.pruneExpiredLeases(now);
    const activeRows = this.ctx.storage.sql
      .exec<{ agent_id: string }>(`SELECT DISTINCT agent_id FROM active_leases WHERE expires_at > ?1`, now)
      .toArray();
    const activeIds = new Set(activeRows.map((r) => r.agent_id));

    type AgentIndexRow = {
      id: string;
      agent_key: string;
      model: string;
      repo_id: string | null;
      branch: string;
      definition_slug: string | null;
      created_at: number;
      updated_at: number;
    };
    const mapRow = (r: AgentIndexRow) => ({
      id: r.id,
      key: r.agent_key,
      model: r.model,
      repoId: r.repo_id,
      branch: r.branch,
      definition: r.definition_slug,
      running: activeIds.has(r.id),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    });

    if (opts === undefined) {
      const rows = this.ctx.storage.sql
        .exec<AgentIndexRow>(`SELECT * FROM agents_index ORDER BY updated_at DESC, id DESC LIMIT 200`)
        .toArray();
      return rows.map(mapRow);
    }

    const limit = Math.min(200, Math.max(1, Math.floor(opts.limit ?? 50)));
    const offset = parsePaginationCursor(opts.cursor);
    const prefix = opts.prefix?.trim() || "";
    const definitionId = opts.definitionId?.trim() || "";

    const clauses: string[] = [];
    const params: unknown[] = [];
    if (prefix) {
      params.push(prefix.length, prefix, prefix.length, prefix);
      const p1 = params.length - 3;
      const p2 = params.length - 2;
      const p3 = params.length - 1;
      const p4 = params.length;
      clauses.push(`(substr(agent_key, 1, ?${p1}) = ?${p2} OR substr(id, 1, ?${p3}) = ?${p4})`);
    }
    if (definitionId) {
      params.push(definitionId);
      clauses.push(`definition_slug = ?${params.length}`);
    }
    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";

    const totalRow = this.ctx.storage.sql
      .exec<{ cnt: number }>(`SELECT COUNT(*) AS cnt FROM agents_index ${whereSql}`, ...params)
      .one();
    const total = Number(totalRow.cnt ?? 0);

    const pageParams = [...params, limit, offset];
    const limitIdx = params.length + 1;
    const offsetIdx = params.length + 2;
    const rows = this.ctx.storage.sql
      .exec<AgentIndexRow>(
        `SELECT * FROM agents_index ${whereSql} ORDER BY updated_at DESC, id DESC LIMIT ?${limitIdx} OFFSET ?${offsetIdx}`,
        ...pageParams,
      )
      .toArray();

    const agents = rows.map(mapRow);
    const nextOffset = offset + agents.length;
    return {
      agents,
      ...(nextOffset < total ? { nextCursor: String(nextOffset) } : {}),
      total,
    };
  }

  async listAgentIdsPage(
    after?: string,
    limit = 50,
  ): Promise<{ agentIds: string[]; nextAfter: string | null }> {
    const profile = this.readProfileOrNull();
    if (!profile) {
      return { agentIds: [], nextAfter: null };
    }
    const safeLimit = Math.max(1, Math.min(200, Math.floor(Number(limit) || 50)));
    const cursor = typeof after === "string" && after.length > 0 ? after : undefined;
    const rows = cursor
      ? this.ctx.storage.sql
          .exec<{ id: string }>(
            `SELECT id FROM agents_index WHERE id > ?1 ORDER BY id ASC LIMIT ?2`,
            cursor,
            safeLimit + 1,
          )
          .toArray()
      : this.ctx.storage.sql
          .exec<{ id: string }>(
            `SELECT id FROM agents_index ORDER BY id ASC LIMIT ?1`,
            safeLimit + 1,
          )
          .toArray();
    const hasMore = rows.length > safeLimit;
    if (hasMore) rows.pop();
    const agentIds = rows.map((r) => r.id);
    const nextAfter = hasMore && agentIds.length > 0 ? agentIds[agentIds.length - 1]! : null;
    return { agentIds, nextAfter };
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

  async listRepos(): Promise<RepoRecord[]>;
  async listRepos(opts: {
    limit?: number;
    cursor?: string;
    prefix?: string;
  }): Promise<{
    repos: RepoRecord[];
    nextCursor?: string;
    total: number;
  }>;
  async listRepos(opts?: {
    limit?: number;
    cursor?: string;
    prefix?: string;
  }): Promise<RepoRecord[] | { repos: RepoRecord[]; nextCursor?: string; total: number }> {
    this.requireProfile();
    type RepoRow = {
      id: string;
      name: string;
      lineage: string;
      default_ref: string;
      commit_hash: string;
      created_at: number;
    };
    const mapRow = (r: RepoRow): RepoRecord => ({
      repoId: r.id,
      name: r.name,
      lineage: r.lineage,
      defaultRef: r.default_ref,
      commit: r.commit_hash,
      createdAt: r.created_at,
    });

    if (opts === undefined) {
      const rows = this.ctx.storage.sql
        .exec<RepoRow>(`SELECT * FROM repos ORDER BY created_at DESC, id DESC`)
        .toArray();
      return rows.map(mapRow);
    }

    const limit = Math.min(200, Math.max(1, Math.floor(opts.limit ?? 50)));
    const offset = parsePaginationCursor(opts.cursor);
    const prefix = opts.prefix?.trim() || "";

    const clauses: string[] = [];
    const params: unknown[] = [];
    if (prefix) {
      params.push(prefix.length, prefix, prefix.length, prefix);
      clauses.push(`(substr(id, 1, ?1) = ?2 OR substr(name, 1, ?3) = ?4)`);
    }
    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";

    const totalRow = this.ctx.storage.sql
      .exec<{ cnt: number }>(`SELECT COUNT(*) AS cnt FROM repos ${whereSql}`, ...params)
      .one();
    const total = Number(totalRow.cnt ?? 0);

    const pageParams = [...params, limit, offset];
    const limitIdx = params.length + 1;
    const offsetIdx = params.length + 2;
    const rows = this.ctx.storage.sql
      .exec<RepoRow>(
        `SELECT * FROM repos ${whereSql} ORDER BY created_at DESC, id DESC LIMIT ?${limitIdx} OFFSET ?${offsetIdx}`,
        ...pageParams,
      )
      .toArray();

    const repos = rows.map(mapRow);
    const nextOffset = offset + repos.length;
    return {
      repos,
      ...(nextOffset < total ? { nextCursor: String(nextOffset) } : {}),
      total,
    };
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

  // ---- Legacy v1 -> v2 Translation Bridge Helpers ----

  private ensureLegacyBridgeTables(): void {
    this.ensureSql();
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS legacy_bridge_key (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        sealed_token TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS legacy_bridge_meta (
        kind TEXT NOT NULL,
        id TEXT NOT NULL,
        data_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (kind, id)
      );
    `);
  }

  async ensureLegacyBridgeTenant(input: {
    tenantId: string;
    name: string;
    initialCreditsUsd?: number;
    keyId: string;
    keyPrefix: string;
    keyHash: string;
    sealedToken: string;
  }): Promise<{ profile: TenantProfile; sealedToken: string }> {
    this.ensureLegacyBridgeTables();
    const existing = this.readProfileOrNull();
    const existingKey = this.ctx.storage.sql
      .exec<{ sealed_token: string }>(`SELECT sealed_token FROM legacy_bridge_key WHERE id = 1`)
      .toArray()[0];
    if (existing && existingKey) {
      return { profile: existing, sealedToken: existingKey.sealed_token };
    }
    const now = Date.now();
    const initialCredits = Number(input.initialCreditsUsd ?? 25);
    this.ctx.storage.transactionSync(() => {
      if (!existing) {
        this.ctx.storage.sql.exec(
          `INSERT INTO tenant_profile (id, tenant_id, name, tier, balance_usd, monthly_cap_usd, concurrency_limit, rate_limit_rpm, created_at)
           VALUES (1, ?1, ?2, 'pro', ?3, 1000, 25, 600, ?4)`,
          input.tenantId,
          input.name,
          initialCredits,
          now,
        );
        if (initialCredits !== 0) {
          this.ctx.storage.sql.exec(
            `INSERT INTO credit_ledger (id, ref_id, amount_usd, kind, note, created_at)
             VALUES (?1, 'initial_grant', ?2, 'grant', 'Initial v1 bridge tenant credits', ?3)`,
            randomId("led", 8),
            initialCredits,
            now,
          );
        }
      }
      if (!existingKey) {
        this.ctx.storage.sql.exec(
          `INSERT OR IGNORE INTO api_keys (id, name, prefix, key_hash, scopes_json, created_at)
           VALUES (?1, 'v1-bridge', ?2, ?3, '["*"]', ?4)`,
          input.keyId,
          input.keyPrefix,
          input.keyHash,
          now,
        );
        this.ctx.storage.sql.exec(
          `INSERT OR REPLACE INTO legacy_bridge_key (id, sealed_token) VALUES (1, ?1)`,
          input.sealedToken,
        );
      }
    });
    return {
      profile: this.requireProfile(),
      sealedToken: existingKey?.sealed_token ?? input.sealedToken,
    };
  }

  async putLegacyBridgeMeta(kind: string, id: string, data: unknown): Promise<void> {
    this.ensureLegacyBridgeTables();
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO legacy_bridge_meta (kind, id, data_json, updated_at) VALUES (?1, ?2, ?3, ?4)`,
      kind,
      id,
      JSON.stringify(data),
      Date.now(),
    );
  }

  async getLegacyBridgeMeta<T = unknown>(kind: string, id: string): Promise<T | null> {
    this.ensureLegacyBridgeTables();
    const row = this.ctx.storage.sql
      .exec<{ data_json: string }>(`SELECT data_json FROM legacy_bridge_meta WHERE kind = ?1 AND id = ?2 LIMIT 1`, kind, id)
      .toArray()[0];
    return row ? (JSON.parse(row.data_json) as T) : null;
  }

  async listLegacyBridgeMeta<T = unknown>(kind: string): Promise<Array<{ id: string; data: T }>> {
    this.ensureLegacyBridgeTables();
    return this.ctx.storage.sql
      .exec<{ id: string; data_json: string }>(
        `SELECT id, data_json FROM legacy_bridge_meta WHERE kind = ?1 ORDER BY updated_at DESC`,
        kind,
      )
      .toArray()
      .map((row) => ({ id: row.id, data: JSON.parse(row.data_json) as T }));
  }

  async deleteLegacyBridgeMeta(kind: string, id: string): Promise<boolean> {
    this.ensureLegacyBridgeTables();
    const exists = this.ctx.storage.sql
      .exec<{ id: string }>(`SELECT id FROM legacy_bridge_meta WHERE kind = ?1 AND id = ?2 LIMIT 1`, kind, id)
      .toArray();
    if (!exists.length) return false;
    this.ctx.storage.sql.exec(`DELETE FROM legacy_bridge_meta WHERE kind = ?1 AND id = ?2`, kind, id);
    return true;
  }

  // ---- Voice Calls Index & ElevenLabs Provisioning Index ----

  private ensureVoiceTables(): void {
    if (this.voiceSchemaReady) return;
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS voice_calls (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        provider_call TEXT,
        state TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_voice_calls_created ON voice_calls(created_at DESC, id DESC);
      CREATE TABLE IF NOT EXISTS elevenlabs_call_webhooks (
        key_hash TEXT PRIMARY KEY,
        webhook_id TEXT NOT NULL,
        sealed_secret TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS elevenlabs_call_agents (
        agent_id TEXT PRIMARY KEY,
        key_hash TEXT NOT NULL,
        model TEXT NOT NULL,
        persona_hash TEXT NOT NULL,
        sealed_tool_secret TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_elevenlabs_agents_identity
        ON elevenlabs_call_agents(key_hash, model, persona_hash);
      CREATE TABLE IF NOT EXISTS elevenlabs_conversations (
        provider_call TEXT PRIMARY KEY,
        call_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        state TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    this.voiceSchemaReady = true;
  }

  async reserveVoiceCall(input: {
    id: string;
    agentId: string;
    provider: string;
    limit: number;
  }): Promise<{ ok: true } | { ok: false; liveCount: number }> {
    this.ensureVoiceTables();
    return this.ctx.storage.transactionSync(() => {
      const live = this.ctx.storage.sql
        .exec<{ cnt: number }>(`SELECT COUNT(*) AS cnt FROM voice_calls WHERE state != 'ended'`)
        .one();
      const liveCount = Number(live.cnt ?? 0);
      if (liveCount >= input.limit) {
        return { ok: false as const, liveCount };
      }
      const now = Date.now();
      this.ctx.storage.sql.exec(
        `INSERT INTO voice_calls (id, agent_id, provider, provider_call, state, created_at, updated_at)
         VALUES (?1, ?2, ?3, NULL, 'connecting', ?4, ?4)`,
        input.id,
        input.agentId,
        input.provider,
        now,
      );
      return { ok: true as const };
    });
  }

  async updateVoiceCallIndex(input: {
    id: string;
    state: string;
    providerCall?: string | null;
  }): Promise<void> {
    this.ensureVoiceTables();
    this.ctx.storage.sql.exec(
      `UPDATE voice_calls
       SET state = ?2,
           provider_call = COALESCE(?3, provider_call),
           updated_at = ?4
       WHERE id = ?1`,
      input.id,
      input.state,
      input.providerCall ?? null,
      Date.now(),
    );
  }

  async listVoiceCallIds(input: { state?: "live" | "ended" | null; limit: number }): Promise<string[]> {
    this.ensureVoiceTables();
    const limit = Math.max(1, Math.min(100, Math.trunc(input.limit || 50)));
    const rows = input.state === "ended"
      ? this.ctx.storage.sql
          .exec<{ id: string }>(
            `SELECT id FROM voice_calls WHERE state = 'ended' ORDER BY created_at DESC, id DESC LIMIT ?1`,
            limit,
          )
          .toArray()
      : input.state === "live"
        ? this.ctx.storage.sql
            .exec<{ id: string }>(
              `SELECT id FROM voice_calls WHERE state != 'ended' ORDER BY created_at DESC, id DESC LIMIT ?1`,
              limit,
            )
            .toArray()
        : this.ctx.storage.sql
            .exec<{ id: string }>(
              `SELECT id FROM voice_calls ORDER BY created_at DESC, id DESC LIMIT ?1`,
              limit,
            )
            .toArray();
    return rows.map((r) => r.id);
  }

  async getElevenLabsWebhook(keyHash: string): Promise<{ webhookId: string; sealedSecret: string } | null> {
    this.ensureVoiceTables();
    const row = this.ctx.storage.sql
      .exec<{ webhook_id: string; sealed_secret: string }>(
        `SELECT webhook_id, sealed_secret FROM elevenlabs_call_webhooks WHERE key_hash = ?1 LIMIT 1`,
        keyHash,
      )
      .toArray()[0];
    return row ? { webhookId: row.webhook_id, sealedSecret: row.sealed_secret } : null;
  }

  async putElevenLabsWebhook(input: {
    keyHash: string;
    webhookId: string;
    sealedSecret: string;
  }): Promise<{ webhookId: string; sealedSecret: string }> {
    this.ensureVoiceTables();
    return this.ctx.storage.transactionSync(() => {
      const existing = this.ctx.storage.sql
        .exec<{ webhook_id: string; sealed_secret: string }>(
          `SELECT webhook_id, sealed_secret FROM elevenlabs_call_webhooks WHERE key_hash = ?1 LIMIT 1`,
          input.keyHash,
        )
        .toArray()[0];
      if (existing) return { webhookId: existing.webhook_id, sealedSecret: existing.sealed_secret };
      this.ctx.storage.sql.exec(
        `INSERT INTO elevenlabs_call_webhooks (key_hash, webhook_id, sealed_secret, created_at)
         VALUES (?1, ?2, ?3, ?4)`,
        input.keyHash,
        input.webhookId,
        input.sealedSecret,
        Date.now(),
      );
      return { webhookId: input.webhookId, sealedSecret: input.sealedSecret };
    });
  }

  async findElevenLabsAgent(input: {
    keyHash: string;
    model: string;
    personaHash: string;
  }): Promise<{ agentId: string; sealedToolSecret: string } | null> {
    this.ensureVoiceTables();
    const row = this.ctx.storage.sql
      .exec<{ agent_id: string; sealed_tool_secret: string }>(
        `SELECT agent_id, sealed_tool_secret FROM elevenlabs_call_agents
         WHERE key_hash = ?1 AND model = ?2 AND persona_hash = ?3 LIMIT 1`,
        input.keyHash,
        input.model,
        input.personaHash,
      )
      .toArray()[0];
    if (!row) return null;
    this.ctx.storage.sql.exec(
      `UPDATE elevenlabs_call_agents SET last_used_at = ?2 WHERE agent_id = ?1`,
      row.agent_id,
      Date.now(),
    );
    return { agentId: row.agent_id, sealedToolSecret: row.sealed_tool_secret };
  }

  async putElevenLabsAgent(input: {
    keyHash: string;
    model: string;
    personaHash: string;
    agentId: string;
    sealedToolSecret: string;
  }): Promise<{ agentId: string; sealedToolSecret: string }> {
    this.ensureVoiceTables();
    return this.ctx.storage.transactionSync(() => {
      const existing = this.ctx.storage.sql
        .exec<{ agent_id: string; sealed_tool_secret: string }>(
          `SELECT agent_id, sealed_tool_secret FROM elevenlabs_call_agents
           WHERE key_hash = ?1 AND model = ?2 AND persona_hash = ?3 LIMIT 1`,
          input.keyHash,
          input.model,
          input.personaHash,
        )
        .toArray()[0];
      if (existing) return { agentId: existing.agent_id, sealedToolSecret: existing.sealed_tool_secret };
      const now = Date.now();
      this.ctx.storage.sql.exec(
        `INSERT INTO elevenlabs_call_agents (agent_id, key_hash, model, persona_hash, sealed_tool_secret, created_at, last_used_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)`,
        input.agentId,
        input.keyHash,
        input.model,
        input.personaHash,
        input.sealedToolSecret,
        now,
      );
      return { agentId: input.agentId, sealedToolSecret: input.sealedToolSecret };
    });
  }

  async getElevenLabsAgentById(agentId: string): Promise<{ keyHash: string; sealedToolSecret: string } | null> {
    this.ensureVoiceTables();
    const row = this.ctx.storage.sql
      .exec<{ key_hash: string; sealed_tool_secret: string }>(
        `SELECT key_hash, sealed_tool_secret FROM elevenlabs_call_agents WHERE agent_id = ?1 LIMIT 1`,
        agentId,
      )
      .toArray()[0];
    return row ? { keyHash: row.key_hash, sealedToolSecret: row.sealed_tool_secret } : null;
  }

  async upsertElevenLabsConversation(input: {
    providerCall: string;
    callId: string;
    tenantId: string;
    state: string;
  }): Promise<void> {
    this.ensureVoiceTables();
    this.ctx.storage.sql.exec(
      `INSERT INTO elevenlabs_conversations (provider_call, call_id, tenant_id, state, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(provider_call) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`,
      input.providerCall,
      input.callId,
      input.tenantId,
      input.state,
      Date.now(),
    );
  }

  async findElevenLabsConversation(
    providerCall: string,
    liveOnly = false,
  ): Promise<{ callId: string; tenantId: string; state: string } | null> {
    this.ensureVoiceTables();
    const row = liveOnly
      ? this.ctx.storage.sql
          .exec<{ call_id: string; tenant_id: string; state: string }>(
            `SELECT call_id, tenant_id, state FROM elevenlabs_conversations WHERE provider_call = ?1 AND state = 'live' LIMIT 1`,
            providerCall,
          )
          .toArray()[0]
      : this.ctx.storage.sql
          .exec<{ call_id: string; tenant_id: string; state: string }>(
            `SELECT call_id, tenant_id, state FROM elevenlabs_conversations WHERE provider_call = ?1 LIMIT 1`,
            providerCall,
          )
          .toArray()[0];
    return row ? { callId: row.call_id, tenantId: row.tenant_id, state: row.state } : null;
  }

  // ---- 10. Console Accounts Directory (used on singleton TenantDO "__console_accounts__") ----

  private ensureConsoleAccountTables(): void {
    if (this.consoleAccountsSchemaReady) return;
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS console_accounts (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        email TEXT,
        login TEXT,
        name TEXT,
        password_hash TEXT,
        password_salt TEXT,
        sealed_console_key TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_console_accounts_email
        ON console_accounts(email) WHERE email IS NOT NULL;
      CREATE TABLE IF NOT EXISTS console_identities (
        identity_key TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_console_identities_account
        ON console_identities(account_id);
      CREATE TABLE IF NOT EXISTS ops_tenants (
        tenant_id TEXT PRIMARY KEY,
        name TEXT,
        kind TEXT NOT NULL DEFAULT 'self_serve',
        sign_in TEXT,
        email TEXT,
        login TEXT,
        signup_source_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    const opsCols = this.ctx.storage.sql.exec<{ name: string }>("PRAGMA table_info(ops_tenants)").toArray();
    if (!opsCols.some(({ name }) => name === "signup_source_json")) {
      this.ctx.storage.sql.exec("ALTER TABLE ops_tenants ADD COLUMN signup_source_json TEXT");
    }
    this.consoleAccountsSchemaReady = true;
  }

  private readConsoleAccountById(accountId: string): {
    id: string;
    tenantId: string;
    email: string | null;
    login: string | null;
    name: string | null;
    passwordHash: string | null;
    passwordSalt: string | null;
    sealedConsoleKey: string | null;
    createdAt: number;
    updatedAt: number;
  } | null {
    const row = this.ctx.storage.sql
      .exec<{
        id: string;
        tenant_id: string;
        email: string | null;
        login: string | null;
        name: string | null;
        password_hash: string | null;
        password_salt: string | null;
        sealed_console_key: string | null;
        created_at: number;
        updated_at: number;
      }>(`SELECT * FROM console_accounts WHERE id = ?1 LIMIT 1`, accountId)
      .toArray()[0];
    if (!row) return null;
    return {
      id: row.id,
      tenantId: row.tenant_id,
      email: row.email,
      login: row.login,
      name: row.name,
      passwordHash: row.password_hash,
      passwordSalt: row.password_salt,
      sealedConsoleKey: row.sealed_console_key,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  private findConsoleAccountByIdentityKeys(keys: string[]): ReturnType<TenantDO["readConsoleAccountById"]> {
    for (const key of keys) {
      if (!key) continue;
      const ident = this.ctx.storage.sql
        .exec<{ account_id: string }>(`SELECT account_id FROM console_identities WHERE identity_key = ?1 LIMIT 1`, key)
        .toArray()[0];
      if (ident) {
        const acct = this.readConsoleAccountById(ident.account_id);
        if (acct) return acct;
      }
    }
    return null;
  }

  async lookupConsoleAccount(input: {
    identityKeys: string[];
    email?: string | null;
  }): Promise<{
    id: string;
    tenantId: string;
    email: string | null;
    login: string | null;
    name: string | null;
    passwordHash: string | null;
    passwordSalt: string | null;
    sealedConsoleKey: string | null;
  } | null> {
    this.ensureConsoleAccountTables();
    const byIdent = this.findConsoleAccountByIdentityKeys(input.identityKeys);
    if (byIdent) return byIdent;
    if (input.email) {
      const row = this.ctx.storage.sql
        .exec<{ id: string }>(`SELECT id FROM console_accounts WHERE email = ?1 LIMIT 1`, input.email)
        .toArray()[0];
      if (row) return this.readConsoleAccountById(row.id);
    }
    return null;
  }

  async saveConsoleAccount(input: {
    accountId?: string;
    tenantId: string;
    identityKeys: string[];
    email?: string | null;
    login?: string | null;
    name?: string | null;
    passwordHash?: string | null;
    passwordSalt?: string | null;
    sealedConsoleKey?: string | null;
    requireNewEmail?: boolean;
  }): Promise<{
    id: string;
    tenantId: string;
    email: string | null;
    login: string | null;
    name: string | null;
    sealedConsoleKey: string | null;
    created: boolean;
  }> {
    this.ensureConsoleAccountTables();
    const now = Date.now();
    return this.ctx.storage.transactionSync(() => {
      let existing = input.accountId ? this.readConsoleAccountById(input.accountId) : null;
      if (!existing) {
        existing = this.findConsoleAccountByIdentityKeys(input.identityKeys);
      }
      if (!existing && input.email) {
        const row = this.ctx.storage.sql
          .exec<{ id: string }>(`SELECT id FROM console_accounts WHERE email = ?1 LIMIT 1`, input.email)
          .toArray()[0];
        if (row) existing = this.readConsoleAccountById(row.id);
      }

      if (input.requireNewEmail && existing) {
        throw new ApiError(409, "email_exists", "An account with this email already exists");
      }

      if (existing) {
        const nextEmail = existing.email ?? input.email ?? null;
        const nextLogin = input.login ?? existing.login ?? null;
        const nextName = input.name ?? existing.name ?? null;
        const nextPasswordHash = input.passwordHash ?? existing.passwordHash ?? null;
        const nextPasswordSalt = input.passwordSalt ?? existing.passwordSalt ?? null;
        const nextKey = input.sealedConsoleKey ?? existing.sealedConsoleKey ?? null;
        this.ctx.storage.sql.exec(
          `UPDATE console_accounts
           SET email = ?1, login = ?2, name = ?3, password_hash = ?4, password_salt = ?5,
               sealed_console_key = ?6, updated_at = ?7
           WHERE id = ?8`,
          nextEmail,
          nextLogin,
          nextName,
          nextPasswordHash,
          nextPasswordSalt,
          nextKey,
          now,
          existing.id,
        );
        for (const key of input.identityKeys) {
          if (!key) continue;
          this.ctx.storage.sql.exec(
            `INSERT INTO console_identities (identity_key, account_id, created_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(identity_key) DO UPDATE SET account_id = excluded.account_id`,
            key,
            existing.id,
            now,
          );
        }
        return {
          id: existing.id,
          tenantId: existing.tenantId,
          email: nextEmail,
          login: nextLogin,
          name: nextName,
          sealedConsoleKey: nextKey,
          created: false,
        };
      }

      const accountId = input.accountId || randomId("usr", 8);
      this.ctx.storage.sql.exec(
        `INSERT INTO console_accounts
          (id, tenant_id, email, login, name, password_hash, password_salt, sealed_console_key, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)`,
        accountId,
        input.tenantId,
        input.email ?? null,
        input.login ?? null,
        input.name ?? null,
        input.passwordHash ?? null,
        input.passwordSalt ?? null,
        input.sealedConsoleKey ?? null,
        now,
      );
      for (const key of input.identityKeys) {
        if (!key) continue;
        this.ctx.storage.sql.exec(
          `INSERT INTO console_identities (identity_key, account_id, created_at)
           VALUES (?1, ?2, ?3)
           ON CONFLICT(identity_key) DO UPDATE SET account_id = excluded.account_id`,
          key,
          accountId,
          now,
        );
      }
      return {
        id: accountId,
        tenantId: input.tenantId,
        email: input.email ?? null,
        login: input.login ?? null,
        name: input.name ?? null,
        sealedConsoleKey: input.sealedConsoleKey ?? null,
        created: true,
      };
    });
  }

  async linkConsoleAccountToTenant(input: {
    tenantId: string;
    identityKeys: string[];
    email?: string | null;
    login?: string | null;
    name?: string | null;
    sealedConsoleKey?: string | null;
  }): Promise<{ id: string; tenantId: string; linkedKeys: string[] }> {
    this.ensureConsoleAccountTables();
    const now = Date.now();
    const keys = [...new Set(input.identityKeys.filter(Boolean))];
    return this.ctx.storage.transactionSync(() => {
      const existing = this.ctx.storage.sql
        .exec<{ id: string; email: string | null; login: string | null; name: string | null; sealed_console_key: string | null }>(
          `SELECT id, email, login, name, sealed_console_key FROM console_accounts WHERE tenant_id = ?1 LIMIT 1`,
          input.tenantId,
        )
        .toArray()[0];

      let accountId: string;
      if (existing) {
        accountId = existing.id;
        this.ctx.storage.sql.exec(
          `UPDATE console_accounts
           SET email = COALESCE(?1, email), login = COALESCE(?2, login), name = COALESCE(?3, name),
               sealed_console_key = COALESCE(?4, sealed_console_key), updated_at = ?5
           WHERE id = ?6`,
          input.email ?? null,
          input.login ?? null,
          input.name ?? null,
          input.sealedConsoleKey ?? null,
          now,
          accountId,
        );
      } else {
        accountId = randomId("usr", 8);
        this.ctx.storage.sql.exec(
          `INSERT INTO console_accounts
            (id, tenant_id, email, login, name, password_hash, password_salt, sealed_console_key, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, NULL, NULL, ?6, ?7, ?7)`,
          accountId,
          input.tenantId,
          input.email ?? null,
          input.login ?? null,
          input.name ?? null,
          input.sealedConsoleKey ?? null,
          now,
        );
      }

      for (const key of keys) {
        this.ctx.storage.sql.exec(
          `INSERT INTO console_identities (identity_key, account_id, created_at)
           VALUES (?1, ?2, ?3)
           ON CONFLICT(identity_key) DO UPDATE SET account_id = excluded.account_id`,
          key,
          accountId,
          now,
        );
      }
      return { id: accountId, tenantId: input.tenantId, linkedKeys: keys };
    });
  }

  // ---- 11. Ops Registry & Per-Tenant Ops Snapshot ----

  async registerOpsTenant(input: {
    tenantId: string;
    name?: string | null;
    kind?: "self_serve" | "operator_made" | "operator";
    signIn?: "github" | "google" | "email" | null;
    email?: string | null;
    login?: string | null;
    signupSource?: { ref?: string; referrer?: string } | null;
    createdAt?: number;
  }): Promise<OpsRegisteredTenant> {
    this.ensureConsoleAccountTables();
    const now = Date.now();
    const tenantId = input.tenantId.trim();
    if (!tenantId) {
      throw new ApiError(400, "invalid_request", "`tenantId` is required");
    }
    const existing = this.ctx.storage.sql
      .exec<{
        tenant_id: string;
        name: string | null;
        kind: string;
        sign_in: string | null;
        email: string | null;
        login: string | null;
        signup_source_json: string | null;
        created_at: number;
      }>(`SELECT * FROM ops_tenants WHERE tenant_id = ?1 LIMIT 1`, tenantId)
      .toArray()[0];

    const kind: OpsRegisteredTenant["kind"] =
      input.kind ??
      (existing?.kind === "operator" || existing?.kind === "operator_made" || existing?.kind === "self_serve"
        ? existing.kind
        : input.signIn
          ? "self_serve"
          : "operator_made");
    const name = input.name !== undefined ? input.name : (existing?.name ?? null);
    const signIn = input.signIn !== undefined
      ? input.signIn
      : ((existing?.sign_in as OpsRegisteredTenant["signIn"]) ?? null);
    const email = input.email !== undefined ? input.email : (existing?.email ?? null);
    const login = input.login !== undefined ? input.login : (existing?.login ?? null);
    const signupSourceJson =
      existing?.signup_source_json ??
      (input.signupSource !== undefined && input.signupSource !== null ? JSON.stringify(input.signupSource) : null);
    const createdAt = existing
      ? Math.min(Number(existing.created_at), input.createdAt ?? Number(existing.created_at))
      : (input.createdAt ?? now);

    this.ctx.storage.sql.exec(
      `INSERT INTO ops_tenants (tenant_id, name, kind, sign_in, email, login, signup_source_json, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
       ON CONFLICT(tenant_id) DO UPDATE SET
         name = COALESCE(excluded.name, ops_tenants.name),
         kind = excluded.kind,
         sign_in = COALESCE(excluded.sign_in, ops_tenants.sign_in),
         email = COALESCE(excluded.email, ops_tenants.email),
         login = COALESCE(excluded.login, ops_tenants.login),
         signup_source_json = COALESCE(ops_tenants.signup_source_json, excluded.signup_source_json),
         created_at = MIN(ops_tenants.created_at, excluded.created_at),
         updated_at = excluded.updated_at`,
      tenantId,
      name,
      kind,
      signIn,
      email,
      login,
      signupSourceJson,
      createdAt,
      now,
    );

    let parsedSource: { ref?: string; referrer?: string } | null = null;
    if (signupSourceJson) {
      try {
        parsedSource = JSON.parse(signupSourceJson) as { ref?: string; referrer?: string };
      } catch {
        parsedSource = null;
      }
    }

    return {
      tenantId,
      name,
      kind,
      signIn,
      email,
      login,
      ...(parsedSource !== null ? { signupSource: parsedSource } : {}),
      createdAt,
      updatedAt: now,
    };
  }

  async listOpsTenants(): Promise<OpsRegisteredTenant[]> {
    this.ensureConsoleAccountTables();
    const byId = new Map<string, OpsRegisteredTenant>();

    const registered = this.ctx.storage.sql
      .exec<{
        tenant_id: string;
        name: string | null;
        kind: string;
        sign_in: string | null;
        email: string | null;
        login: string | null;
        signup_source_json: string | null;
        created_at: number;
        updated_at: number;
      }>(`SELECT * FROM ops_tenants ORDER BY created_at DESC`)
      .toArray();
    for (const row of registered) {
      const kind: OpsRegisteredTenant["kind"] =
        row.kind === "operator" || row.kind === "operator_made" ? row.kind : "self_serve";
      const signIn: OpsRegisteredTenant["signIn"] =
        row.sign_in === "github" || row.sign_in === "google" || row.sign_in === "email" ? row.sign_in : null;
      let signupSource: { ref?: string; referrer?: string } | null | undefined;
      if (row.signup_source_json) {
        try {
          signupSource = JSON.parse(row.signup_source_json) as { ref?: string; referrer?: string };
        } catch {
          signupSource = null;
        }
      }
      byId.set(row.tenant_id, {
        tenantId: row.tenant_id,
        name: row.name,
        kind,
        signIn,
        email: row.email,
        login: row.login,
        ...(signupSource !== undefined ? { signupSource } : {}),
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
      });
    }

    // Automatically include every console_accounts entry (including accounts created before ops_tenants existed)
    const consoleAccounts = this.ctx.storage.sql
      .exec<{
        id: string;
        tenant_id: string;
        email: string | null;
        login: string | null;
        name: string | null;
        password_hash: string | null;
        created_at: number;
        updated_at: number;
      }>(`SELECT id, tenant_id, email, login, name, password_hash, created_at, updated_at FROM console_accounts ORDER BY created_at DESC`)
      .toArray();
    const identRows = this.ctx.storage.sql
      .exec<{ account_id: string; identity_key: string }>(`SELECT account_id, identity_key FROM console_identities`)
      .toArray();
    const identByAccount = new Map<string, string[]>();
    for (const row of identRows) {
      const list = identByAccount.get(row.account_id) ?? [];
      list.push(row.identity_key);
      identByAccount.set(row.account_id, list);
    }

    for (const acct of consoleAccounts) {
      const keys = identByAccount.get(acct.id) ?? [];
      let inferredSignIn: OpsRegisteredTenant["signIn"] = null;
      if (keys.some((k) => k.startsWith("github:") || k.startsWith("github_login:"))) inferredSignIn = "github";
      else if (keys.some((k) => k.startsWith("google:"))) inferredSignIn = "google";
      else if (acct.password_hash || keys.some((k) => k.startsWith("email:"))) inferredSignIn = "email";

      const prev = byId.get(acct.tenant_id);
      if (prev) {
        byId.set(acct.tenant_id, {
          ...prev,
          name: prev.name ?? acct.name,
          signIn: prev.signIn ?? inferredSignIn,
          email: prev.email ?? acct.email,
          login: prev.login ?? acct.login,
          createdAt: Math.min(prev.createdAt, Number(acct.created_at)),
          updatedAt: Math.max(prev.updatedAt, Number(acct.updated_at)),
        });
      } else {
        byId.set(acct.tenant_id, {
          tenantId: acct.tenant_id,
          name: acct.name,
          kind: "self_serve",
          signIn: inferredSignIn,
          email: acct.email,
          login: acct.login,
          createdAt: Number(acct.created_at),
          updatedAt: Number(acct.updated_at),
        });
      }
    }

    return [...byId.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  async getOpsSnapshot(
    lookbackDays = 400,
    opts?: { currentFromMs?: number; currentUntilMs?: number; previousFromMs?: number },
  ): Promise<TenantOpsSnapshot | null> {
    const profile = this.readProfileOrNull();
    if (!profile) return null;
    const now = Date.now();
    this.pruneExpiredLeases(now);

    const activeRows = this.ctx.storage.sql
      .exec<{ agent_id: string }>(`SELECT DISTINCT agent_id FROM active_leases WHERE expires_at > ?1`, now)
      .toArray();
    const activeLeaseAgentIds = activeRows.map((r) => r.agent_id);
    const activeSet = new Set(activeLeaseAgentIds);

    const totalAgentsRow = this.ctx.storage.sql
      .exec<{ cnt: number }>(`SELECT COUNT(*) AS cnt FROM agents_index`)
      .one();
    const configuredModelRows = this.ctx.storage.sql
      .exec<{ model: string; cnt: number }>(
        `SELECT model, COUNT(*) AS cnt FROM agents_index GROUP BY model ORDER BY cnt DESC`,
      )
      .toArray();

    // Aggregate agent features across all live agents via features_json, definitions, and repo_id
    const defFeatureMap = new Map<string, string[]>();
    const defRows = this.ctx.storage.sql
      .exec<{ slug: string; config_json: string }>(`SELECT slug, config_json FROM definitions`)
      .toArray();
    for (const def of defRows) {
      try {
        const parsed = JSON.parse(def.config_json) as {
          builtins?: unknown;
          mcpServers?: unknown;
          tools?: unknown;
          repoId?: string | null;
        };
        defFeatureMap.set(def.slug, extractAgentFeatureKeys(parsed));
      } catch {
        // Ignore malformed definition JSON
      }
    }
    const featureGroups = this.ctx.storage.sql
      .exec<{
        features_json: string | null;
        definition_slug: string | null;
        has_repo: number;
        cnt: number;
      }>(
        `SELECT features_json, definition_slug, CASE WHEN repo_id IS NOT NULL THEN 1 ELSE 0 END AS has_repo, COUNT(*) AS cnt
         FROM agents_index
         GROUP BY features_json, definition_slug, has_repo`,
      )
      .toArray();
    const featureCounts: Record<string, number> = {};
    for (const group of featureGroups) {
      const keys = new Set<string>();
      if (group.features_json) {
        try {
          const parsed = JSON.parse(group.features_json) as unknown;
          if (Array.isArray(parsed)) {
            for (const item of parsed) {
              if (typeof item === "string" && item.trim()) keys.add(item.trim());
            }
          }
        } catch {
          // Ignore malformed features_json
        }
      } else if (group.definition_slug && defFeatureMap.has(group.definition_slug)) {
        for (const key of defFeatureMap.get(group.definition_slug)!) {
          keys.add(key);
        }
      }
      if (group.has_repo) keys.add("workspace");
      const cnt = Number(group.cnt ?? 0);
      for (const key of keys) {
        featureCounts[key] = (featureCounts[key] ?? 0) + cnt;
      }
    }

    const agentRows = this.ctx.storage.sql
      .exec<{
        id: string;
        agent_key: string;
        model: string;
        repo_id: string | null;
        branch: string;
        definition_slug: string | null;
        created_at: number;
        updated_at: number;
      }>(`SELECT id, agent_key, model, repo_id, branch, definition_slug, created_at, updated_at FROM agents_index ORDER BY updated_at DESC LIMIT 200`)
      .toArray();

    const clampedDays = Math.min(730, Math.max(1, Math.floor(lookbackDays)));
    const since = new Date(now - clampedDays * 86_400_000).toISOString().slice(0, 10);
    const usageRows = this.ctx.storage.sql
      .exec<{
        day: string;
        model: string;
        runs_count: number;
        own_key_runs: number;
        input_tokens: number;
        output_tokens: number;
        vm_ms: number;
        cost_usd: number;
      }>(`SELECT day, model, runs_count, own_key_runs, input_tokens, output_tokens, vm_ms, cost_usd FROM usage_daily WHERE day >= ?1 ORDER BY day DESC, model ASC`, since)
      .toArray();

    // Filter to funding/refund ledger rows so high-volume `usage` and reserve `grant` rows never crowd out topups/purchases/refunds
    const ledgerRows = this.ctx.storage.sql
      .exec<{
        id: string;
        ref_id: string;
        amount_usd: number;
        kind: string;
        note: string | null;
        created_at: number;
      }>(
        `SELECT id, ref_id, amount_usd, kind, note, created_at
         FROM credit_ledger
         WHERE kind IN ('topup', 'purchase', 'refund')
         ORDER BY created_at DESC
         LIMIT 500`,
      )
      .toArray();

    const ledgerAgg = this.ctx.storage.sql
      .exec<{
        kind: string;
        total: number;
        first_at: number | null;
      }>(`SELECT kind, COALESCE(SUM(amount_usd), 0) AS total, MIN(created_at) AS first_at FROM credit_ledger GROUP BY kind`)
      .toArray();

    let purchasedUsd = 0;
    let grantedUsd = 0;
    let refundedUsd = 0;
    let usageUsd = 0;
    let firstTopupAt: number | null = null;
    let earliestUsageAt: number | null = null;
    for (const row of ledgerAgg) {
      if (row.kind === "topup" || row.kind === "purchase") {
        if (Number(row.total) > 0) purchasedUsd += Number(row.total);
        if (row.first_at !== null) {
          firstTopupAt = firstTopupAt === null ? Number(row.first_at) : Math.min(firstTopupAt, Number(row.first_at));
        }
      } else if (row.kind === "grant") {
        grantedUsd += Number(row.total);
      } else if (row.kind === "refund") {
        refundedUsd += Math.abs(Number(row.total));
      } else if (row.kind === "usage") {
        usageUsd += Math.abs(Number(row.total));
        if (row.first_at !== null) {
          earliestUsageAt =
            earliestUsageAt === null ? Number(row.first_at) : Math.min(earliestUsageAt, Number(row.first_at));
        }
      }
    }

    // Per-agent response counts, active days, and distinct agents ran from credit_ledger (authoritative for all settled runs)
    const currentFromMs = opts?.currentFromMs ?? now - clampedDays * 86_400_000;
    const currentUntilMs = opts?.currentUntilMs ?? now + 86_400_000;
    const previousFromMs = opts?.previousFromMs ?? currentFromMs - (currentUntilMs - currentFromMs);

    const agentsRanCurrent = Number(
      this.ctx.storage.sql
        .exec<{ cnt: number }>(
          `SELECT COUNT(DISTINCT note) AS cnt
           FROM credit_ledger
           WHERE kind = 'usage' AND note LIKE 'Agent %(%)' AND created_at >= ?1 AND created_at < ?2`,
          currentFromMs,
          currentUntilMs,
        )
        .one().cnt ?? 0,
    );
    const agentsRanPrevious = Number(
      this.ctx.storage.sql
        .exec<{ cnt: number }>(
          `SELECT COUNT(DISTINCT note) AS cnt
           FROM credit_ledger
           WHERE kind = 'usage' AND note LIKE 'Agent %(%)' AND created_at >= ?1 AND created_at < ?2`,
          previousFromMs,
          currentFromMs,
        )
        .one().cnt ?? 0,
    );

    const curFromDay = new Date(currentFromMs).toISOString().slice(0, 10);
    const curUntilDay = new Date(Math.max(currentFromMs, currentUntilMs - 1)).toISOString().slice(0, 10);
    const prevFromDay = new Date(previousFromMs).toISOString().slice(0, 10);
    const endUsersCurrent = Number(
      this.ctx.storage.sql
        .exec<{ cnt: number }>(
          `SELECT COUNT(DISTINCT actor) AS cnt FROM agent_actors_daily WHERE day >= ?1 AND day <= ?2`,
          curFromDay,
          curUntilDay,
        )
        .one().cnt ?? 0,
    );
    const endUsersPrevious = Number(
      this.ctx.storage.sql
        .exec<{ cnt: number }>(
          `SELECT COUNT(DISTINCT actor) AS cnt FROM agent_actors_daily WHERE day >= ?1 AND day < ?2`,
          prevFromDay,
          curFromDay,
        )
        .one().cnt ?? 0,
    );

    const rawTopAgentUsage = this.ctx.storage.sql
      .exec<{
        note: string;
        responses: number;
        active_days: number;
        last_at: number;
      }>(
        `SELECT note,
                COUNT(*) AS responses,
                COUNT(DISTINCT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch')) AS active_days,
                MAX(created_at) AS last_at
         FROM credit_ledger
         WHERE kind = 'usage' AND note LIKE 'Agent %(%)' AND created_at >= ?1 AND created_at < ?2
         GROUP BY note
         ORDER BY responses DESC, last_at DESC
         LIMIT 50`,
        currentFromMs,
        currentUntilMs,
      )
      .toArray();

    const parsedTop = rawTopAgentUsage
      .map((row) => {
        const parsed = parseAgentUsageNote(row.note);
        if (!parsed) return null;
        return {
          agentId: parsed.agentId,
          agentKey: parsed.agentKey,
          responses: Number(row.responses),
          activeDays: Number(row.active_days),
          lastAt: Number(row.last_at),
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null);

    const liveModelById = new Map<string, { model: string; key: string }>();
    const actorsByAgentId = new Map<string, number>();
    if (parsedTop.length > 0) {
      const ids = parsedTop.map((item) => item.agentId);
      const placeholders = ids.map((_, idx) => `?${idx + 1}`).join(", ");
      const liveRows = this.ctx.storage.sql
        .exec<{ id: string; agent_key: string; model: string }>(
          `SELECT id, agent_key, model FROM agents_index WHERE id IN (${placeholders})`,
          ...ids,
        )
        .toArray();
      for (const r of liveRows) {
        liveModelById.set(r.id, { model: r.model, key: r.agent_key });
      }
      const actorRows = this.ctx.storage.sql
        .exec<{ agent_id: string; cnt: number }>(
          `SELECT agent_id, COUNT(DISTINCT actor) AS cnt
           FROM agent_actors_daily
           WHERE day >= ?1 AND day <= ?2 AND agent_id IN (${ids.map((_, idx) => `?${idx + 3}`).join(", ")})
           GROUP BY agent_id`,
          curFromDay,
          curUntilDay,
          ...ids,
        )
        .toArray();
      for (const r of actorRows) {
        actorsByAgentId.set(r.agent_id, Number(r.cnt));
      }
    }

    const topAgentUsage = parsedTop.map((item) => {
      const live = liveModelById.get(item.agentId);
      return {
        agentId: item.agentId,
        agentKey: live?.key ?? item.agentKey,
        model: live?.model ?? "",
        deleted: !live,
        responses: item.responses,
        activeDays: item.activeDays,
        lastAt: item.lastAt,
        endUsers: actorsByAgentId.get(item.agentId) ?? 0,
      };
    });

    const providerRows = this.ctx.storage.sql
      .exec<{ provider: string }>(`SELECT provider FROM provider_keys ORDER BY provider ASC`)
      .toArray();
    const channelRows = this.ctx.storage.sql
      .exec<{ kind: string; name: string }>(`SELECT kind, name FROM channels ORDER BY created_at DESC`)
      .toArray();

    const apiKeyCount = Number(this.ctx.storage.sql.exec<{ cnt: number }>(`SELECT COUNT(*) AS cnt FROM api_keys`).one().cnt ?? 0);
    const defCount = Number(this.ctx.storage.sql.exec<{ cnt: number }>(`SELECT COUNT(*) AS cnt FROM definitions`).one().cnt ?? 0);
    const repoCount = Number(this.ctx.storage.sql.exec<{ cnt: number }>(`SELECT COUNT(*) AS cnt FROM repos`).one().cnt ?? 0);
    const webhookCount = Number(this.ctx.storage.sql.exec<{ cnt: number }>(`SELECT COUNT(*) AS cnt FROM webhooks`).one().cnt ?? 0);

    return {
      profile,
      busyAgents: activeLeaseAgentIds.length,
      activeLeaseAgentIds,
      totalAgents: Number(totalAgentsRow.cnt ?? 0),
      configuredModels: configuredModelRows.map((r) => ({ model: r.model, count: Number(r.cnt) })),
      featureCounts,
      earliestUsageAt,
      agentsRanCurrent,
      agentsRanPrevious,
      endUsersCurrent,
      endUsersPrevious,
      topAgentUsage,
      agents: agentRows.map((r) => ({
        id: r.id,
        key: r.agent_key,
        model: r.model,
        repoId: r.repo_id,
        branch: r.branch,
        definition: r.definition_slug,
        running: activeSet.has(r.id),
        createdAt: Number(r.created_at),
        updatedAt: Number(r.updated_at),
      })),
      usageDaily: usageRows.map((u) => ({
        day: u.day,
        model: u.model,
        runsCount: Number(u.runs_count),
        ownKeyRuns: Number(u.own_key_runs ?? 0),
        inputTokens: Number(u.input_tokens),
        outputTokens: Number(u.output_tokens),
        vmMs: Number(u.vm_ms),
        costUsd: Number(u.cost_usd),
      })),
      ledger: ledgerRows.map((l) => ({
        id: l.id,
        refId: l.ref_id,
        amountUsd: Number(l.amount_usd),
        kind: l.kind,
        note: l.note,
        createdAt: Number(l.created_at),
      })),
      ledgerSummary: {
        purchasedUsd,
        grantedUsd,
        refundedUsd,
        usageUsd,
        firstTopupAt,
      },
      providers: providerRows.map((p) => p.provider),
      channels: channelRows.map((c) => ({ kind: c.kind, name: c.name })),
      counts: {
        apiKeys: apiKeyCount,
        definitions: defCount,
        repos: repoCount,
        webhooks: webhookCount,
        channels: channelRows.length,
      },
    };
  }

  async updateTenantLimits(input: {
    tier?: string;
    monthlyCapUsd?: number;
    concurrencyLimit?: number;
    rateLimitRpm?: number;
    name?: string;
  }): Promise<TenantProfile> {
    const profile = this.requireProfile();
    const nextTier = typeof input.tier === "string" && input.tier.trim() ? input.tier.trim().slice(0, 64) : profile.tier;
    const nextCap = input.monthlyCapUsd !== undefined && Number.isFinite(input.monthlyCapUsd) && input.monthlyCapUsd >= 0
      ? Number(input.monthlyCapUsd)
      : profile.monthlyCapUsd;
    const nextConcurrency = input.concurrencyLimit !== undefined && Number.isInteger(input.concurrencyLimit) && input.concurrencyLimit >= 1
      ? input.concurrencyLimit
      : profile.concurrencyLimit;
    const nextRpm = input.rateLimitRpm !== undefined && Number.isInteger(input.rateLimitRpm) && input.rateLimitRpm >= 1
      ? input.rateLimitRpm
      : profile.rateLimitRpm;
    const nextName = typeof input.name === "string" && input.name.trim() ? input.name.trim().slice(0, 120) : profile.name;

    this.ctx.storage.sql.exec(
      `UPDATE tenant_profile
       SET name = ?1, tier = ?2, monthly_cap_usd = ?3, concurrency_limit = ?4, rate_limit_rpm = ?5
       WHERE id = 1`,
      nextName,
      nextTier,
      nextCap,
      nextConcurrency,
      nextRpm,
    );
    return this.requireProfile();
  }
}

function parsePaginationCursor(cursor?: string): number {
  if (cursor === undefined || cursor === null || cursor === "") return 0;
  const trimmed = String(cursor).trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new ApiError(400, "invalid_cursor", `Invalid pagination cursor '${cursor}'`);
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ApiError(400, "invalid_cursor", `Invalid pagination cursor '${cursor}'`);
  }
  return parsed;
}
