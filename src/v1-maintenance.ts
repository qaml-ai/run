import { Accounts } from "./accounts.ts";
import { BillingAlerts } from "./billing-alerts.ts";
import { BillingMailer, billingMailConfig } from "./billing-mailer.ts";
import { databaseFromEnvironment, type Db } from "./db.ts";
import { EndUserCredits } from "./end-user-credits.ts";
import { emailAt, Journey, journeyConfig } from "./journey.ts";
import { KeyScopes } from "./key-scopes.ts";
import { safeError, setMetricService } from "./metrics.ts";
import { ModelAttempts } from "./model-attempts.ts";
import { outboundFromEnvironment } from "./outbound.ts";
import { pricingFromEnvironment } from "./pricing.ts";
import { runtimeSecrets } from "./secrets.ts";
import { Stripe } from "./stripe.ts";
import { tenantsFromEnvironment } from "./tenants.ts";
import { MaintenanceElectionError, requireEcsStopped, runMaintenanceJobs, withMaintenanceElection, type MaintenanceJob } from "./v1-maintenance-election.ts";
import { Webhooks } from "./webhooks.ts";

async function maintain(db: Db, env: NodeJS.ProcessEnv, signal: AbortSignal, check: () => Promise<void>) {
  const setting = (name: string, fallback: number) => {
    const value = Number(env[name] ?? fallback);
    if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) throw new MaintenanceElectionError(`${name} must be a valid timer interval`);
    return value;
  };
  const tenants = await tenantsFromEnvironment(env);
  const secrets = await runtimeSecrets({
    AWS_REGION: env.AWS_REGION, AWS_DEFAULT_REGION: env.AWS_DEFAULT_REGION,
    AGENT_SECRETS_KEY: env.AGENT_SECRETS_KEY, AGENT_SECRETS_KEY_ARN: env.AGENT_SECRETS_KEY_ARN,
    STRIPE_SECRET_KEY: env.STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET: env.STRIPE_WEBHOOK_SECRET, AGENT_STRIPE_SECRET_ARN: env.AGENT_STRIPE_SECRET_ARN,
    AGENT_JOURNEY_SECRET: env.AGENT_JOURNEY_SECRET, AGENT_JOURNEY_SECRET_ARN: env.AGENT_JOURNEY_SECRET_ARN,
  });
  if (!secrets.secretsKey) throw new MaintenanceElectionError("Set AGENT_SECRETS_KEY or AGENT_SECRETS_KEY_ARN to the existing v1 encryption key");
  if ((env.AGENT_STRIPE_SECRET_ARN || env.STRIPE_SECRET_KEY || env.STRIPE_WEBHOOK_SECRET) && !secrets.stripe) {
    throw new MaintenanceElectionError("The configured v1 Stripe credentials are unavailable");
  }
  const stripe = secrets.stripe && new Stripe({ ...secrets.stripe, apiUrl: env.AGENT_STRIPE_API_URL });
  const accounts = new Accounts({ tenants, db, secretsKey: secrets.secretsKey, pricing: pricingFromEnvironment(env), publicUrl: env.AGENT_PUBLIC_URL, stripe });
  const journeySettings = journeyConfig(env, secrets.journeySecret);
  const journey = journeySettings && new Journey({
    db, publicUrl: env.AGENT_PUBLIC_URL, ...journeySettings,
    internal: (tenant, email) => tenants.has(tenant) || emailAt(journeySettings.internalEmailDomains, email),
  });
  accounts.billing.journey = journey;
  const outbound = outboundFromEnvironment(env);
  const keyScopes = new KeyScopes({ db, accounts, outbound });
  const endUsers = new EndUserCredits(db);
  const modelAttempts = new ModelAttempts(db, accounts, undefined, 0, async (tenant, scope) => {
    const entry = await keyScopes.entry(tenant, scope, "openrouter");
    // As on ECS, a key with its own gateway must never be sent to OpenRouter.
    return entry?.baseUrl ? { baseUrl: entry.baseUrl } : entry?.apiKey;
  });
  const webhooks = new Webhooks({ db, accounts, outbound, retryBaseMs: setting("AGENT_USAGE_WEBHOOK_RETRY_MS", 5_000) });
  const mailConfig = billingMailConfig(env);
  const billingMailer = mailConfig && new BillingMailer({ db, alerts: new BillingAlerts(db, accounts), ...mailConfig });
  const topup = accounts.billing.autoTopup;
  const schedulerIntervalMs = setting("AGENT_SCHEDULER_INTERVAL_MS", 5_000);
  const jobs: MaintenanceJob[] = [
    { name: "webhooks", intervalMs: schedulerIntervalMs, run: signal => webhooks.send(undefined, signal) },
    { name: "model_attempts", intervalMs: 60_000, run: () => modelAttempts.reconcile() },
    { name: "end_user_lots", intervalMs: 60_000, run: () => endUsers.expireDue() },
  ];
  if (billingMailer) jobs.push({ name: "billing_mail", intervalMs: 5_000, run: () => billingMailer.pump() });
  if (topup) jobs.push({ name: "stripe", intervalMs: 5_000, run: () => topup.pump() });
  if (journey) jobs.push(
    { name: "journey_delivery", intervalMs: schedulerIntervalMs, run: () => journey.send() },
    { name: "journey_reconcile", intervalMs: 10 * 60_000, run: () => journey.reconcile() },
  );
  const stopChecks = () => { void modelAttempts.drain().catch(() => {}); };
  signal.addEventListener("abort", stopChecks, { once: true });
  console.log(JSON.stringify({ type: "v1_maintenance_started", jobs: jobs.map(job => job.name) }));
  try {
    await runMaintenanceJobs(jobs, signal, check, (job, error) => console.error(JSON.stringify({ type: "v1_maintenance_poll_failed", job, error: safeError(error) })));
  } finally {
    signal.removeEventListener("abort", stopChecks);
    await billingMailer?.stop();
  }
}

async function main() {
  // The legacy task supervisor has no knowledge of this lock. End its tasks and prevent relaunch before using this command.
  requireEcsStopped(process.argv.slice(2));
  const env = process.env;
  if (Number(env.AGENT_DATABASE_POOL_SIZE ?? 10) < 2) throw new MaintenanceElectionError("AGENT_DATABASE_POOL_SIZE must leave a connection for jobs in addition to the election");
  setMetricService(env.AGENT_SERVICE_NAME);
  const shutdown = new AbortController();
  process.once("SIGTERM", () => shutdown.abort());
  process.once("SIGINT", () => shutdown.abort());
  // Like the runtime's LISTEN connection, the session advisory lock belongs on direct Postgres.
  const db = await databaseFromEnvironment({ ...env, AGENT_DATABASE_HOST: env.AGENT_DATABASE_LISTEN_HOST || env.AGENT_DATABASE_HOST });
  try {
    await withMaintenanceElection(db, shutdown.signal, (signal, check) => maintain(db, env, signal, check), env.AGENT_V1_MAINTENANCE_VOLUME_ORIGIN);
  } finally {
    await db.end();
  }
  console.log(JSON.stringify({ type: "v1_maintenance_stopped" }));
}

try { await main(); }
catch (error) {
  console.error(JSON.stringify({ type: "v1_maintenance_failed", error: error instanceof MaintenanceElectionError ? error.message : safeError(error) }));
  process.exitCode = 1;
}
