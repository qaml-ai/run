// Source journey erasure/export SQL; only the host types are narrowed.
import { createHash, randomUUID } from "node:crypto";
import type { Db, Sql } from "./postgres.ts";
const JOURNEY_SCHEMA_VERSION = 1;
const DELETED = "run_account_deleted";
type About = { accountRef: string | null; visitor: string | null; internal: boolean; consent: string; key?: string; id?: string; at?: number; gaClientId?: string; page?: { host: string; path: string; referrer: string | null } };
type JourneyEventName = string;
type JourneyProperties = Record<string, Record<string, unknown>>;
type JourneyEvent<Name extends string = string> = Record<string, unknown> & { event_id: string; name: Name };
function keyedId(key: string) {
  const hex = createHash("sha256").update(key).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${(parseInt(hex[16]!, 16) & 3 | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}


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
