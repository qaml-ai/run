import { Journey, journeyConfig, journeyApp, emailAt, JOURNEY_META } from "../../../src/journey.ts";
import type { Accounts } from "./accounts.ts";
import { keyServices, type KeyEnv } from "./security-services.ts";
import type { ConsoleAuth } from "./account-console-auth.ts";

export type JourneyEnv = {
  AGENT_JOURNEY_URL?: string;
  AGENT_JOURNEY_SECRET?: string;
  AGENT_JOURNEY_VISITOR_COOKIE?: string;
  AGENT_JOURNEY_VISITOR_COOKIE_DOMAIN?: string;
  AGENT_JOURNEY_SITE_HOSTS?: string;
  AGENT_JOURNEY_CONSENT_COOKIE?: string;
  AGENT_JOURNEY_COLLECT_UNKNOWN?: string;
  AGENT_JOURNEY_INTERNAL_EMAIL_DOMAINS?: string;
  AGENT_JOURNEY_RETRY_MS?: string;
  AGENT_PUBLIC_URL?: string;
  ASSETS?: Fetcher;
};

/** The source owns consent, event schemas, deduplication and the durable outbox. */
export function createJourney(env: JourneyEnv, accounts: Accounts, publicUrl: string) {
  const config = journeyConfig(env as NodeJS.ProcessEnv, env.AGENT_JOURNEY_SECRET);
  return config && new Journey({
    ...config, db: accounts.db, publicUrl,
    internal: (tenant, email) => accounts.tenants.has(tenant) || emailAt(config.internalEmailDomains, email),
  });
}

/** Request and cron lifetimes replace the source process's polling timers. */
export async function sendJourney(env: JourneyEnv & KeyEnv) {
  if (!env.AGENT_JOURNEY_URL) return;
  const { accounts } = await keyServices(env);
  const journey = createJourney(env, accounts, env.AGENT_PUBLIC_URL ?? env.PUBLIC_URL ?? "https://localhost");
  if (journey) await journey.send();
}

export async function journeyRunEnded(env: JourneyEnv & KeyEnv, tenant: string, run: { completed: boolean; at?: number }) {
  if (!env.AGENT_JOURNEY_URL) return;
  const { accounts } = await keyServices(env);
  const journey = createJourney(env, accounts, env.AGENT_PUBLIC_URL ?? env.PUBLIC_URL ?? "https://localhost");
  if (journey) { await journey.runEnded(tenant, run); await journey.send(); }
}

export async function publicJourneyRoutes(request: Request, env: JourneyEnv, journey: Journey | undefined, auth: ConsoleAuth) {
  const url = new URL(request.url), path = url.pathname;
  if (path === "/api/journey/events") {
    if (!journey) return new Response("Not found", { status: 404 });
    return journeyApp(journey, auth, c => c.req.header("cf-connecting-ip")).fetch(request);
  }
  if (request.method !== "GET" && request.method !== "HEAD") return;
  if (path === "/console") return new Response(null, { status: 302, headers: { location: `/console/${url.search}` } });
  if (!path.startsWith("/console/") || path.startsWith("/console/auth/")) return;
  if (!env.ASSETS) return new Response("The console is not built on this host", { status: 404 });
  const response = await env.ASSETS.fetch(request);
  if (!response.ok || !response.headers.get("content-type")?.includes("text/html")) return response;
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  if (!journey || request.method === "HEAD") return new Response(response.body, { status: response.status, headers });
  const html = (await response.text()).replace("</head>", `${JOURNEY_META}</head>`);
  const { setCookie } = await journey.arrival(request);
  if (setCookie) headers.append("set-cookie", setCookie);
  headers.delete("content-length");
  return new Response(html, { status: response.status, headers });
}
