// A Worker that runs, in workerd, each path that refuses redirects through fetchWithoutRedirects
// (src/core/no-redirect.ts), against the fake services test/no-redirect.test.ts serves on loopback.
// Each route answers what happened as JSON: the value, or the error's name, message and cause.
import { Stripe } from "../../src/stripe.ts";
import { federationFor } from "../../src/anthropic-federation.ts";
import { prepareSources, sourceTools } from "../../src/tool-sources.ts";
import { network } from "../../src/account-network.ts";
import { signedHeaders } from "../../src/webhook-policy.ts";
import { Journey, type Sql } from "../../../../src/core/journey.ts";

const outcome = async (work: () => Promise<unknown>) => {
  try { return { ok: true, value: await work() }; }
  catch (error) {
    const e = error as Error & { cause?: Error };
    return { ok: false, name: e?.name, message: e?.message, cause: e?.cause?.message };
  }
};
const STRIPE = { secretKey: "sk_test_redirects", webhookSecret: "whsec_redirects" };

async function route(request: Request, fake: string, tag: string) {
  switch (new URL(request.url).pathname) {
    // What the bug was: workerd's fetch itself refuses redirect mode "error".
    case "/native": return outcome(() => fetch(`${fake}/v1/ping`, { redirect: ["e", "rror"].join("") as RequestRedirect }).then(response => response.status));
    case "/stripe/checkout": return outcome(() => new Stripe({ ...STRIPE, apiUrl: fake }).post("/v1/checkout/sessions", {
      mode: "payment", line_items: [{ price_data: { currency: "usd", unit_amount: 1000, product_data: { name: "Credits" } }, quantity: 1 }],
      success_url: "https://run.example.test/console/billing", metadata: { tenant: "t1" },
    }, `camelrun:checkout:${tag}`));
    // The webhook route's work: verify the signature, then fetch the session it names from Stripe.
    case "/stripe/webhook": return outcome(async () => {
      const stripe = new Stripe({ ...STRIPE, apiUrl: fake });
      const event = stripe.verify(await request.text(), request.headers.get("stripe-signature") ?? undefined);
      if (!event) throw new Error("signature refused");
      return { event: event.id, session: await stripe.get(`/v1/checkout/sessions/${encodeURIComponent(event.data.object.id)}`) };
    });
    case "/federation": return outcome(async () => {
      // A workspace per call: federationFor caches a service (and its token) per configuration.
      const service = federationFor({ AGENT_ANTHROPIC_FEDERATION_RULE_ID: "rule", AGENT_ANTHROPIC_ORGANIZATION_ID: "org", AGENT_ANTHROPIC_SERVICE_ACCOUNT_ID: "service",
        AGENT_ANTHROPIC_WORKSPACE_ID: `workspace-${tag}`, TEST_MODE: "1", TEST_ANTHROPIC_FEDERATION_ENDPOINT: fake });
      return service!.credentials("static-key");
    });
    case "/tools": return outcome(async () => {
      const env = { API_TOKEN: "unit-test", TEST_MODE: "1" } as never;
      const document = { openapi: "3.0.0", info: { title: "fake", version: "1" }, paths: { "/items/{id}": { get: { operationId: "getItem",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { 200: { description: "ok" } } } } } };
      const openApi = await prepareSources(env, "tenant", undefined, "openApi", [{ name: "fake", spec: document, baseUrl: fake }]);
      const [tool] = await sourceTools(env, "tenant", undefined, { openApi });
      return (await tool.execute({ id: "7" }, undefined as never, undefined as never)).output;
    });
    case "/journey/export": return outcome(async () => {
      const pages = [];
      for await (const page of journey(fake, { query: async () => ({ rows: [], rowCount: 0 }) }).stored("acct-1", "events")) pages.push(page);
      return pages;
    });
    // One outbox row, delivered: the outbox's statements are answered here, the store is the fake.
    case "/journey/send": return outcome(async () => {
      const done: unknown[] = [];
      let claimed = false;
      const db: Sql = { query: async (text: string, values: unknown[] = []) => {
        if (text.includes("attempts = attempts + 1")) {
          if (claimed) return { rows: [], rowCount: 0 };
          claimed = true;
          return { rows: [{ id: "8d0e6f7a-1b2c-4d3e-8f90-0a1b2c3d4e5f", target: "events", body: { name: "run_account_created" }, attempts: 1 }], rowCount: 1 };
        }
        if (text.startsWith("delete from journey_outbox where id")) done.push({ delivered: values[0] });
        else if (text.includes("last_error")) done.push({ failed: values[2] });
        return { rows: [], rowCount: 0 };
      } };
      await journey(fake, db).send();
      return done;
    });
  }
}

function journey(url: string, db: Sql) {
  return new Journey({ db, url, secret: "whsec_" + btoa("journey-secret-for-tests-only-32b"), fetch: network().fetch,
    host: { transaction: (db, work) => work(db), readText: async body => new Response(body).text(), safeError: error => String((error as Error)?.message ?? error), signedHeaders } });
}

export default {
  async fetch(request: Request) {
    const url = new URL(request.url);
    return Response.json(await route(request, url.searchParams.get("fake")!, url.searchParams.get("tag") ?? "0") ?? { ok: false, message: "no such route" });
  },
};
