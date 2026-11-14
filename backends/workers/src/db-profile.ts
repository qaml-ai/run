import { AsyncLocalStorage } from "node:async_hooks";

export type DbPhase = "admission" | "hold" | "renew" | "settle" | "usage" | "webhooks" | "history" | "other" | "edge";
type StatementMeasures = { queries: number; queryMs: number; errors: number };
type Measures = { statements: Record<string, StatementMeasures>; queries: number; queryMs: number; errors: number; connections: number; connectMs: number; transactions: number; transactionMs: number; transactionMaxMs: number; transactionSamplesMs: number[] };
export type DbProfileSnapshot = { phases: Partial<Record<DbPhase, Measures>>; operations: Partial<Record<DbPhase, number>> };
const context = new AsyncLocalStorage<{ profile: DbProfile; phase: DbPhase }>();
const fresh = (): Measures => ({ statements: {}, queries: 0, queryMs: 0, errors: 0, connections: 0, connectMs: 0, transactions: 0, transactionMs: 0, transactionMaxMs: 0, transactionSamplesMs: [] });

// Static schema names only: neither input text, parameters nor identifiers from
// requests become diagnostic labels. Unknown statements share one bucket.
const PROFILE_TABLES = new Set(["account_deletions", "account_email_links", "actor_owners", "admin_github_bindings", "agent_children", "agent_history_chunks", "agent_history_index", "agent_inputs", "agent_spend_limits", "agent_wakes", "agents", "api_tokens", "billing_alert_settings", "billing_auto_attempts", "billing_auto_quotes", "billing_auto_settings", "billing_checkout_cutover", "billing_checkouts", "billing_confirmation_limits", "billing_disputes", "billing_email_outbox", "billing_email_suppressions", "billing_events", "billing_jobs", "billing_recipients", "billing_stripe_customers", "billing_stripe_refunds", "busy_agents", "card_checks", "channel_agents", "channel_conversations", "channel_counts", "channel_items", "channel_seen", "channels", "chunk_pins", "chunk_touches", "computer_blocks", "computer_commands", "computer_connections", "computer_leases", "computer_operations", "computer_transfers", "console_sessions", "credit_accounts", "credit_ledger", "credit_spend_minutes", "definitions", "discord_account_links", "discord_installations", "discord_server_bindings", "discord_setup_attempts", "discord_setup_cooldowns", "elevenlabs_voices", "email_messages", "email_threads", "end_user_days", "end_user_ledger", "end_user_lots", "end_user_settings", "end_users", "gc_candidates", "help_requests", "idempotency_keys", "journey_accounts", "journey_lost_signups", "journey_milestones", "journey_outbox", "journey_state", "key_scope_providers", "log_records", "managed_computers", "memory_retirement_guard", "model_attempts", "model_providers", "oauth_grants", "oauth_tokens", "pi_durable_conversations", "pi_durable_document_revisions", "pi_durable_documents", "pi_durable_entries", "pi_durable_metadata", "pi_durable_record_ids", "pi_durable_submissions", "pi_durable_tasks", "pi_sweep", "pi_usage_receipts", "provider_keys", "rate_limits", "runtime_nodes", "schedule_runs", "schedule_deliveries", "schedules", "signing_keys", "starting_credit_decisions", "storage_gc", "storage_usage", "telemetry_exporters", "tenant_cors_origins", "tenant_passwords", "tenants", "usage", "usage_flushes", "usage_webhook_outbox", "usage_webhooks", "voice_recordings", "voice_sessions", "volume_snapshots", "volume_watchers", "volumes", "webhook_deliveries", "webhook_endpoints", "workspace_assignments", "workspace_usage", "workspaces"]);
export function statementCategory(text: string): string {
  const action = /^\s*(select|insert|update|delete|with|begin|commit|rollback|set)\b/i.exec(text)?.[1]?.toLowerCase() ?? "other";
  const tables = [...new Set((text.match(/\b[a-z_][a-z_0-9]*\b/gi) ?? []).map(word => word.toLowerCase()).filter(word => PROFILE_TABLES.has(word)))].sort();
  return `${action}:${tables.slice(0, 16).join("+") || "other"}`;
}

/** Pilot-only counters. Never retain SQL, parameters, account IDs or credentials. */
export class DbProfile {
  private value: DbProfileSnapshot = { phases: {}, operations: {} };
  readonly enabled: boolean;
  constructor(enabled: boolean) { this.enabled = enabled; }
  run<T>(phase: DbPhase, action: () => T): T {
    if (!this.enabled) return action();
    this.value.operations[phase] = (this.value.operations[phase] ?? 0) + 1;
    return context.run({ profile: this, phase }, action);
  }
  measure(phase: DbPhase) { return this.value.phases[phase] ??= fresh(); }
  snapshot(reset = false): DbProfileSnapshot {
    const value = structuredClone(this.value);
    if (reset) this.value = { phases: {}, operations: {} };
    return value;
  }
}

export function dbPhase<T>(phase: DbPhase, action: () => T): T {
  const active = context.getStore();
  return active ? active.profile.run(phase, action) : action();
}

export async function profileConnect<T>(action: () => Promise<T>): Promise<T> {
  const active = context.getStore();
  if (!active) return action();
  const started = performance.now();
  try { return await action(); }
  finally { const m = active.profile.measure(active.phase); m.connections++; m.connectMs += performance.now() - started; }
}

/** One invocation is one pg query round trip, including BEGIN/COMMIT/ROLLBACK.
 * Hold time is measured from BEGIN acknowledgement through COMMIT/ROLLBACK
 * acknowledgement; connect/pool wait is recorded separately. */
export function profileSql<T extends { query: (...args: any[]) => Promise<any> }>(client: T): T {
  let transaction: { profile: DbProfile; phase: DbPhase; started: number } | undefined;
  const query = client.query.bind(client);
  client.query = async (...args: any[]) => {
    const active = context.getStore();
    if (!active) return query(...args);
    const text = typeof args[0] === "string" ? args[0] : "";
    // Table classification partitions accounting's nested transaction SQL without
    // retaining the statement. Control statements remain in their parent phase.
    const phase: DbPhase = /\b(?:webhook_events|webhook_deliveries|webhooks)\b/i.test(text) ? "webhooks"
      : /\b(?:usage|usage_daily|usage_monthly|workspace_usage)\b/i.test(text) ? "usage" : active.phase;
    const started = performance.now(), m = active.profile.measure(phase);
    m.queries++;
    const statement = m.statements[statementCategory(text)] ??= { queries: 0, queryMs: 0, errors: 0 };
    statement.queries++;
    try {
      const result = await query(...args);
      if (/^\s*begin\b/i.test(text)) transaction = { ...active, started: performance.now() };
      return result;
    } catch (error) { m.errors++; statement.errors++; throw error; }
    finally {
      const elapsed = performance.now() - started;
      m.queryMs += elapsed; statement.queryMs += elapsed;
      if (transaction && /^\s*(?:commit|rollback)\b/i.test(text)) {
        const held = performance.now() - transaction.started;
        const tx = transaction.profile.measure(transaction.phase);
        tx.transactions++; tx.transactionMs += held; tx.transactionMaxMs = Math.max(tx.transactionMaxMs, held);
        if (tx.transactionSamplesMs.length < 4096) tx.transactionSamplesMs.push(held);
        transaction = undefined;
      }
    }
  };
  return client;
}

export async function profileHttp(enabled: boolean, action: () => Promise<Response>): Promise<Response> {
  if (!enabled) return action();
  const profile = new DbProfile(true);
  const response = await profile.run("edge", action);
  if (response.status === 101) return response;
  const headers = new Headers(response.headers);
  headers.set("x-pilot-db-profile", JSON.stringify(profile.snapshot()));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
