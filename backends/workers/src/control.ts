import { applying, prepareApply } from "../../../shared/apply-scope.ts";
import { forgetAgentDreaming } from "../../../shared/dreaming.ts";
import { disableAgentTriggers } from "../../../src/triggers.ts";
import type { FileBindings } from "./files.ts";
import type { TenantAdmission } from "./tenant.ts";
import {
  ApiError,
  configuration,
  digest,
  type AgentConfiguration,
} from "./api-contract.ts";
import { authorized, boundedText } from "./validation.ts";
import {
  withSql,
  transaction,
  database,
  type PostgresEnv,
  type Sql,
} from "./postgres.ts";
import { postLedger, accrueUsage, BillingSpendable } from "./billing-sql.ts";
import { EndUserCredits, lastCallMin, lockEndUser, settleUsage, utcDay } from "./end-user-credits.ts";
import { CreditHolds } from "./credit-holds.ts";
import { keyServices, type KeyEnv } from "./security-services.ts";
import { defaultModelFor, validateAgentModel } from "./default-model.ts";
import { resolveAgentKey } from "./agent-key.ts";
import { prepareCreateAdmission } from "./admission.ts";
import { reserveAgentCreation } from "./agent-capacity.ts";
import type { RateLimitState } from "./admission.ts";
import { recordUsageDetails } from "../../../shared/usage-details.ts";
import { applyUsageRows } from "./accounts.ts";
import { applyWorkspaceUsage, Workspaces } from "./workspaces.ts";
import { activeCharge } from "../../../src/pricing.ts";
import { canonical } from "../../../shared/durable-json.ts";
import {
  enqueueEvents,
  webhookEvent,
  stableUuid,
  createEndpoint,
  publishPending,
  seal,
  unseal,
  type WebhookEnv,
} from "./webhooks.ts";

type AgentNamespace = {
  getByName(id: string): { fetch(request: Request): Promise<Response> };
};
export type ControlBindings = PostgresEnv & {
  TENANTS: DurableObjectNamespace<TenantAdmission>;
  WEBHOOKS?: Queue<{ id: string }>;
  METRICS?: AnalyticsEngineDataset;
  DEFAULT_TENANT?: string;
  TEST_MODE?: string;
};
export type ControlEnv = WebhookEnv & Omit<FileBindings,"HYPERDRIVE"> & {
  AGENTS: AgentNamespace;
  API_TOKEN: string;
  AGENT_PUBLIC_URL?: string;
  MODEL: string;
  DEFAULT_TENANT?: string;
  TEST_MODE?: string;
};
export type AuthContext = {
  tenantId: string;
  kind: "operator" | "api" | "console" | "oauth";
  scopes: string[];
  principal?: import('./accounts.ts').Principal;
};
export interface DirectoryEntry {
  id: string;
  tokenVersion?: string;
  tenantId: string;
  key: string | null;
  config: AgentConfiguration;
  resolvedModel?: import("@earendil-works/pi-ai").Model<import("@earendil-works/pi-ai").Api>;
  configHash: string;
  createdAt: number;
  expiresAt: number | null;
  revision: number;
  initialized: boolean;
  reconfigured?: Record<string, unknown>;
  deleted?: true;
  cleanupPending?: boolean;
  pendingFork?: { sourceId: string; fingerprint: string };
  parentAgentId?: string;
  parentRunId?: string;
  parentPlace?: import("./child-parent.ts").ChildPlace;
  /** A child's owner and its chain's root owner, stored when it was made (child-parent.ts). */
  owner?: import("../../../shared/owner.ts").Owner;
  rootOwner?: import("../../../shared/owner.ts").Owner;
  /** Returned for an upsert of an existing agent; never persisted in its header. */
  existingAgent?: true;
}
const creationRates = new WeakMap<DirectoryEntry, RateLimitState>();
export const creationRate = (entry: DirectoryEntry) => creationRates.get(entry);
export interface DirectoryFailure {
  failed: true;
  status: number;
  error: string;
  code: string;
}
export async function authenticate(
  request: Request,
  env: ControlEnv,
): Promise<AuthContext | null> {
  if (await authorized(request, env.API_TOKEN))
    return {
      tenantId: env.DEFAULT_TENANT ?? "camelrun-proto-local",
      kind: "operator",
      scopes: ["*"],
    };
  const token = request.headers
    .get("authorization")
    ?.match(/^Bearer (.+)$/)?.[1];
  if (!token || token.length > 512) return null;
  const hash = await digest(token);
  const result = await withSql(env, (sql) =>
    sql.query(
      "select a.tenant from api_tokens a join tenants t on t.id=a.tenant where a.sha256=$1",
      [hash],
    ),
  );
  return result.rows[0]
    ? { tenantId: result.rows[0].tenant, kind: "api", scopes: ["*"] }
    : null;
}

const mountIdentity = (mounts: AgentConfiguration['mounts']) => JSON.stringify((mounts ?? []).map(mount =>
  [mount.repo ?? mount.volumeId, mount.ref ?? "main", mount.path, mount.mode, mount.subpath ?? '/', mount.notify === true]));

export class Directory {
  private env: ControlEnv;
  private tenantId: string;
  constructor(env: ControlEnv, tenantId: string) {
    this.env = env;
    this.tenantId = tenantId;
  }
  async id(key: string) {
    return resolveAgentKey(this.env, this.tenantId, key);
  }
  async get(key: string): Promise<DirectoryEntry | null> {
    const id = await this.id(key);
    const { rows } = await withSql(this.env, (sql) =>
      sql.query(
        "select header, revoked from agents where id=$1 and tenant=$2",
        [id, this.tenantId],
      ),
    );
    return rows[0]
      ? this.applied({ ...rows[0].header, ...(rows[0].revoked ? { deleted: true } : {}) })
      : null;
  }
  /** The directory stages a replacement before the DO accepts it. Readers keep the applied configuration. */
  private async applied(entry: DirectoryEntry): Promise<DirectoryEntry> {
    if (applying() || entry.initialized || entry.deleted) return entry;
    const response = await this.env.AGENTS.getByName(entry.id).fetch(new Request("https://agent/configuration"));
    if (!response.ok) return entry;
    const current = await response.json() as Pick<DirectoryEntry, "id" | "tenantId" | "config" | "revision" | "expiresAt">;
    if (current.id !== entry.id || current.tenantId !== this.tenantId) return entry;
    return { ...entry, ...current, configHash: await digest(canonical(current.config)), initialized: true };
  }
  async list(): Promise<DirectoryEntry[]> {
    const { rows } = await withSql(this.env, (sql) =>
      sql.query(
        "select header from agents where tenant=$1 and not revoked and (expires_at is null or expires_at>$2) order by id limit 1000",
        [this.tenantId, Date.now()],
      ),
    );
    return Promise.all(rows.map((row) => this.applied(row.header)));
  }
  async upsert(
    input: unknown,
    suppliedKey?: string,
    runtimeOrigin?: string,
    pendingFork?: { sourceId: string; fingerprint: string },
    queueConfiguration = false,
    internalMounts?: AgentConfiguration["mounts"],
  ): Promise<DirectoryEntry | DirectoryFailure> {
    const fields = input && typeof input === "object" ? input as Record<string, unknown> : {};
    const defaultModel = fields.model === undefined
      ? await prepareApply(`default-model:${JSON.stringify([this.tenantId, fields.keyScope])}`, () => defaultModelFor(this.env, this.tenantId, typeof fields.keyScope === "string" ? fields.keyScope : undefined))
      : this.env.MODEL;
    const { config, ttlSeconds } = configuration(internalMounts ? {...fields,mounts:undefined} : input, defaultModel);
    const workspaces = new Workspaces(database(this.env));
    if (config.workspaceId !== undefined) await workspaces.validate(this.tenantId, config.workspaceId);
    const key =
      suppliedKey === undefined
        ? null
        : boundedText(suppliedKey, "Idempotency-Key", 80);
    const id = await this.id(key ?? crypto.randomUUID());
    const owner=(await withSql(this.env,sql=>sql.query('select tenant,revoked from agents where id=$1',[id]))).rows[0];
    if (owner && owner.tenant!==this.tenantId) throw new ApiError(403,'Agent belongs to another account','FORBIDDEN');
    if (owner?.revoked) throw new ApiError(410,'Agent is deleted','AGENT_GONE');
    const previousEntry = await this.get(id), previousConfig = previousEntry?.config;
    if (fields.metadata === undefined && previousConfig?.metadata !== undefined) config.metadata = previousConfig.metadata;
    if (fields.model === undefined && previousConfig?.model) config.model = previousConfig.model;
    if (fields.language === undefined && previousConfig?.language !== undefined) config.language = previousConfig.language;
    // An upsert that leaves its queue out keeps the one the agent has, as for its language.
    if (fields.queue === undefined && previousConfig?.queue !== undefined) config.queue = previousConfig.queue;
    if (fields.subject === undefined && previousConfig?.subject) config.subject = previousConfig.subject;
    const resolvedModel = await prepareApply(`agent-model:${JSON.stringify([this.tenantId, config, previousConfig?.model, previousEntry?.resolvedModel, fields.model === undefined])}`,
      () => validateAgentModel(this.env, this.tenantId, config, { reference: previousConfig?.model, model: previousEntry?.resolvedModel, defaultModel: fields.model === undefined }));
    // An agent whose first configuration never applied (initialized false: the apply failed) is still being
    // created: a retry applies it as a creation, since there is no configuration on the agent to queue a change on.
    if (applying() && previousEntry) {
      const mounts = fields.mounts === undefined ? previousEntry.config.mounts : await (await import("./repos/mounts.ts")).prepareMounts(this.env as import("./repos/registry.ts").RepoEnv, this.tenantId, id, fields.mounts);
      if (previousEntry.configHash !== await digest(canonical({ ...config, mounts })) || JSON.stringify(previousEntry.resolvedModel) !== JSON.stringify(resolvedModel)) throw new ApiError(409, "Atomic apply cannot reconfigure an existing agent; use its configuration endpoint");
      return previousEntry;
    }
    if (queueConfiguration && previousEntry?.initialized) {
      for (const field of ['subject', 'context', 'definition'] as const)
        if (canonical(config[field] ?? null) !== canonical(previousEntry.config[field] ?? null))
          throw new ApiError(409, `An agent's ${field} cannot change`);
      if (fields.mounts !== undefined && fields.remount !== true) {
        const mounts = await (await import('./repos/mounts.ts')).prepareMounts(this.env as import("./repos/registry.ts").RepoEnv, this.tenantId, id, fields.mounts);
        if (mountIdentity(mounts) !== mountIdentity(previousEntry.config.mounts))
          throw new ApiError(409, `An existing agent's mounts cannot change; delete it (DELETE /v1/agents/${id}) or use another idempotency key, or send remount: true to change its mounts`);
      }
      const target: Record<string, unknown> = { ...config };
      // Resolve omitted fields when this target reaches the head of the queue.
      if (fields.model === undefined) delete target.model;
      if (fields.language === undefined) delete target.language;
      if (fields.queue === undefined) delete target.queue;
      if (fields.metadata === undefined) delete target.metadata;
      const response = await this.env.AGENTS.getByName(id).fetch(new Request('https://agent/upsert', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: crypto.randomUUID(), method: 'configure', params: {
          ...target, ...(fields.remount !== undefined ? { remount: fields.remount } : {}),
        } }),
      }));
      const reconfigured = await response.json() as Record<string, unknown>;
      if (!response.ok) return { failed: true, status: response.status, error: String(reconfigured.error ?? 'Agent configuration was refused'), code: String(reconfigured.code ?? 'CONFIGURATION_FAILED') };
      const updated = reconfigured.state === 'completed' ? await this.get(id) : previousEntry;
      return { ...(updated ?? previousEntry), reconfigured };
    }
    const release = !applying() && config.type !== "run" && !previousEntry?.initialized
      ? await reserveAgentCreation(this.env as import("./agent.ts").Env, this.tenantId, id)
      : async () => {};
    let rate: RateLimitState | undefined;
    try {
    const requested=internalMounts ? undefined : (input as {mounts?:unknown;remount?:boolean}).mounts;
    const before = requested === undefined ? await this.get(id) : undefined;
    // Repo preparation uses SQL and DO calls. Keep those outside
    // the directory transaction; preserve the latest mounts under its lock.
    // TEMPORARY(volume-fork-mounts): removed by the workflows-on-branches PR
    config.mounts=internalMounts ?? (requested===undefined && before?.config.mounts ? before.config.mounts : await (await import('./repos/mounts.ts')).prepareMounts(this.env as import("./repos/registry.ts").RepoEnv,this.tenantId,id,requested));
    const admitCreate = config.type !== "run" ? await prepareApply(`create-admission:${this.tenantId}`, () => prepareCreateAdmission(this.env, this.tenantId)) : undefined;
    let createdHere = false;
    let priorMounts:AgentConfiguration["mounts"];
    let entry = await transaction(this.env, async (sql) => {
      // A transaction-scoped lock covers the absent row as well as concurrent creates.
      await sql.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
        id,
      ]);
      const previous = (
        await sql.query(
          "select tenant, header, revoked from agents where id=$1 for update",
          [id],
        )
      ).rows[0];
      if (previous && previous.tenant !== this.tenantId)
        throw new ApiError(403, "Agent belongs to another tenant", "FORBIDDEN");
      if (previous?.revoked)
        throw new ApiError(410, "Agent is deleted", "AGENT_GONE");
      const old = previous?.header as DirectoryEntry | undefined;
      priorMounts=old?.config.mounts;
      createdHere = !old;
      if (old && fields.subject !== undefined && fields.subject !== old.config.subject)
        throw new ApiError(409, "An agent's subject cannot change");
      if (old?.config.subject && fields.subject === undefined) config.subject = old.config.subject;
      if (old?.config.model && fields.model === undefined) config.model = old.config.model;
      if (!pendingFork && old?.pendingFork) throw new ApiError(409, "Fork is still being copied", "FORK_IN_PROGRESS");
      if (pendingFork && old && (old.pendingFork?.sourceId !== pendingFork.sourceId || old.pendingFork?.fingerprint !== pendingFork.fingerprint))
        throw new ApiError(409, "Key belongs to another agent", "FORK_CONFLICT");
      if (requested===undefined && old?.config.mounts) config.mounts=old.config.mounts;
      if(old?.config.mounts&&requested!==undefined&&mountIdentity(old.config.mounts)!==mountIdentity(config.mounts)&&(input as {remount?:boolean}).remount!==true)
        throw new ApiError(409,`An existing agent's mounts cannot change; delete it (DELETE /v1/agents/${id}) or use another idempotency key, or send remount: true to change its mounts`);
      if (fields.metadata === undefined && old?.config.metadata !== undefined) config.metadata = old.config.metadata;
      const configHash=await digest(canonical(config));
      const sameModel = JSON.stringify(old?.resolvedModel) === JSON.stringify(resolvedModel);
      if (admitCreate)
        rate = await admitCreate(sql, !(old?.initialized && old.configHash === configHash));
      if (old?.initialized && old.configHash === configHash && sameModel) return old;
      const next: DirectoryEntry = {
        id,
        tenantId: this.tenantId,
        key: old ? old.key : key,
        config,
        ...(resolvedModel ? { resolvedModel } : {}),
        configHash,
        createdAt: old?.createdAt ?? Date.now(),
        expiresAt:
          old?.expiresAt ??
          (ttlSeconds != null ? Date.now() + ttlSeconds * 1000 : ttlSeconds === null || key ? null : Date.now() + 86400_000),
        revision:
          old?.configHash === configHash && sameModel
            ? old.revision
            : (old?.revision ?? 0) + 1,
        initialized: false,
        ...(old?.tokenVersion ? { tokenVersion: old.tokenVersion } : {}),
        ...(old?.parentAgentId ? { parentAgentId: old.parentAgentId, parentRunId: old.parentRunId, ...(old.parentPlace ? { parentPlace: old.parentPlace } : {}), ...(old.owner ? { owner: old.owner } : {}), ...(old.rootOwner ? { rootOwner: old.rootOwner } : {}) } : {}),
        ...(pendingFork ? { pendingFork } : {}),
      };
      const written = await sql.query(
        `insert into agents(id,tenant,header,revision,name,type,model,expires_at) values($1,$2,$3,$4,$5,$6,$7,$8)
        on conflict(id) do update set header=excluded.header,revision=excluded.revision,name=excluded.name,type=excluded.type,model=excluded.model,expires_at=excluded.expires_at
        where agents.tenant=excluded.tenant returning id`,
        [
          id,
          this.tenantId,
          JSON.stringify({ ...next, initialized: old?.initialized ?? false }),
          next.revision,
          config.name ?? "",
          config.type ?? "agent",
          config.model ?? this.env.MODEL,
          next.expiresAt,
        ],
      );
      if (!written.rowCount)
        throw new ApiError(403, "Agent belongs to another tenant", "FORBIDDEN");
      return next;
    });
    if(!applying()) for(const mount of priorMounts??[]) {
      if(mount.repo&&mount.notify&&!entry.config.mounts?.some(next=>next.repo===mount.repo&&(next.ref??'main')===(mount.ref??'main')&&next.notify))
        await (await import('./repos/mounts.ts')).unwatchMount(this.env as import('./repos/registry.ts').RepoEnv,this.tenantId,id,mount as import('./repos/mounts.ts').Mount);
    }
    if (!entry.initialized && !applying()) {
      const initialized = await this.initialize(entry, runtimeOrigin);
      if ('failed' in initialized) return initialized;
      entry = initialized;
    }
    if (config.workspaceId !== undefined) await workspaces.assign(this.tenantId, "agent", id, config.workspaceId);
    else if (config.definition) {
      const inherited = await workspaces.current(this.tenantId, "definition", config.definition);
      if (inherited) await workspaces.assign(this.tenantId, "agent", id, inherited.workspace, true);
    }
    const result: DirectoryEntry = createdHere ? entry : { ...entry, existingAgent: true };
    if (rate) creationRates.set(result, rate);
    return result;
    } finally { await release(); }
  }
  /** Initialize exactly the committed revision, never a second upsert or a configuration request. */
  async initializeCommitted(entry: DirectoryEntry, runtimeOrigin?: string): Promise<DirectoryEntry | DirectoryFailure> {
    const row = (await withSql(this.env, sql => sql.query(
      "select header,revoked from agents where id=$1 and tenant=$2", [entry.id, this.tenantId]))).rows[0];
    const stored = row?.header as DirectoryEntry | undefined;
    if (!stored || row.revoked || stored.revision !== entry.revision || stored.configHash !== entry.configHash ||
        JSON.stringify(stored.resolvedModel) !== JSON.stringify(entry.resolvedModel))
      throw new ApiError(409, "A newer configuration or revocation won; retry");
    if (stored.initialized) return stored;
    return this.initialize(stored, runtimeOrigin);
  }
  private async initialize(entry: DirectoryEntry, runtimeOrigin?: string): Promise<DirectoryEntry | DirectoryFailure> {
    if (!entry.initialized) {
      const response = await this.env.AGENTS.getByName(entry.id).fetch(
        new Request("https://agent/configuration", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: entry.id,
            tenantId: this.tenantId,
            config:entry.config,
            resolvedModel:entry.resolvedModel,
            revision: entry.revision,
            expiresAt: entry.expiresAt,
            runtimeOrigin,
          }),
        }),
      ).catch(() => undefined);
      // The new revision is committed above (uninitialized): an agent that threw or failed applying it is a retry
      // away, as DELETE's cleanup is, so it answers 503 rather than a refusal. Another upsert applies it again.
      if (!response || response.status >= 500)
        return {
          failed: true,
          status: 503,
          error: "Agent configuration saved; applying it failed, retry",
          code: "CONFIGURATION_PENDING",
        };
      if (!response.ok) {
        const refused = await response.json() as { error?: string };
        return {
          failed: true,
          status: response.status,
          error: refused.error ?? "Agent configuration was refused",
          code: "CONFIGURATION_FAILED",
        };
      }
      entry.initialized = true;
      const applied = await withSql(this.env, (sql) =>
        sql.query(
          "update agents set header=jsonb_set(header::jsonb, '{initialized}', 'true'::jsonb)::json where id=$1 and tenant=$2 and revision=$3 and not revoked returning header",
          [entry.id, this.tenantId, entry.revision],
        ),
      );
      if (applied.rowCount) Object.assign(entry, applied.rows[0].header);
      if (!applied.rowCount) {
        const latest = await this.get(entry.id);
        if (latest?.initialized && latest.configHash === entry.configHash) return latest;
        return {
          failed: true,
          status: 409,
          error: "A newer configuration or revocation won; retry",
          code: "CONFIGURATION_CHANGED",
        };
      }
    }
    return entry;
  }
  async remove(id: string): Promise<boolean | DirectoryFailure> {
    const entry = await this.get(id);
    if (!entry || (entry.deleted && !entry.cleanupPending)) return false;
    await withSql(this.env, sql => sql.query('update agent_members set removed_at=coalesce(removed_at,$2), revision=revision+1 where agent=$1', [entry.id, Date.now()]));
    entry.deleted = true;
    entry.cleanupPending = true;
    await withSql(this.env, (sql) =>
      sql.query(
        "update agents set revoked=true,header=$3 where id=$1 and tenant=$2",
        [entry.id, this.tenantId, JSON.stringify(entry)],
      ),
    );
    // The agent is revoked from here on: a shutdown that threw (an object reset while starting) is cleanup still
    // pending, as one that answered an error is, not a failed deletion. Another DELETE finishes it.
    const response = await this.env.AGENTS.getByName(entry.id).fetch(
      new Request("https://agent/", { method: "DELETE" }),
    ).catch(() => undefined);
    if (!response?.ok)
      return {
        failed: true,
        status: 503,
        error: "Agent revoked; cleanup pending",
        code: "CLEANUP_PENDING",
      };
    await (await import('./repos/mounts.ts')).releaseAgentFiles(this.env as import("./repos/registry.ts").RepoEnv,this.tenantId,entry.id,(entry.config.mounts??[]) as import("./files.ts").Mount[]);
    entry.cleanupPending = false;
    entry.config = {};
    entry.configHash = "";
    entry.key = null;
    await withSql(this.env, async (sql) => {
      // As Node's purge: its dreaming job goes, and its triggers stay but are disabled (a hook to one answers 202 and
      // runs nothing, so a sender like Stripe stops instead of retrying a 404).
      await forgetAgentDreaming((text, values) => sql.query(text, values), entry.id);
      await disableAgentTriggers(sql, entry.id);
      await sql.query(
        "update agents set header=$3,purged_at=$4 where id=$1 and tenant=$2",
        [entry.id, this.tenantId, JSON.stringify(entry), Date.now()],
      );
    });
    return true;
  }
}

async function lockAccount(sql: Sql, tenantId: string) {
  const row = (
    await sql.query(
      "select a.balance,a.purchased from credit_accounts a where a.tenant=$1 for update of a",
      [tenantId],
    )
  ).rows[0];
  if (!row) throw new ApiError(404, "Account not found", "ACCOUNT_NOT_FOUND");
  return row;
}
async function verifyAgent(sql: Sql, tenantId: string, agentId: string) {
  const row = (
    await sql.query("select revoked from agents where id=$1 and tenant=$2", [
      agentId,
      tenantId,
    ])
  ).rows[0];
  if (!row || row.revoked)
    throw new ApiError(403, "Agent unavailable", "AGENT_GONE");
}
export async function reserveTurn(
  env: KeyEnv, tenantId: string, agentId: string, requestId: string,
  reserveMicros = 0, min = lastCallMin(reserveMicros),
): Promise<{ held: number }> {
  if (!Number.isSafeInteger(reserveMicros) || reserveMicros < 0) throw new ApiError(400, "Invalid reservation");
  const id = await stableUuid(`turn:${tenantId}:${agentId}:${requestId}`);
  await withSql(env, sql => verifyAgent(sql, tenantId, agentId));
  const { accounts: { billing } } = await keyServices(env);
  if (!reserveMicros || await billing.mode(tenantId) === "none") return { held: 0 };
  const hold = await new CreditHolds(database(env), billing).reserve(tenantId, id, reserveMicros, min);
  if (!hold) throw new ApiError(402, "Insufficient credit or hourly allowance", "INSUFFICIENT_CREDIT");
  return { held: hold.held };
}
export type TurnReceipt = {
  tenantId: string;
  agentId: string;
  requestId: string;
  costMicros: number;
  inputTokens?: number;
  outputTokens?: number;
  model?: string;
  faultAfterCommit?: boolean;
  modelMetered?: boolean;
  activeMs?: number;
  startedAt?: number;
  responses?: number;
  subject?: string;
  bucket?: string;
};
export async function settleTurn(
  env: KeyEnv & {
    TEST_MODE?: string;
    WEBHOOKS?: Queue<{ id: string }>;
    METRICS?: AnalyticsEngineDataset;
  },
  receipt: TurnReceipt,
): Promise<{ duplicate: boolean }> {
  if (
    !Number.isSafeInteger(receipt.costMicros) ||
    receipt.costMicros < 0 ||
    ![receipt.inputTokens ?? 0, receipt.outputTokens ?? 0, receipt.responses ?? 1, receipt.activeMs ?? 0, receipt.startedAt ?? 0].every(
      (n) => Number.isSafeInteger(n) && n >= 0,
    ) || (receipt.modelMetered !== undefined && typeof receipt.modelMetered !== "boolean")
  )
    throw new ApiError(400, "Invalid charge");
  const { faultAfterCommit } = receipt;
  const fingerprint = await digest(
    JSON.stringify([
      receipt.tenantId,
      receipt.agentId,
      receipt.requestId,
      receipt.costMicros,
      receipt.inputTokens ?? 0,
      receipt.outputTokens ?? 0,
      receipt.model ?? "local/fake", receipt.modelMetered, receipt.activeMs, receipt.startedAt, receipt.subject, receipt.bucket, receipt.responses ?? 1,
    ]),
  );
  const id = await stableUuid(
      `turn:${receipt.tenantId}:${receipt.agentId}:${receipt.requestId}`,
    ),
    key = `workers:receipt:${id}`;
  const { accounts: { billing } } = await keyServices(env);
  const prepaid = await billing.mode(receipt.tenantId) === "prepaid";
  const result = await transaction(env, async (sql) => {
    // Admin tenants can run on their own keys without a prepaid account row.
    // Serialize all of their receipts too, without manufacturing a credit balance.
    await sql.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [`turn-receipts:${receipt.tenantId}`]);
    // End user, then balance, then the rows under them: model settlement (model-attempts.ts) takes the same order.
    const endUser = receipt.subject && !receipt.modelMetered
      ? { sql, user: await lockEndUser(sql, receipt.tenantId, receipt.subject) } : undefined;
    if (prepaid) await lockAccount(sql, receipt.tenantId);
    const prior = (
      await sql.query(
        "select fingerprint from idempotency_keys where tenant=$1 and key=$2",
        [receipt.tenantId, key],
      )
    ).rows[0];
    if (prior) {
      if (prior.fingerprint !== fingerprint)
        throw new ApiError(409, "Receipt changed", "IDEMPOTENCY_CONFLICT");
      return { duplicate: true };
    }
    // A receipt may arrive after its hold expires or after a lost acknowledgement.
    // src/ permits a running response's bounded overdraft; expiry never drops its charge.
    const charged = receipt.modelMetered ? activeCharge(billing.pricing, receipt.activeMs ?? 0) : receipt.costMicros;
    if (charged > 0 && prepaid) await accrueUsage(sql, [{ tenant: receipt.tenantId, amount: charged,
      metadata: receipt.modelMetered ? { tokens: 0, activeMs: receipt.activeMs ?? 0 } : { responses: receipt.responses ?? 1, inputTokens: receipt.inputTokens ?? 0, outputTokens: receipt.outputTokens ?? 0 } }]);
    if (!receipt.modelMetered) {
      const totals = { tenant: receipt.tenantId, day: utcDay(receipt.startedAt ?? Date.now()), model: receipt.model ?? "local/fake",
        responses: receipt.responses ?? 1, input: receipt.inputTokens ?? 0, output: receipt.outputTokens ?? 0, cacheRead: 0, cacheWrite: 0,
        cost: receipt.costMicros / 1_000_000, platformResponses: receipt.responses ?? 1, platformCost: receipt.costMicros / 1_000_000 };
      await applyUsageRows(sql, [totals]);
      await recordUsageDetails(sql, [{ ...totals, agent: receipt.agentId, endUser: receipt.subject ?? null, bucket: receipt.bucket ?? null, timestamp: receipt.startedAt ?? Date.now() }]);
      await applyWorkspaceUsage(sql, [{ ...totals, agent: receipt.agentId, timestamp: receipt.startedAt ?? Date.now() }]);
      if (receipt.subject) await settleUsage(sql, { tenant: receipt.tenantId, endUser: receipt.subject, bucket: receipt.bucket ?? "default",
        day: totals.day, raw: receipt.costMicros, key, metadata: { requestId: receipt.requestId, agent: receipt.agentId } }, Date.now(), endUser);
    }
    await sql.query("insert into usage_flushes(id) values($1)", [id]);
    await sql.query(
      "insert into idempotency_keys(tenant,key,fingerprint,status,body,content_type,created_at) values($1,$2,$3,200,$4,'application/json',$5)",
      [
        receipt.tenantId,
        key,
        fingerprint,
        JSON.stringify({ duplicate: false }),
        Date.now(),
      ],
    );
    await sql.query("delete from credit_holds where id=$1 and tenant=$2", [
      id,
      receipt.tenantId,
    ]);
    if (!receipt.modelMetered) await enqueueEvents(sql, [
      webhookEvent(
        "usage.recorded",
        receipt.tenantId,
        {
          agentId: receipt.agentId,
          requestId: receipt.requestId,
          costMicros: receipt.costMicros,
        },
        id,
      ),
    ]);
    return { duplicate: false };
  });
  if (faultAfterCommit && env.TEST_MODE === "1")
    throw new Error("injected lost PG acknowledgement");
  if (env.WEBHOOKS) await publishPending(env as WebhookEnv);
  env.METRICS?.writeDataPoint({
    blobs: [receipt.tenantId, receipt.agentId, receipt.model ?? "local/fake"],
    doubles: [receipt.costMicros],
    indexes: [receipt.tenantId],
  });
  return result;
}
export async function releaseTurn(
  env: PostgresEnv,
  tenantId: string,
  agentId: string,
  requestId: string,
): Promise<void> {
  const id = await stableUuid(`turn:${tenantId}:${agentId}:${requestId}`);
  await withSql(env, (sql) =>
    sql.query("delete from credit_holds where id=$1 and tenant=$2", [
      id,
      tenantId,
    ]),
  );
}

/** Team accounts transfer existing credit in one transaction with ordered row locks. */
export async function transfer(
  env: PostgresEnv,
  from: string,
  to: string,
  amount: number,
  key: string,
) {
  if (
    from === to ||
    !Number.isSafeInteger(amount) ||
    amount <= 0 ||
    !key ||
    key.length > 160
  )
    throw new ApiError(400, "Invalid transfer");
  const fingerprint = await digest(JSON.stringify([from, to, amount]));
  return transaction(env, async (sql) => {
    for (const tenant of [from, to].sort()) await lockAccount(sql, tenant);
    const previous = (
      await sql.query(
        "select fingerprint from idempotency_keys where tenant=$1 and key=$2",
        [from, `transfer:${key}`],
      )
    ).rows[0];
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new ApiError(409, "Transfer changed", "IDEMPOTENCY_CONFLICT");
      return { transferred: amount, replayed: true };
    }
    const held = Number(
      (
        await sql.query(
          "select coalesce(sum(amount),0) held from credit_holds where tenant=$1 and expires_at > $2",
          [from, Date.now()],
        )
      ).rows[0].held,
    );
    const balance = Number(
      (
        await sql.query("select balance from credit_accounts where tenant=$1", [
          from,
        ])
      ).rows[0].balance,
    );
    if (balance - held < amount)
      throw new ApiError(
        402,
        "Insufficient unreserved credit",
        "INSUFFICIENT_CREDIT",
      );
    await postLedger(sql, [
      {
        tenant: from,
        kind: "adjustment",
        amount: -amount,
        key: `transfer:${from}:${key}:out`,
        metadata: { to },
      },
      {
        tenant: to,
        kind: "adjustment",
        amount,
        key: `transfer:${from}:${key}:in`,
        metadata: { from },
      },
    ]);
    await sql.query(
      "insert into idempotency_keys(tenant,key,fingerprint,status,body,created_at) values($1,$2,$3,200,'{}',$4)",
      [from, `transfer:${key}`, fingerprint, Date.now()],
    );
    return { transferred: amount, replayed: false };
  });
}

export async function controlRoutes(
  request: Request,
  env: ControlEnv,
  auth: AuthContext,
): Promise<Response | null> {
  const url = new URL(request.url),
    path = url.pathname,
    tenant = auth.tenantId;
  const json = (value: unknown, status = 200) =>
    Response.json(value, { status });
  const input = async () => (await request.json()) as Record<string, unknown>;
  if (path === "/v1/api-keys" || path === "/v1/tokens") {
    if (request.method === "GET")
      return json(
        (
          await withSql(env, (sql) =>
            sql.query(
              'select id,name,prefix,created_at as "createdAt" from api_tokens where tenant=$1 order by created_at',
              [tenant],
            ),
          )
        ).rows,
      );
    if (request.method === "POST") {
      const body = await input(),
        name = body.name;
      if (typeof name !== "string" || !name.trim() || name.length > 80)
        throw new ApiError(400, "name must contain 1–80 characters");
      const token = `art_${Array.from(crypto.getRandomValues(new Uint8Array(32)), (x) => x.toString(16).padStart(2, "0")).join("")}`,
        hash = await digest(token),
        id = crypto.randomUUID(),
        createdAt = Date.now();
      await transaction(env, async (sql) => {
        await lockAccount(sql, tenant);
        const count = Number(
          (
            await sql.query(
              "select count(*) count from api_tokens where tenant=$1",
              [tenant],
            )
          ).rows[0].count,
        );
        if (count >= 50) throw new ApiError(409, "At most 50 API keys");
        await sql.query(
          "insert into api_tokens(sha256,id,tenant,name,prefix,created_at) values($1,$2,$3,$4,$5,$6)",
          [hash, id, tenant, name.trim(), token.slice(0, 8), createdAt],
        );
      });
      return json(
        { id, token, name: name.trim(), prefix: token.slice(0, 8), createdAt },
        201,
      );
    }
  }
  const tokenMatch = /^\/v1\/(?:api-keys|tokens)\/([^/]+)$/.exec(path);
  if (tokenMatch && request.method === "DELETE")
    return json({
      deleted: !!(
        await withSql(env, (sql) =>
          sql.query("delete from api_tokens where tenant=$1 and id::text=$2", [
            tenant,
            tokenMatch[1],
          ]),
        )
      ).rowCount,
    });
  if (
    path === "/v1/account" ||
    path === "/v1/credits" ||
    path === "/v1/billing"
  )
    return json(
      (
        await withSql(env, (sql) =>
          sql.query(
            "select t.id,t.billing,t.limits,a.balance,a.purchased,(select coalesce(sum(amount),0) from credit_holds h where h.tenant=t.id) as held from tenants t join credit_accounts a on a.tenant=t.id where t.id=$1",
            [tenant],
          ),
        )
      ).rows[0],
    );
  if (path === "/v1/credits/ledger")
    return json(
      (
        await withSql(env, (sql) =>
          sql.query(
            "select id,kind,amount,metadata,created_at from credit_ledger where tenant=$1 order by id desc limit 100",
            [tenant],
          ),
        )
      ).rows,
    );
  if (path === "/v1/credits/holds")
    return json(
      (
        await withSql(env, (sql) =>
          sql.query(
            "select id,amount,expires_at from credit_holds where tenant=$1 order by created_at",
            [tenant],
          ),
        )
      ).rows,
    );
  if (path === "/v1/credits/transfer" && request.method === "POST") {
    if (auth.kind !== "operator")
      throw new ApiError(403, "Team account operator required", "FORBIDDEN");
    const body = await input();
    return json(
      await transfer(
        env,
        tenant,
        String(body.to ?? ""),
        Number(body.amount),
        String(body.key ?? request.headers.get("Idempotency-Key") ?? ""),
      ),
    );
  }
  if (path === "/v1/usage")
    return json(
      (
        await withSql(env, (sql) =>
          sql.query(
            "select * from usage where tenant=$1 order by day desc limit 100",
            [tenant],
          ),
        )
      ).rows,
    );
  if (path === "/v1/webhooks") {
    if (request.method === "POST")
      return json(await createEndpoint(env, tenant, await input()), 201);
    if (request.method === "GET")
      return json(
        (
          await withSql(env, (sql) =>
            sql.query(
              "select id,url,events,description,created_at from webhook_endpoints where tenant=$1",
              [tenant],
            ),
          )
        ).rows,
      );
  }
  if (path === "/v1/webhooks/deliveries")
    return json(
      (
        await withSql(env, (sql) =>
          sql.query(
            "select id,endpoint,attempts,due,last_error from webhook_deliveries where tenant=$1",
            [tenant],
          ),
        )
      ).rows,
    );
  const webhookMatch = /^\/v1\/webhooks\/([^/]+)$/.exec(path);
  if (webhookMatch && request.method === "DELETE")
    return json({
      deleted: !!(
        await withSql(env, (sql) =>
          sql.query("delete from webhook_endpoints where id=$1 and tenant=$2", [
            webhookMatch[1],
            tenant,
          ]),
        )
      ).rowCount,
    });
  if (path === "/v1/tenants" && auth.kind === "operator") {
    if (request.method === "GET")
      return json(
        (
          await withSql(env, (sql) =>
            sql.query(
              "select id,billing,created_at from tenants order by id limit 100",
            ),
          )
        ).rows,
      );
    if (request.method === "POST") {
      const body = await input();
      if (
        typeof body.id !== "string" ||
        !/^camelrun-proto-[a-z0-9-]{1,40}$/.test(body.id)
      )
        throw new ApiError(
          400,
          "Experiment tenant id must begin camelrun-proto-",
        );
      await transaction(env, async (sql) => {
        await sql.query(
          "insert into tenants(id,created_at,billing) values($1,$2,'prepaid') on conflict(id) do nothing",
          [body.id, Date.now()],
        );
        await sql.query(
          "insert into credit_accounts(tenant) values($1) on conflict do nothing",
          [body.id],
        );
      });
      return json({ id: body.id }, 201);
    }
  }
  if (path === "/v1/account/email" && request.method === "POST") {
    if (env.TEST_MODE !== "1" && (!env.MAIL || !env.ACCOUNT_EMAIL_FROM))
      throw new ApiError(
        501,
        "Account mail transport is not configured",
        "UNSUPPORTED_FEATURE",
      );
    const body = await input(),
      email = String(body.email ?? "")
        .trim()
        .toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254)
      throw new ApiError(400, "Invalid email");
    const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (x) =>
        x.toString(16).padStart(2, "0"),
      ).join(""),
      hash = await digest(token),
      id = crypto.randomUUID(),
      now = Date.now();
    const envelope = await seal(
      JSON.stringify({ email, token, purpose: "verify_account_email" }),
      env,
    );
    await transaction(env, async (sql) => {
      await lockAccount(sql, tenant);
      await sql.query(
        "delete from account_email_links where tenant=$1 and purpose='add'",
        [tenant],
      );
      await sql.query(
        "insert into account_email_links(sha256,purpose,email,tenant,hash,created_at,expires_at) values($1,'add',$2,$3,'mailbox-verification-only',$4,$5)",
        [hash, email, tenant, now, now + 3600000],
      );
      await sql.query(
        "insert into billing_recipients(id,tenant,email,confirmation_hash,confirmation_expires,created_at) values($1,$2,$3,$4,$5,$6) on conflict(tenant,email) do update set status='pending',confirmation_hash=excluded.confirmation_hash,confirmation_expires=excluded.confirmation_expires",
        [id, tenant, email, hash, now + 3600000, now],
      );
      await sql.query(
        "insert into idempotency_keys(tenant,key,fingerprint,status,body,created_at) values($1,$2,$3,102,$4,$5)",
        [tenant, `workers:email:${id}`, hash, JSON.stringify(envelope), now],
      );
    });
    await env.WEBHOOKS?.send({ id, kind: "email" });
    return json({ sent: true });
  }
  if (path === "/v1/account/email/verify" && request.method === "POST") {
    const hash = await digest(String((await input()).token ?? ""));
    await transaction(env, async (sql) => {
      const row = (
        await sql.query(
          "delete from account_email_links where sha256=$1 and tenant=$2 and purpose='add' and expires_at>$3 returning email",
          [hash, tenant, Date.now()],
        )
      ).rows[0];
      if (!row)
        throw new ApiError(400, "Link expired or already used", "LINK_GONE");
      await sql.query(
        "update billing_recipients set status='verified' where tenant=$1 and email=$2 and confirmation_hash=$3",
        [tenant, row.email, hash],
      );
    });
    return json({ verified: true });
  }
  if (
    path === "/experimental/account-emails" &&
    env.TEST_MODE === "1" &&
    auth.kind === "operator"
  ) {
    const rows = (
      await withSql(env, (sql) =>
        sql.query(
          "select body,status from idempotency_keys where tenant=$1 and key like 'workers:email:%' order by created_at",
          [tenant],
        ),
      )
    ).rows;
    return json(
      await Promise.all(
        rows.map(async (row) => ({
          ...JSON.parse(await unseal(JSON.parse(row.body), env)),
          delivered: row.status === 200,
        })),
      ),
    );
  }
  if (path === "/v1/admin/summary" && auth.kind === "operator")
    return json(
      (
        await withSql(env, (sql) =>
          sql.query(
            "select (select count(*) from tenants) tenants,(select count(*) from agents where not revoked) agents,(select sum(balance) from credit_accounts) balance,(select count(*) from credit_holds) holds",
          ),
        )
      ).rows[0],
    );
  return null;
}

export async function maintenance(env: ControlEnv) {
  await new EndUserCredits(database(env)).expireDue(100);
  await withSql(env, (sql) =>
    sql.query("delete from account_email_links where expires_at < $1", [
      Date.now(),
    ]),
  );
  return publishPending(env);
}
