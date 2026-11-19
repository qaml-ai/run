import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Billing } from "./billing.ts";
import type { BillingMailer } from "./billing-mailer.ts";
import { errorCode, errorFields, errorHeaders, errorStatus, readText } from "./http.ts";
import { errorText } from "./protocol.ts";

type StripeWebhook = Pick<Billing, "webhook">;

export async function receiveStripeWebhook(request: Request, billing: StripeWebhook) {
  const payload = await readText(request.body, 1024 * 1024);
  return billing.webhook(payload, request.headers.get("stripe-signature") ?? undefined);
}

/** Only Stripe and SNS POST callbacks, authenticated by their original signature checks. */
export function billingCallbacks(billing: StripeWebhook, mail: Pick<BillingMailer, "feedback">) {
  const app = new Hono();
  app.post("/v1/billing/stripe/webhook", async c => c.json(await receiveStripeWebhook(c.req.raw, billing), 200, { "Cache-Control": "no-store" }));
  app.route("/", mail.feedback());
  app.onError((error, c) => {
    const status = errorStatus(error, 400);
    return c.json({ error: errorText(error), code: errorCode(error, status), ...errorFields(error) }, status as ContentfulStatusCode,
      { "Cache-Control": "no-store", ...errorHeaders(error) });
  });
  return app;
}
