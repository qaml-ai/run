import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createAdaptorServer } from "@hono/node-server";
import { Accounts } from "./accounts.ts";
import { BillingAlerts } from "./billing-alerts.ts";
import { billingCallbacks } from "./billing-callbacks.ts";
import { BillingMailer, billingMailConfig } from "./billing-mailer.ts";
import { databaseFromEnvironment } from "./db.ts";
import { emailAt, Journey, journeyConfig } from "./journey.ts";
import { safeError } from "./metrics.ts";
import { pricingFromEnvironment } from "./pricing.ts";
import { runtimeSecrets } from "./secrets.ts";
import { Stripe } from "./stripe.ts";
import { tenantsFromEnvironment } from "./tenants.ts";

const env = process.env;
const port = Number(env.AGENT_V1_BILLING_CALLBACK_PORT ?? 8793);

async function main() {
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) throw new Error("AGENT_V1_BILLING_CALLBACK_PORT must be a TCP port");
  const mail = billingMailConfig(env);
  if (!mail) throw new Error("Set the existing v1 billing email sender and SNS topic");
  const tenants = await tenantsFromEnvironment(env);
  const secrets = await runtimeSecrets({
    AWS_REGION: env.AWS_REGION, AWS_DEFAULT_REGION: env.AWS_DEFAULT_REGION,
    AGENT_SECRETS_KEY: env.AGENT_SECRETS_KEY, AGENT_SECRETS_KEY_ARN: env.AGENT_SECRETS_KEY_ARN,
    STRIPE_SECRET_KEY: env.STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET: env.STRIPE_WEBHOOK_SECRET, AGENT_STRIPE_SECRET_ARN: env.AGENT_STRIPE_SECRET_ARN,
    AGENT_JOURNEY_SECRET: env.AGENT_JOURNEY_SECRET, AGENT_JOURNEY_SECRET_ARN: env.AGENT_JOURNEY_SECRET_ARN,
  });
  if (!secrets.stripe || !secrets.secretsKey) throw new Error("Set the existing v1 Stripe credentials and encryption key");
  const stripe = new Stripe({ ...secrets.stripe, apiUrl: env.AGENT_STRIPE_API_URL });
  const journey = journeyConfig(env, secrets.journeySecret);
  const db = await databaseFromEnvironment(env);
  try {
    const accounts = new Accounts({ db, tenants, secretsKey: secrets.secretsKey, stripe, pricing: pricingFromEnvironment(env), publicUrl: mail.origin });
    if (journey) accounts.billing.journey = new Journey({
      db, publicUrl: mail.origin, ...journey,
      internal: (tenant, email) => tenants.has(tenant) || emailAt(journey.internalEmailDomains, email),
    });
    const mailer = new BillingMailer({ ...mail, db, alerts: new BillingAlerts(db, accounts) });
    const app = billingCallbacks(accounts.billing, mailer);
    const server = createAdaptorServer({ fetch: app.fetch }) as Server;
    // The ingress tunnel connects on this host. Stripe and SNS never reach the origin directly.
    server.listen(port, "127.0.0.1");
    await once(server, "listening");
    const closed = once(server, "close");
    const close = () => { server.close(); server.closeIdleConnections(); };
    process.once("SIGTERM", close);
    process.once("SIGINT", close);
    console.log(JSON.stringify({ type: "v1_billing_callbacks_started", port: (server.address() as AddressInfo).port }));
    try { await closed; }
    finally {
      process.off("SIGTERM", close);
      process.off("SIGINT", close);
    }
  } finally { await db.end(); }
}

try { await main(); }
catch (error) {
  console.error(JSON.stringify({ type: "v1_billing_callbacks_failed", error: safeError(error) }));
  process.exitCode = 1;
}
