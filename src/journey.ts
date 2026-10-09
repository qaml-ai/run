import { createHash, randomUUID } from "node:crypto";
import { Hono, type Context } from "hono";
import { transaction, type Db, type Sql } from "./db.ts";
import { readText } from "./http.ts";
import { safeError } from "./metrics.ts";
import { signedHeaders } from "./webhooks.ts";

/**
 * Journey events: what an operator's own analytics store is told about accounts and the console's pages,
 * so a visit to the operator's website can be followed to an account and what it did. Off unless
 * AGENT_JOURNEY_URL is set: without it nothing here runs, no cookie is read or set and no row is written.
 *
 * An event is written to an outbox (`journey_outbox`) in the transaction of what it describes where
 * there is one, then POSTed to `<url>/api/journey/server-events` as `{schema_version, events: [event]}`,
 * signed per Standard Webhooks with the operator's secret, by any node, retrying with backoff until the
 * store names the event in its answer: delivery is at least once and the store dedupes by `event_id`.
 * A browser's arrival from elsewhere also sends its touch (where it came from) to
 * `<url>/api/marketing-attribution/resolve`, the same way. None of this reaches a tenant's webhooks,
 * which have their own tables (webhooks.ts).
 *
 * An event says only what is listed for its name below. An account is `account_ref`, a random id kept
 * in `journey_accounts`, never the tenant id (which can be a GitHub login); a browser is `visitor_id`,
 * the UUID in the cookie the operator names (AGENT_JOURNEY_VISITOR_COOKIE), set by the operator's site
 * or, for a browser that came here first, by `arrival`. A page is its route (`/console/agents/:agent_id`),
 * never the address with an id in it.
 *
 * Whether anything is recorded for a browser is its consent (`consent`): `denied` never is, `granted`
 * is, and `unknown` only if the operator said so (AGENT_JOURNEY_COLLECT_UNKNOWN). Each event says which
 * it was (`analytics_consent`). An account keeps what its browser last said, for what it does away from
 * a browser (a token minted with a token). A refusal is told to the store too (`<url>/api/journey/consent-controls`,
 * naming the account and the browser, no event): what it had queued for Google of that account or browser is
 * withdrawn there. Only a refusal is told; that a browser agreed is in each of its events.
 *
 * Writing an event never fails what it describes: a fault is logged and the event is lost, but for an
 * account's making, which is noted aside (`journey_lost_signups`) and sent late by `reconcile`.
 */
export const JOURNEY_SCHEMA_VERSION = 1;
export const JOURNEY_EVENTS_PATH = "/api/journey/server-events";
export const JOURNEY_RESOLVE_PATH = "/api/marketing-attribution/resolve";
export const JOURNEY_EXPORT_PATH = "/api/journey/account-export";
export const JOURNEY_CONSENT_PATH = "/api/journey/consent-controls";
/** The meta tag `arrival` has the console's shell carry where journey events are on, so the console reports its pages. */
export const JOURNEY_META = '<meta name="agent-runtime-journey" content="1">';
export type JourneyMethod = "github" | "google" | "password";
export type JourneySurface = "console" | "mcp";
export type JourneyEntry = "sales_site_link" | "github" | "docs" | "search" | "ai_assistant" | "other_referral" | "none_observed";
/** Each event's properties: all it may carry. */
export type JourneyProperties = {
  page_viewed: { page_type: "console"; product_context: "run" };
  run_arrived: { entry_channel: JourneyEntry; landing_path: string; handoff_id?: string };
  run_auth_started: { method: JourneyMethod; auth_surface: JourneySurface };
  run_account_created: { method: JourneyMethod; auth_surface: JourneySurface };
  run_signed_in: { method: JourneyMethod; auth_surface: JourneySurface };
  run_signed_out: Record<string, never>;
  run_account_provisioned: Record<string, never>;
  run_token_created: { is_first: boolean };
  run_agent_created: { is_first: boolean; created_via: "console" | "api" | "mcp" };
  run_first_execution_completed: { seconds_since_signup?: number };
  run_active_day: { activity_date: string };
  run_card_verified: Record<string, never>;
  run_checkout_started: { amount_minor: number; currency: "USD" };
  run_credit_purchased: { amount_minor: number; currency: "USD"; is_first: boolean; transaction_ref: string };
  run_auto_topup_enabled: Record<string, never>;
  run_account_deleted: { days_since_signup?: number };
};
export type JourneyEventName = keyof JourneyProperties;
export type JourneyEvent<Name extends JourneyEventName = JourneyEventName> = {
  schema_version: typeof JOURNEY_SCHEMA_VERSION; event_id: string; name: Name; occurred_at: string;
  source_app: "run"; observed_by: Name extends "page_viewed" ? "browser" : "server"; visitor_id: string | null; account_ref: string | null;
  page_host: string | null; page_path: string | null; referrer_host: string | null;
  properties: JourneyProperties[Name]; is_internal: boolean;
  /** What the browser, or the account's last browser, said: never `denied`, for then there is no event. */
  analytics_consent: "granted" | "unknown";
  /** Google Analytics' own id for the browser, from its cookie, where it has one. */
  ga_client_id?: string;
};
export type JourneyConsent = "granted" | "denied" | "unknown";
/** What a request's browser is to the journey: its visitor id, if any, what it said about being measured and so whether to record it. */
export type JourneyBrowser = {
  visitor: string | null; consent: JourneyConsent; collect: boolean; gaClientId?: string;
  /** A refusing browser's visitor id, read for one purpose: to tell the store which browser refused, so it withdraws what that browser had it queue. */
  refused?: string;
};

export interface JourneyOptions {
  db: Db;
  /** The store's origin, e.g. https://camelai.com. */
  url: string;
  /** The Standard Webhooks secret deliveries are signed with (`whsec_<base64 key>`). */
  secret: string;
  /** This runtime's public origin: its host is the pages' `page_host`, and its scheme says whether the visitor cookie is Secure. */
  publicUrl?: string;
  /** The cookie that carries a browser's visitor id; without one no event names a visitor and none is given one. */
  visitorCookie?: string;
  /** The domain a visitor cookie set here is for, so the operator's site reads it too (e.g. `camelai.com`); unset, this host only. */
  visitorCookieDomain?: string;
  /** The operator's site's hosts: a browser coming from one came by its links. The store's own host and its `www.` unless given. */
  siteHosts?: string[];
  /** The cookie in which the operator's site keeps a browser's answer about being measured: `granted` or `denied`. */
  consentCookie?: string;
  /** Record browsers that have given no answer. Off unless the operator decided so. */
  collectUnknown?: boolean;
  /** Whether an account is the operator's own (staff, an admin tenant): its events say so, for the store to leave out of its counts. */
  internal?: (tenant: string, email?: string) => boolean;
  retryBaseMs?: number;
  fetch?: typeof fetch;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HOST = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
const CLAIM_BATCH = 50;
/** A claimed delivery is left to others if its node has not settled it by then. */
const LEASE_MS = 60_000;
const TIMEOUT_MS = 10_000;
/** An event nobody took is dropped after this long. Never a deletion: the store must hear of it however long that takes. */
const MAX_AGE_MS = 30 * 24 * 60 * 60_000;
/** What the store refused as invalid is offered again this often: a store brought up to date takes it then. */
const REJECTED_RETRY_MS = 24 * 60 * 60_000;
/** An account this old with no journey row was not mid-sign-up: its event was lost. */
const RECONCILE_AFTER_MS = 60_000;
const VISITOR_COOKIE_SECONDS = 90 * 24 * 60 * 60;
const DELETED = "run_account_deleted";
/** How long a node remembers that an account's runs are not recorded, before asking again: its browser may since have agreed. */
const UNRECORDED_MS = 5 * 60_000;
/** A day's mark is needed only while runs can still end on that day. */
const ACTIVE_DAY_KEPT_MS = 3 * 24 * 60 * 60_000;
/** What a link may say of the campaign it belongs to; nothing else of an address's query is kept. */
const CAMPAIGN_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "gclid", "gbraid", "wbraid", "gad_source"];
/** The console's pages, as routes: these and the two with an id in them are all a `page_path` can be. */
const CONSOLE_PATHS = new Set(["/console", "/console/start", "/console/agents", "/console/volumes", "/console/definitions", "/console/channels", "/console/models", "/console/tokens", "/console/usage",
  "/console/telemetry", "/console/billing", "/console/account", "/console/quickstart", "/console/billing/confirm", "/console/billing/unsubscribe", "/console/verify", "/console/reset"]);
const SEARCH = /(^|\.)(google\.[a-z.]{2,6}|bing\.com|duckduckgo\.com|yahoo\.[a-z.]{2,6}|baidu\.com|yandex\.[a-z.]{2,6}|ecosia\.org|brave\.com|kagi\.com|startpage\.com|coccoc\.com)$/;
const ASSISTANT = /(^|\.)(chatgpt\.com|openai\.com|claude\.ai|perplexity\.ai|gemini\.google\.com|copilot\.microsoft\.com|phind\.com|you\.com)$/;
const NOT_A_BROWSER = /bot\b|crawl|spider|slurp|preview|monitor|curl|wget|python|node|go-http|headless|scrapy|httpclient|axios|okhttp/i;

/** The journey configuration in the environment, or undefined when AGENT_JOURNEY_URL is not set. `secret` is AGENT_JOURNEY_SECRET or what its ARN holds (secrets.ts). */
export function journeyConfig(env: NodeJS.ProcessEnv, secret: string | null | undefined): Pick<JourneyOptions, "url" | "secret" | "visitorCookie" | "visitorCookieDomain" | "siteHosts" | "consentCookie" | "collectUnknown" | "retryBaseMs"> & { internalEmailDomains: string[] } | undefined {
  // Null: the secret is named (AGENT_JOURNEY_SECRET_ARN) and has no value yet (src/secrets.ts). Off until it has.
  if (secret === null) return undefined;
  const raw = env.AGENT_JOURNEY_URL;
  if (!raw) {
    if (secret) throw new Error("AGENT_JOURNEY_SECRET is set without AGENT_JOURNEY_URL");
    return undefined;
  }
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("AGENT_JOURNEY_URL must be an origin, such as https://example.com"); }
  if (!/^https?:$/.test(url.protocol) || url.pathname !== "/" || url.search || url.hash || url.username || url.password) throw new Error("AGENT_JOURNEY_URL must be an origin, such as https://example.com");
  // Events and their signatures cross the network: only a store on this machine may be reached without TLS.
  if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("AGENT_JOURNEY_URL must be https, except for a store on localhost");
  // Standard base64 of at least 16 bytes, as the store reads it.
  if (!secret || !/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret) || Buffer.from(secret.slice(6), "base64").length < 16) throw new Error("AGENT_JOURNEY_URL needs AGENT_JOURNEY_SECRET (or AGENT_JOURNEY_SECRET_ARN): a Standard Webhooks secret, whsec_<base64 of 16 bytes or more>");
  const cookie = (name: string) => {
    const value = env[name];
    if (value !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(value)) throw new Error(`${name} must be a cookie name`);
    return value || undefined;
  };
  const hosts = (name: string) => {
    const values = (env[name] ?? "").split(",").map(host => host.trim().toLowerCase()).filter(Boolean);
    if (values.some(host => !HOST.test(host))) throw new Error(`${name} must be host names separated by commas`);
    return values;
  };
  const visitorCookie = cookie("AGENT_JOURNEY_VISITOR_COOKIE"), consentCookie = cookie("AGENT_JOURNEY_CONSENT_COOKIE");
  const [visitorCookieDomain, ...more] = hosts("AGENT_JOURNEY_VISITOR_COOKIE_DOMAIN");
  if (more.length) throw new Error("AGENT_JOURNEY_VISITOR_COOKIE_DOMAIN must be one domain");
  const siteHosts = hosts("AGENT_JOURNEY_SITE_HOSTS");
  if (env.AGENT_JOURNEY_COLLECT_UNKNOWN !== undefined && !["true", "false"].includes(env.AGENT_JOURNEY_COLLECT_UNKNOWN)) throw new Error("AGENT_JOURNEY_COLLECT_UNKNOWN must be true or false");
  const internalEmailDomains = hosts("AGENT_JOURNEY_INTERNAL_EMAIL_DOMAINS");
  const retryBaseMs = env.AGENT_JOURNEY_RETRY_MS === undefined ? undefined : Number(env.AGENT_JOURNEY_RETRY_MS);
  if (retryBaseMs !== undefined && (!Number.isSafeInteger(retryBaseMs) || retryBaseMs < 1)) throw new Error("AGENT_JOURNEY_RETRY_MS must be a positive integer");
  return {
    url: url.origin, secret, ...(visitorCookie ? { visitorCookie } : {}), ...(visitorCookieDomain ? { visitorCookieDomain } : {}), ...(siteHosts.length ? { siteHosts } : {}),
    ...(consentCookie ? { consentCookie } : {}), collectUnknown: env.AGENT_JOURNEY_COLLECT_UNKNOWN === "true", internalEmailDomains, ...(retryBaseMs === undefined ? {} : { retryBaseMs }),
  };
}

/** Whether `email` is at exactly one of `domains`. */
export function emailAt(domains: string[], email: string | undefined) {
  const at = email?.lastIndexOf("@") ?? -1;
  return at > 0 && domains.includes(email!.slice(at + 1).toLowerCase());
}

/** A console address as its route: a page with an id in it is its template, and anything unknown is `/console/*`. */
export function consoleRoute(pathname: string) {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (CONSOLE_PATHS.has(path)) return path;
  const [, section, id, ...deeper] = /^\/console\/([a-z]+)\/([^/]+)(\/.*)?$/.exec(path) ?? [];
  if (id && !deeper[0] && section === "agents") return "/console/agents/:agent_id";
  if (id && !deeper[0] && section === "volumes") return "/console/volumes/:volume_id";
  return "/console/*";
}

/** A UUID from a key, the same each time: an event written again keeps its id. */
function keyedId(key: string) {
  const hex = createHash("sha256").update(key).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${(parseInt(hex[16]!, 16) & 3 | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function cookieOf(request: Request, name: string | undefined) {
  if (!name) return undefined;
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}

/** The host of an address, lower case, if it is an http one with a host name. */
function hostOf(address: string | null | undefined) {
  try {
    const url = new URL(address ?? "");
    return /^https?:$/.test(url.protocol) && HOST.test(url.hostname) ? { host: url.hostname, path: url.pathname } : undefined;
  } catch { return undefined; }
}

type About = { accountRef: string | null; visitor: string | null; internal: boolean; consent: JourneyConsent | "lost"; key?: string; id?: string; at?: number; gaClientId?: string; page?: { host: string; path: string; referrer: string | null } };

/** Add an event to the outbox. With `key` (or the sender's own `id`) it has the same id each time, so writing it again adds nothing. Returns whether it was added. */
async function enqueue<Name extends JourneyEventName>(sql: Sql, name: Name, properties: JourneyProperties[Name], about: About) {
  const now = Date.now();
  const event = {
    schema_version: JOURNEY_SCHEMA_VERSION, event_id: about.id ?? (about.key === undefined ? randomUUID() : keyedId(about.key)), name, occurred_at: new Date(about.at ?? now).toISOString(),
    source_app: "run", observed_by: name === "page_viewed" ? "browser" : "server", visitor_id: about.visitor, account_ref: about.accountRef,
    page_host: about.page?.host ?? null, page_path: about.page?.path ?? null, referrer_host: about.page?.referrer ?? null, properties, is_internal: about.internal,
    analytics_consent: about.consent === "granted" ? "granted" : "unknown", ...(about.gaClientId ? { ga_client_id: about.gaClientId } : {}),
  } as JourneyEvent<Name>;
  return !!(await sql.query("insert into journey_outbox (id, account_ref, body, due, created_at) values ($1, $2, $3, $4, $4) on conflict (id) do nothing", [event.event_id, about.accountRef, JSON.stringify(event), now])).rowCount;
}

/**
 * What goes with an account when it is deleted, in the deletion's transaction (before its tenant row goes)
 * and whether or not journey events are configured now: its row, its milestones and anything of its still
 * to send. The store is told (`run_account_deleted`, naming only the `account_ref`) so it deletes its copy
 * too; that event stays in the outbox until the store says it has, and waits there for a runtime that has
 * journey events off to have them on again.
 */
export async function deleteJourneyAccount(sql: Sql, tenant: string) {
  await sql.query("delete from journey_lost_signups where tenant = $1", [tenant]);
  const account = (await sql.query("delete from journey_accounts where tenant = $1 returning account_ref, internal", [tenant])).rows[0] as { account_ref: string; internal: boolean } | undefined;
  if (!account) return;
  await sql.query("delete from journey_milestones where account_ref = $1", [account.account_ref]);
  await sql.query("delete from journey_outbox where account_ref = $1", [account.account_ref]);
  // The account's real age, from its own row: journey may have first seen it long after it was made.
  const made = (await sql.query("select created_at from tenants where id = $1", [tenant])).rows[0]?.created_at;
  await enqueue(sql, DELETED, made === undefined ? {} : { days_since_signup: Math.max(0, Math.floor((Date.now() - Number(made)) / 86_400_000)) },
    { accountRef: account.account_ref, visitor: null, internal: account.internal, consent: "unknown", key: `${DELETED}:${account.account_ref}` });
}

/**
 * What this runtime itself keeps of an account's journey, for its export (account-export.ts): its ids, what its browser
 * last said, what it has done once, and what is still to be sent of it. Undefined for an account journey never knew.
 * Read whether or not journey events are configured now.
 */
export async function journeyKept(db: Db, tenant: string) {
  const account = (await db.query("select account_ref, signup_visitor, internal, since_signup, consent, ga_client_id, created_at from journey_accounts where tenant = $1", [tenant])).rows[0];
  if (!account) return undefined;
  const [milestones, waiting] = await Promise.all([
    db.query("select name, at from journey_milestones where account_ref = $1 order by at, name", [account.account_ref]),
    db.query("select body from journey_outbox where account_ref = $1 and target = 'events' order by created_at, id", [account.account_ref]),
  ]);
  return {
    accountRef: account.account_ref as string, signupVisitor: account.signup_visitor as string | null, internal: account.internal as boolean, seenSinceSignup: account.since_signup as boolean,
    consent: account.consent as string, googleAnalyticsClientId: account.ga_client_id as string | null, firstSeenAt: Number(account.created_at),
    milestones: milestones.rows.map(row => ({ name: row.name as string, at: Number(row.at) })), eventsNotYetSent: waiting.rows.map(row => row.body as JourneyEvent),
  };
}

export class Journey {
  private readonly db: Db;
  private readonly options: JourneyOptions;
  private readonly retryBaseMs: number;
  private readonly host?: string;
  private readonly secure: boolean;
  private readonly siteHosts: Set<string>;
  private timers: ReturnType<typeof setInterval>[] = [];
  private sending = false;
  /** What this node has already said of each account's runs: the day it marked active, and whether its first run is behind it. Runs are many; this spares the database all but the first of a day. */
  private readonly runs = new Map<string, { day: string; first: boolean; until?: number }>();
  /** Accounts this node has already noted as refusing, so a refusing browser's pages cost the database once and not each time. */
  private readonly refusing = new Set<string>();

  constructor(options: JourneyOptions) {
    this.db = options.db;
    this.options = options;
    this.retryBaseMs = options.retryBaseMs ?? 30_000;
    const own = options.publicUrl ? new URL(options.publicUrl) : undefined;
    this.host = own?.hostname;
    this.secure = own?.protocol === "https:";
    const store = new URL(options.url).hostname;
    this.siteHosts = new Set(options.siteHosts ?? [store, `www.${store}`]);
  }

  /** What a request's browser said about being measured: Global Privacy Control is a no, then the operator's consent cookie. */
  consent(request: Request): JourneyConsent {
    if (request.headers.get("sec-gpc") === "1") return "denied";
    const answer = cookieOf(request, this.options.consentCookie);
    return answer === "granted" || answer === "denied" ? answer : "unknown";
  }

  private collects(consent: JourneyConsent | "lost") { return consent === "granted" || (consent === "unknown" && !!this.options.collectUnknown); }

  /** A request's browser: what it said, so whether to record it, and (only then) its visitor id (the cookie's UUID; anything else is no visitor) and Google Analytics' id for it. */
  browser(request: Request): JourneyBrowser {
    const consent = this.consent(request), collect = this.collects(consent);
    const value = consent === "denied" || collect ? cookieOf(request, this.options.visitorCookie) : undefined;
    if (!collect) return { visitor: null, consent, collect, ...(consent === "denied" && value && UUID.test(value) ? { refused: value.toLowerCase() } : {}) };
    // Google Analytics' cookie is GA1.<n>.<random>.<time>: its last two numbers are the id it knows the browser by.
    const ga = /^GA\d\.\d+\.(\d{1,20}\.\d{1,20})$/.exec(cookieOf(request, "_ga") ?? "")?.[1];
    return { visitor: value && UUID.test(value) ? value.toLowerCase() : null, consent, collect, ...(ga ? { gaClientId: ga } : {}) };
  }

  /**
   * The account's journey row, made now if it has none. `seen` is what this moment adds: an internal account
   * stays one, and `consent` is replaced when a browser has just said (left as it was away from a browser;
   * unknown for an account never seen in one). `gaClientId` is Google Analytics' id to send with the event: this
   * browser's, or away from a browser the one kept from the account's last browser that agreed (never one made
   * up, and none once a browser has refused).
   */
  private async account(sql: Sql, tenant: string, seen: { email?: string; consent?: JourneyConsent | "lost"; signup?: { visitor: string | null }; gaClientId?: string; refused?: string; signingIn?: boolean } = {}) {
    const ga = seen.consent === "granted" ? seen.gaClientId ?? null : null;
    const row = (await sql.query(`
      insert into journey_accounts (tenant, account_ref, signup_visitor, internal, since_signup, consent, ga_client_id, created_at) values ($1, $2, $3, $4, $5, $6, $9, $7)
      on conflict (tenant) do update set internal = journey_accounts.internal or excluded.internal, consent = coalesce($8::text, journey_accounts.consent),
        ga_client_id = case when $8::text is null then journey_accounts.ga_client_id when $8::text = 'granted' then coalesce($9, journey_accounts.ga_client_id) else null end
      returning account_ref, internal, consent, since_signup, ga_client_id, (select consent from journey_accounts where tenant = $1) as before`,
    [tenant, randomUUID(), seen.signup?.visitor ?? null, !!this.options.internal?.(tenant, seen.email), !!seen.signup, seen.consent ?? "unknown", Date.now(), seen.consent ?? null, ga])).rows[0];
    // The account's browser refused: the store is told, when it turns to refusing and at each sign-in that still does (a sign-in is seldom, and a missed word then mends itself).
    if (seen.consent === "denied" && (row.before !== "denied" || seen.signingIn)) {
      const control = { schema_version: JOURNEY_SCHEMA_VERSION, control_id: randomUUID(), account_ref: row.account_ref as string, visitor_id: seen.refused ?? null, consent: "denied", decided_at: new Date().toISOString() };
      await sql.query("insert into journey_outbox (id, target, account_ref, body, due, created_at) values ($1, 'consent', $2, $3, $4, $4)", [control.control_id, row.account_ref, JSON.stringify(control), Date.now()]);
    }
    return {
      accountRef: row.account_ref as string, internal: row.internal as boolean, consent: row.consent as JourneyConsent | "lost", collect: this.collects(row.consent), sinceSignup: row.since_signup as boolean,
      gaClientId: seen.gaClientId ?? (row.consent === "granted" ? row.ga_client_id as string | null ?? undefined : undefined),
    };
  }

  /**
   * A console page was asked for (the app shell, by a browser going there). Where the browser came from
   * elsewhere, by a link carrying `camel_handoff` or for the first time, that is an arrival: `run_arrived`
   * says how it came, and its touch goes to the store, which keeps where each visitor first and last came
   * from. A browser with no visitor id is given one, in the cookie this returns. A reload or a return visit
   * is no arrival; the console's `page_viewed` tells of those. Never fails the page.
   */
  async arrival(request: Request): Promise<{ setCookie?: string }> {
    try {
      const name = this.options.visitorCookie;
      if (!name || request.method !== "GET" || NOT_A_BROWSER.test(request.headers.get("user-agent") || "bot")) return {};
      // A page the browser is going to, not one a script fetched or a tab loaded ahead of time.
      const dest = request.headers.get("sec-fetch-dest"), purpose = request.headers.get("sec-purpose") ?? request.headers.get("purpose") ?? "";
      if ((dest !== null && dest !== "document") || /prefetch|prerender/.test(purpose)) return {};
      const browser = this.browser(request);
      if (!browser.collect) return {};
      const url = new URL(request.url);
      const from = hostOf(request.headers.get("referer"));
      const referrer = from && from.host !== this.host && from.host !== url.hostname ? from : undefined;
      const param = url.searchParams.get("camel_handoff");
      const handoff = param && UUID.test(param) ? param.toLowerCase() : undefined;
      if (browser.visitor && !referrer && !handoff) return {};
      const visitor = browser.visitor ?? randomUUID();
      const campaign: Record<string, string> = {};
      for (const key of CAMPAIGN_KEYS) {
        const value = url.searchParams.get(key);
        // As the store reads them: printable, bounded, and nothing that looks like an address or a credential.
        if (value && /^[\x20-\x7e]{1,200}$/.test(value) && !/@|%40|art_|bearer\s|https?:\/\//i.test(value)) campaign[key] = value;
      }
      const site = referrer && this.siteHosts.has(referrer.host);
      const entry: JourneyEntry = site && /^\/docs(\/|$)/.test(referrer.path) ? "docs" : handoff || site ? "sales_site_link"
        : !referrer ? "none_observed" : /(^|\.)github\.com$/.test(referrer.host) ? "github" : ASSISTANT.test(referrer.host) ? "ai_assistant" : SEARCH.test(referrer.host) ? "search" : "other_referral";
      const path = consoleRoute(url.pathname), host = this.host ?? url.hostname, now = Date.now();
      await transaction(this.db, async sql => {
        // The touch is what the store keeps of where a visitor came from: worth sending for a new visitor, a campaign or another site, not for our own site's link, which says nothing new.
        if (!browser.visitor || Object.keys(campaign).length || (referrer && !site)) {
          const touch = { attribution_id: visitor, touch: { page_host: host, page_path: path, referrer_host: referrer && !site ? referrer.host : null, campaign, occurred_at: new Date(now).toISOString() } };
          await sql.query("insert into journey_outbox (id, target, body, due, created_at) values ($1, 'resolve', $2, $3, $3)", [randomUUID(), JSON.stringify(touch), now]);
        }
        await enqueue(sql, "run_arrived", { entry_channel: entry, landing_path: path, ...(handoff ? { handoff_id: handoff } : {}) },
          { accountRef: null, visitor, internal: false, consent: browser.consent, at: now, gaClientId: browser.gaClientId });
      });
      if (browser.visitor) return {};
      const domain = this.options.visitorCookieDomain;
      return { setCookie: `${name}=${visitor}; ${domain ? `Domain=${domain}; ` : ""}Path=/; Max-Age=${VISITOR_COOKIE_SECONDS}; ${this.secure ? "Secure; " : ""}HttpOnly; SameSite=Lax` };
    } catch (error) {
      console.error(JSON.stringify({ type: "journey_event_failed", event: "run_arrived", error: safeError(error) }));
      return {};
    }
  }

  /**
   * Pages the console says its browser saw (`POST /api/journey/events`, from this origin): `{schema_version: 1,
   * events: [{event_id, name: "page_viewed", occurred_at, page_path, referrer_host?}]}`, twenty at most. Who saw
   * them is the request's, never the body's: the visitor from its cookie, the account (`tenant`) from its session.
   * A page is kept as its route. An event is `accepted` once it is in the outbox, again if sent again.
   */
  async pagesViewed(request: Request, tenant: string | undefined, body: unknown, now = Date.now()) {
    const input = body as { schema_version?: unknown; events?: unknown } | null;
    if (!input || typeof input !== "object" || input.schema_version !== JOURNEY_SCHEMA_VERSION || !Array.isArray(input.events) || input.events.length < 1 || input.events.length > 20) return { status: 400 as const, body: { error: "invalid_batch" } };
    const browser = this.browser(request);
    const accepted: string[] = [], rejected: { event_id: string | null; reason: string }[] = [];
    if (!browser.collect) {
      // A signed-in browser that now refuses: the account learns of it here, the first page it reports after, and the store with it.
      if (tenant && browser.consent === "denied" && !this.refusing.has(tenant)) {
        await this.safely("page_viewed", sql => this.account(sql, tenant, { consent: "denied", refused: browser.refused }));
        if (this.refusing.size > 20_000) this.refusing.clear();
        this.refusing.add(tenant);
      }
      return { status: 200 as const, body: { accepted, rejected, collecting: false } };
    }
    if (tenant) this.refusing.delete(tenant);
    const host = this.host ?? new URL(request.url).hostname;
    try {
      await transaction(this.db, async sql => {
        // Counted afresh by each run of the transaction: one that lost a race runs again.
        accepted.length = rejected.length = 0;
        const account = tenant ? await this.account(sql, tenant, { consent: browser.consent, gaClientId: browser.gaClientId }) : undefined;
        for (const event of input.events as Record<string, unknown>[]) {
          const id = typeof event?.event_id === "string" && UUID.test(event.event_id) ? event.event_id.toLowerCase() : null;
          const at = typeof event?.occurred_at === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(event.occurred_at) ? Date.parse(event.occurred_at) : NaN;
          const referrer = event?.referrer_host ?? null;
          const reason = !id ? "invalid_event_id" : event.name !== "page_viewed" ? "unknown_name"
            // The browser's clock, within reason: a page seen a day ago or in the future was not seen now.
            : !(at <= now + 300_000 && at >= now - 86_400_000) ? "invalid_timestamp"
            : typeof event.page_path !== "string" || !/^\/console(\/|$)/.test(event.page_path) || event.page_path.length > 500 ? "invalid_path"
            : referrer !== null && (typeof referrer !== "string" || !HOST.test(referrer)) ? "invalid_referrer"
            : Object.keys(event).some(key => !["event_id", "name", "occurred_at", "page_path", "referrer_host"].includes(key)) ? "unknown_field" : undefined;
          if (reason) { rejected.push({ event_id: id, reason }); continue; }
          await enqueue(sql, "page_viewed", { page_type: "console", product_context: "run" }, {
            id: id!, at, accountRef: account?.accountRef ?? null, visitor: browser.visitor, internal: account?.internal ?? false, consent: browser.consent, gaClientId: browser.gaClientId,
            page: { host, path: consoleRoute(event.page_path as string), referrer: referrer === host ? null : referrer as string | null },
          });
          accepted.push(id!);
        }
      });
    } catch (error) {
      console.error(JSON.stringify({ type: "journey_event_failed", event: "page_viewed", error: safeError(error) }));
      return { status: 503 as const, body: { error: "unavailable" } };
    }
    return { status: 200 as const, body: { accepted, rejected } };
  }

  /** A sign-in was started. No account yet: this is the browser alone. */
  authStarted(start: { method: JourneyMethod; surface: JourneySurface; browser: JourneyBrowser }) {
    if (!start.browser.collect) return Promise.resolve();
    return this.safely("run_auth_started", sql => enqueue(sql, "run_auth_started", { method: start.method, auth_surface: start.surface },
      { accountRef: null, visitor: start.browser.visitor, internal: false, consent: start.browser.consent, gaClientId: start.browser.gaClientId }));
  }

  /**
   * A sign-in made a new account: called in the transaction that inserted its tenant row, so the event
   * exists exactly when the account does. Under a savepoint: a fault here never loses the sign-up. It
   * loses the event until `reconcile` sends it, from the little noted aside here, above all what the
   * browser said: with no note, nothing is ever sent for the account's making, since a refusal cannot be ruled out.
   */
  async accountCreated(sql: Sql, signup: { tenant: string; method: JourneyMethod; surface: JourneySurface; browser: JourneyBrowser; email?: string }) {
    await sql.query("savepoint journey_account_created");
    try {
      const account = await this.account(sql, signup.tenant, { email: signup.email, consent: signup.browser.consent, signup: { visitor: signup.browser.visitor }, gaClientId: signup.browser.gaClientId, refused: signup.browser.refused });
      if (account.collect) {
        await enqueue(sql, "run_account_created", { method: signup.method, auth_surface: signup.surface },
          { accountRef: account.accountRef, visitor: signup.browser.visitor, internal: account.internal, consent: account.consent, key: `run_account_created:${account.accountRef}`, gaClientId: account.gaClientId });
      }
      await sql.query("release savepoint journey_account_created");
    } catch (error) {
      await sql.query("rollback to savepoint journey_account_created");
      console.error(JSON.stringify({ type: "journey_event_failed", event: "run_account_created", error: safeError(error) }));
      await sql.query("savepoint journey_lost_signup");
      try {
        await sql.query("insert into journey_lost_signups (tenant, consent, visitor, method, surface, at) values ($1, $2, $3, $4, $5, $6) on conflict (tenant) do nothing",
          [signup.tenant, signup.browser.consent, signup.browser.visitor, signup.method, signup.surface, Date.now()]);
        await sql.query("release savepoint journey_lost_signup");
      } catch (again) {
        await sql.query("rollback to savepoint journey_lost_signup");
        console.error(JSON.stringify({ type: "journey_event_failed", event: "run_account_created", noted: false, error: safeError(again) }));
      }
    }
  }

  /** A sign-in to an account that already existed. The visitor is this browser, now; who the account first came as is not touched. */
  signedIn(signIn: { tenant: string; method: JourneyMethod; surface: JourneySurface; browser: JourneyBrowser; email?: string }) {
    return this.safely("run_signed_in", async sql => {
      const account = await this.account(sql, signIn.tenant, { email: signIn.email, consent: signIn.browser.consent, gaClientId: signIn.browser.gaClientId, refused: signIn.browser.refused, signingIn: true });
      if (account.collect) await enqueue(sql, "run_signed_in", { method: signIn.method, auth_surface: signIn.surface },
        { accountRef: account.accountRef, visitor: signIn.browser.visitor, internal: account.internal, consent: account.consent, gaClientId: account.gaClientId });
    });
  }

  /** A console session was ended by its owner: this browser is no longer the account's. */
  signedOut(signOut: { tenant: string; browser: JourneyBrowser }) {
    if (!signOut.browser.collect) return Promise.resolve();
    return this.safely("run_signed_out", async sql => {
      const account = await this.account(sql, signOut.tenant, { consent: signOut.browser.consent, gaClientId: signOut.browser.gaClientId });
      await enqueue(sql, "run_signed_out", {}, { accountRef: account.accountRef, visitor: signOut.browser.visitor, internal: account.internal, consent: account.consent, gaClientId: account.gaClientId });
    });
  }

  /**
   * An API token was minted, from a browser or with a token. `is_first` is the account's first: known for
   * an account made while journey events were on; for an older one, true only if it had no other token
   * then (one it revoked earlier cannot be seen).
   */
  tokenCreated(token: { tenant: string; browser?: JourneyBrowser }) {
    if (token.browser && !token.browser.collect) return Promise.resolve();
    return this.safely("run_token_created", async sql => {
      const account = await this.account(sql, token.tenant, token.browser ? { consent: token.browser.consent, gaClientId: token.browser.gaClientId } : {});
      if (!account.collect) return;
      const unseen = !!(await sql.query("insert into journey_milestones (account_ref, name, at) values ($1, 'run_token_created', $2) on conflict do nothing", [account.accountRef, Date.now()])).rowCount;
      const first = unseen && (account.sinceSignup || (await sql.query("select count(*)::int as count from api_tokens where tenant = $1", [token.tenant])).rows[0].count <= 1);
      await enqueue(sql, "run_token_created", { is_first: first }, { accountRef: account.accountRef, visitor: token.browser?.visitor ?? null, internal: account.internal, consent: account.consent, gaClientId: account.gaClientId });
    });
  }

  /** A platform operator made an account through the API: nobody signed up, and no browser was there. */
  accountProvisioned(tenant: string) {
    return this.safely("run_account_provisioned", async sql => {
      const account = await this.account(sql, tenant, { signup: { visitor: null } });
      if (account.collect) await enqueue(sql, "run_account_provisioned", {}, { accountRef: account.accountRef, visitor: null, internal: account.internal, consent: account.consent, key: `run_account_provisioned:${account.accountRef}` });
    });
  }

  /**
   * An agent was made through the API (`POST /v1/agents`: the console, a token, or the hosted MCP server), not one
   * a key already had, a delegate's child or a channel's. `is_first` as for a token: known for an account made while
   * journey events were on; for an older one, true only if it has no other agent now.
   */
  agentCreated(agent: { tenant: string; via: "console" | "api" | "mcp"; browser?: JourneyBrowser }) {
    if (agent.browser && !agent.browser.collect) return Promise.resolve();
    return this.safely("run_agent_created", async sql => {
      const account = await this.account(sql, agent.tenant, agent.browser ? { consent: agent.browser.consent, gaClientId: agent.browser.gaClientId } : {});
      if (!account.collect) return;
      const unseen = !!(await sql.query("insert into journey_milestones (account_ref, name, at) values ($1, 'run_agent_created', $2) on conflict do nothing", [account.accountRef, Date.now()])).rowCount;
      const first = unseen && (account.sinceSignup || (await sql.query("select count(*)::int as count from agents where tenant = $1", [agent.tenant])).rows[0].count <= 1);
      await enqueue(sql, "run_agent_created", { is_first: first, created_via: agent.via },
        { accountRef: account.accountRef, visitor: agent.browser?.visitor ?? null, internal: account.internal, consent: account.consent, gaClientId: account.gaClientId });
    });
  }

  /**
   * A run ended, at `at`: the account was active that UTC day (`run_active_day`, once a day, a mark and no count),
   * and if it `completed` (it ended with its answer: not an error, nor stopped short) and is the first of an
   * account made while journey events were on, that is its `run_first_execution_completed`. An older account's
   * first run cannot be known, so it has none. Called for every run, and may be called again for one: both are once
   * by their keys.
   */
  async runEnded(tenant: string, run: { completed: boolean; at?: number }) {
    const at = run.at ?? Date.now(), day = new Date(at).toISOString().slice(0, 10);
    const known = this.runs.get(tenant);
    if (known && known.day === day && (known.first || !run.completed) && (known.until === undefined || known.until > Date.now())) return;
    await this.safely("run_active_day", async sql => {
      const account = await this.account(sql, tenant);
      if (this.runs.size > 20_000) this.runs.clear();
      if (!account.collect) { this.runs.set(tenant, { day, first: true, until: Date.now() + UNRECORDED_MS }); return; }
      const mark = async (name: string) => !!(await sql.query("insert into journey_milestones (account_ref, name, at) values ($1, $2, $3) on conflict do nothing", [account.accountRef, name, at])).rowCount;
      const about = { accountRef: account.accountRef, visitor: null, internal: account.internal, consent: account.consent, at, gaClientId: account.gaClientId };
      if (await mark(`run_active_day:${day}`)) await enqueue(sql, "run_active_day", { activity_date: day }, { ...about, key: `run_active_day:${account.accountRef}:${day}` });
      // An account from before journey events is done with firsts: which run was its first is not known.
      let first = !account.sinceSignup || !!known?.first;
      if (!first && run.completed) {
        first = true;
        if (await mark("run_first_execution_completed")) {
          const made = (await sql.query("select created_at from tenants where id = $1", [tenant])).rows[0]?.created_at;
          await enqueue(sql, "run_first_execution_completed", made === undefined ? {} : { seconds_since_signup: Math.max(0, Math.floor((at - Number(made)) / 1000)) },
            { ...about, key: `run_first_execution_completed:${account.accountRef}` });
        }
      } else if (!first) first = !!(await sql.query("select 1 from journey_milestones where account_ref = $1 and name = 'run_first_execution_completed'", [account.accountRef])).rowCount;
      this.runs.set(tenant, { day, first });
    });
  }

  /**
   * A card check granted an account its starting credit: called in the transaction that granted it. Once an account,
   * since a card is checked once. Like every event of a payment's, under a savepoint (`within`).
   */
  cardVerified(sql: Sql, tenant: string) {
    return this.within(sql, "run_card_verified", async () => {
      const account = await this.account(sql, tenant);
      if (account.collect) await enqueue(sql, "run_card_verified", {}, { accountRef: account.accountRef, visitor: null, internal: account.internal, consent: account.consent, key: `run_card_verified:${account.accountRef}`, gaClientId: account.gaClientId });
    });
  }

  /** Stripe gave a Checkout session for buying credit (`amountMinor` cents of it, the fee aside): once a session, however often it is asked for again. */
  checkoutStarted(checkout: { tenant: string; amountMinor: number; session: string; browser?: JourneyBrowser }) {
    if (checkout.browser && !checkout.browser.collect) return Promise.resolve();
    return this.safely("run_checkout_started", async sql => {
      const account = await this.account(sql, checkout.tenant, checkout.browser ? { consent: checkout.browser.consent, gaClientId: checkout.browser.gaClientId } : {});
      if (account.collect) await enqueue(sql, "run_checkout_started", { amount_minor: checkout.amountMinor, currency: "USD" },
        { accountRef: account.accountRef, visitor: checkout.browser?.visitor ?? null, internal: account.internal, consent: account.consent, key: `run_checkout_started:${checkout.session}`, gaClientId: account.gaClientId });
    });
  }

  /**
   * Credit was paid for, by Checkout or an automatic top-up: called in the transaction that added it to the ledger,
   * and only when it did (a payment told of twice adds once). `amountMinor` is the credit in cents, the fee aside;
   * `payment` is Stripe's id for it, by which the store knows one purchase from another. `is_first` as for a token:
   * known for an account made while journey events were on; for an older one, true only if this is its only purchase.
   */
  creditPurchased(sql: Sql, purchase: { tenant: string; amountMinor: number; payment: string }) {
    return this.within(sql, "run_credit_purchased", async () => {
      if (!/^(pi|cs|in|ch)_[A-Za-z0-9_]{1,180}$/.test(purchase.payment) || !Number.isSafeInteger(purchase.amountMinor) || purchase.amountMinor < 0) throw new Error("not a payment the store can be told of");
      const account = await this.account(sql, purchase.tenant);
      if (!account.collect) return;
      const unseen = !!(await sql.query("insert into journey_milestones (account_ref, name, at) values ($1, 'run_credit_purchased', $2) on conflict do nothing", [account.accountRef, Date.now()])).rowCount;
      const first = unseen && (account.sinceSignup || (await sql.query("select count(*)::int as count from credit_ledger where tenant = $1 and kind = 'purchase'", [purchase.tenant])).rows[0].count <= 1);
      await enqueue(sql, "run_credit_purchased", { amount_minor: purchase.amountMinor, currency: "USD", is_first: first, transaction_ref: purchase.payment },
        { accountRef: account.accountRef, visitor: null, internal: account.internal, consent: account.consent, key: `run_credit_purchased:${purchase.payment}`, gaClientId: account.gaClientId });
    });
  }

  /** Automatic top-up was switched on (again, if it had been off): called in the transaction that did. */
  autoTopupEnabled(sql: Sql, tenant: string) {
    return this.within(sql, "run_auto_topup_enabled", async () => {
      const account = await this.account(sql, tenant);
      if (account.collect) await enqueue(sql, "run_auto_topup_enabled", {}, { accountRef: account.accountRef, visitor: null, internal: account.internal, consent: account.consent, gaClientId: account.gaClientId });
    });
  }

  /**
   * What the store holds of an account, for its export: a page at a time of its `events` or its `touches`, until
   * there are no more, each with the store's summary of the account (how it was acquired). Asked as deliveries are
   * sent, signed; `accountRef` is the caller's to choose, from the account it authenticated, never a request's. A
   * store that cannot be asked, or answers anything but what was asked, fails the export: it is whole or it fails.
   */
  async *stored(accountRef: string, kind: "events" | "touches"): AsyncGenerator<{ status: "ok" | "not_found" | "deleted"; account: unknown; consent: unknown; records: unknown[]; googleCopies: unknown[] }> {
    for (let cursor: { at: number; id: string } | undefined, pages = 0; ; pages++) {
      if (pages > 10_000) throw new Error("The journey store's export does not end");
      const body = JSON.stringify({ schema_version: JOURNEY_SCHEMA_VERSION, account_ref: accountRef, kind, ...(cursor ? { cursor } : {}) });
      const response = await (this.options.fetch ?? fetch)(new URL(JOURNEY_EXPORT_PATH, this.options.url), {
        method: "POST", body, redirect: "error", signal: AbortSignal.timeout(30_000),
        headers: { "Content-Type": "application/json", ...signedHeaders(randomUUID(), body, [this.options.secret]) },
      });
      const answer = await response.json().catch(() => undefined) as { status?: unknown; kind?: unknown; account?: unknown; consent?: unknown; events?: unknown; touches?: unknown; ga4_copies?: unknown; next_cursor?: { at?: unknown; id?: unknown } | null } | undefined;
      const records = kind === "events" ? answer?.events : answer?.touches, next = answer?.next_cursor;
      if (!response.ok || answer?.kind !== kind || !["ok", "not_found", "deleted"].includes(answer.status as string) || !Array.isArray(records)
        || (next != null && (!Number.isSafeInteger(next.at) || typeof next.id !== "string"))) throw new Error(`The journey store did not give the account's ${kind} (${response.ok ? "an answer that is not one" : `HTTP ${response.status}`})`);
      // With its events the store gives what it prepared or sent to Google of them: the account's too, and part of what it holds.
      yield { status: answer.status as "ok" | "not_found" | "deleted", account: answer.account ?? null, consent: answer.consent ?? null, records, googleCopies: Array.isArray(answer.ga4_copies) ? answer.ga4_copies : [] };
      if (next == null) return;
      cursor = { at: next.at as number, id: next.id as string };
    }
  }

  /** Write an event in a transaction of the caller's, under a savepoint: a fault loses the event and is logged, and what the transaction is for (a payment) goes on untouched. */
  private async within(sql: Sql, event: JourneyEventName, write: () => Promise<unknown>) {
    await sql.query("savepoint journey_event");
    try {
      await write();
      await sql.query("release savepoint journey_event");
    } catch (error) {
      await sql.query("rollback to savepoint journey_event");
      console.error(JSON.stringify({ type: "journey_event_failed", event, error: safeError(error) }));
    }
  }

  /** Write an event in a transaction of its own; a fault is logged and the caller carries on, since what the event describes already happened. */
  private async safely(event: JourneyEventName, write: (sql: Sql) => Promise<unknown>) {
    try { await transaction(this.db, write); }
    catch (error) { console.error(JSON.stringify({ type: "journey_event_failed", event, error: safeError(error) })); }
  }

  /**
   * Accounts made by a sign-in or an email sign-up since journey events were first on that have no journey row: the fault that
   * lost their event (`accountCreated`) left them so. Each gets its row. One whose sign-up was noted aside
   * gets its `run_account_created` too, as of when it was made and as its browser allowed. One with no
   * note gets no event, ever: what its browser said is not known, and it may have refused. Returns how many were found.
   */
  async reconcile(now = Date.now()) {
    await this.db.query("insert into journey_state (enabled_at) values ($1) on conflict do nothing", [now]);
    const { rows } = await this.db.query(`
      select t.id, t.created_at, t.google_email, l.consent, l.visitor, l.method, l.surface from tenants t left join journey_lost_signups l on l.tenant = t.id
      where t.created_at >= (select enabled_at from journey_state) and t.created_at < $1 and (t.github_id is not null or t.google_sub is not null or t.email_signup)
        and not exists (select 1 from journey_accounts a where a.tenant = t.id)
      order by t.created_at limit 100`, [now - RECONCILE_AFTER_MS]);
    let found = 0, sent = 0;
    for (const row of rows as { id: string; created_at: number; google_email: string | null; consent: JourneyConsent | null; visitor: string | null; method: JourneyMethod | null; surface: JourneySurface | null }[]) {
      await this.safely("run_account_created", async sql => {
        const account = await this.account(sql, row.id, { email: row.google_email ?? undefined, consent: row.consent ?? "lost", signup: { visitor: row.visitor } });
        if (row.consent && account.collect) {
          sent++;
          await enqueue(sql, "run_account_created", { method: row.method!, auth_surface: row.surface! },
            { accountRef: account.accountRef, visitor: row.visitor, internal: account.internal, consent: account.consent, key: `run_account_created:${account.accountRef}`, at: Number(row.created_at) });
        }
        await sql.query("delete from journey_lost_signups where tenant = $1", [row.id]);
        found++;
      });
    }
    if (found) console.error(JSON.stringify({ type: "journey_accounts_reconciled", count: found, sent }));
    await this.db.query("delete from journey_milestones where name like 'run\\_active\\_day:%' and at < $1", [now - ACTIVE_DAY_KEPT_MS]);
    return found;
  }

  start(intervalMs = 5_000, reconcileMs = 10 * 60_000) {
    if (this.timers.length) return;
    const every = (ms: number, type: string, work: () => Promise<unknown>) => {
      const timer = setInterval(() => void work().catch(error => console.error(JSON.stringify({ type, error: safeError(error) }))), ms);
      timer.unref();
      this.timers.push(timer);
    };
    every(intervalMs, "journey_scan_failed", () => this.send());
    every(reconcileMs, "journey_reconcile_failed", () => this.reconcile());
    void this.reconcile().catch(error => console.error(JSON.stringify({ type: "journey_reconcile_failed", error: safeError(error) })));
  }
  stop() { for (const timer of this.timers) clearInterval(timer); this.timers = []; }

  /** Deliveries waiting to be sent, how many of them the store has refused, and how long the oldest has waited. */
  async backlog(now = Date.now()) {
    const row = (await this.db.query("select count(*)::int as pending, count(*) filter (where rejected_at is not null)::int as rejected, min(created_at) as oldest from journey_outbox")).rows[0];
    return { pending: row.pending as number, rejected: row.rejected as number, oldestAgeMs: row.oldest === null ? 0 : Math.max(0, now - Number(row.oldest)) };
  }

  /** Send every due delivery, one per request, claiming batches so no two nodes send one at once. */
  async send(now = Date.now()) {
    if (this.sending) return;
    this.sending = true;
    try {
      // Never a deletion nor a refusal: the store must hear of both however long that takes.
      const dropped = await this.db.query("delete from journey_outbox where created_at < $1 and target <> 'consent' and (target <> 'events' or body->>'name' <> $2) returning id", [now - MAX_AGE_MS, DELETED]);
      if (dropped.rowCount) console.error(JSON.stringify({ type: "journey_events_dropped", count: dropped.rowCount }));
      for (;;) {
        const { rows } = await this.db.query(`
          update journey_outbox set due = $2, attempts = attempts + 1
          where id in (select id from journey_outbox where due <= $1 order by due limit ${CLAIM_BATCH} for update skip locked)
          returning id, target, body, attempts`, [now, Date.now() + LEASE_MS]);
        await Promise.all(rows.map(row => this.deliver(row)));
        if (rows.length < CLAIM_BATCH) break;
      }
    } finally { this.sending = false; }
  }

  private async deliver(row: { id: string; target: "events" | "resolve" | "consent"; body: any; attempts: number }) {
    const events = row.target === "events", what = events ? row.body.name as string : row.target === "consent" ? "refusal" : "touch";
    const body = JSON.stringify(events ? { schema_version: JOURNEY_SCHEMA_VERSION, events: [row.body] } : row.body);
    let failure: string, refused = false;
    try {
      const response = await (this.options.fetch ?? fetch)(new URL(events ? JOURNEY_EVENTS_PATH : row.target === "consent" ? JOURNEY_CONSENT_PATH : JOURNEY_RESOLVE_PATH, this.options.url), {
        method: "POST", body, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { "Content-Type": "application/json", ...signedHeaders(row.id, body, [this.options.secret]) },
      });
      const answer = await response.json().catch(() => undefined) as { accepted?: unknown; duplicates?: unknown; attribution_id?: unknown } | undefined;
      // Taken only when the store names what it took: a 200 from something in between (a proxy's page) is not the store's word.
      const taken = row.target === "resolve" ? answer?.attribution_id === row.body.attribution_id : [answer?.accepted, answer?.duplicates].some(ids => Array.isArray(ids) && ids.includes(row.id));
      if (response.ok && taken) {
        await this.db.query("delete from journey_outbox where id = $1", [row.id]);
        return;
      }
      failure = response.ok ? "not acknowledged" : `HTTP ${response.status}`;
      // The store read it and refused it: sending it again now would be refused again. A deletion and a refusal are the exceptions, asked as often as anything else.
      refused = (response.status === 400 || response.status === 422) && what !== DELETED && row.target !== "consent";
    } catch (error) { failure = safeError(error); }
    // The store down, a wrong secret or a rate limit is tried again soon; a refusal once a day, in case the store has learned to read it. Each says so.
    const delay = refused ? REJECTED_RETRY_MS : Math.min(60 * 60_000, this.retryBaseMs * 2 ** Math.min(row.attempts - 1, 20));
    await this.db.query("update journey_outbox set due = $2, last_error = $3, rejected_at = case when $4::boolean then $5::bigint else rejected_at end where id = $1", [row.id, Date.now() + delay, failure.slice(0, 500), refused, Date.now()]);
    console.error(JSON.stringify({ type: refused ? "journey_event_rejected" : "journey_delivery_failed", event: what, id: row.id, attempts: row.attempts, error: failure.slice(0, 200) }));
  }
}

/** Pages a browser may report a minute: the console sends one a page, so this is far past a person and well short of a flood. */
export const JOURNEY_PAGES_PER_MINUTE = 120;

/**
 * `POST /api/journey/events`: the console's own pages, from its own origin (`auth` is the console's sign-in: a
 * request a page of ours made, and whose session it carries, if any). Mounted only where journey events are on.
 * Each source (`source`: the caller's address as the rate limits know it) may report JOURNEY_PAGES_PER_MINUTE pages
 * a minute, counted on this node and in memory: past it the answer is 429, and nothing is written.
 */
export function journeyApp(journey: Journey, auth: { allowsMutation(request: Request): boolean; principal(request: Request): Promise<{ tenant: string } | undefined> }, source: (c: Context) => string | undefined = () => undefined, now: () => number = Date.now) {
  const app = new Hono();
  const counts = new Map<string, { pages: number; until: number }>();
  app.post("/api/journey/events", async c => {
    c.header("Cache-Control", "no-store");
    if (!auth.allowsMutation(c.req.raw)) return c.json({ error: "Forbidden" }, 403);
    let body: unknown;
    try { body = JSON.parse(await readText(c.req.raw.body, 32 * 1024)); }
    catch { return c.json({ error: "invalid_json" }, 400); }
    const events = (body as { events?: unknown } | null)?.events;
    const key = source(c) ?? "unknown", at = now();
    if (counts.size > 50_000) for (const [name, count] of counts) if (count.until <= at) counts.delete(name);
    let count = counts.get(key);
    if (!count || count.until <= at) counts.set(key, count = { pages: 0, until: at + 60_000 });
    count.pages += Array.isArray(events) ? Math.max(1, events.length) : 1;
    if (count.pages > JOURNEY_PAGES_PER_MINUTE) {
      c.header("Retry-After", String(Math.max(1, Math.ceil((count.until - at) / 1000))));
      return c.json({ error: "rate_limited" }, 429);
    }
    const result = await journey.pagesViewed(c.req.raw, (await auth.principal(c.req.raw))?.tenant, body);
    return c.json(result.body, result.status);
  });
  return app;
}
