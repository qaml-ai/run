import { transaction, type Db, type Sql } from "./db.ts";

/**
 * What the admin site's tabs (src/admin-site.ts: growth, usage, revenue, health) share: which accounts they count, the
 * UTC days a request covers, and one read-only snapshot to read them in.
 */

export const DAY_MS = 86_400_000;
export const ADMIN_WINDOW_DAYS = [7, 30, 90] as const;
export const ADMIN_MAX_WINDOW_DAYS = 365;

/** A self-serve account: one someone made for themselves (GitHub, Google or email), not one an operator made. `t` is `tenants`. */
export const SELF_SERVE = "(t.github_id is not null or t.github is not null or t.google_sub is not null or t.email_signup)";

/**
 * A counted account (`t` is `tenants`): not being or already erased, and not the operator's own staff as far as anything
 * here knows: journey events' `internal` mark, or a Google or password address at one of the operator's own domains
 * (`domains`, the placeholder of a text[] of lower-case domains). Staff who sign in with GitHub are counted until journey
 * events mark them.
 */
export const counted = (domains: string) => `(not exists (select 1 from account_deletions d where d.tenant = t.id) and not ${staff(domains)})`;

/** The operator's own staff (`t` is `tenants`), as `counted` knows them. */
export const staff = (domains: string) => `(exists (select 1 from journey_accounts j where j.tenant = t.id and j.internal)
  or coalesce(lower(split_part(t.google_email, '@', 2)) = any(${domains}), false)
  or exists (select 1 from tenant_passwords p where p.tenant = t.id and lower(split_part(p.email, '@', 2)) = any(${domains})))`;

/** How an account signed up, as SQL over `t`: the first of its identities that made it self-serve. */
export const SIGN_IN = "case when t.github_id is not null or t.github is not null then 'github' when t.google_sub is not null then 'google' when t.email_signup then 'email' end";

/**
 * Who an account is to the operator. `self_serve`: someone signed up. `operator_made`: an operator made it
 * (POST /v1/tenants). `operator`: an admin tenant of the tenants file, which has no `tenants` row (camelBot, say).
 */
export type AdminAccountKind = "self_serve" | "operator_made" | "operator";

/** An account as the tabs name it: its GitHub login or Google address, else its id. Amounts are micro-USD. */
export interface AdminAccountName { tenant: string; name: string; kind: AdminAccountKind; sign_in: "github" | "google" | "email" | null; signed_up_at: string | null }

/** Columns naming an account, for a query joining `tenants t` (left join: `t.id` null is an admin tenant). */
export const NAME_COLUMNS = `t.id is not null as known, t.github, t.google_email, ${SIGN_IN} as sign_in, t.created_at,
  (select p.email from tenant_passwords p where p.tenant = t.id) as password_email`;

export function accountName(tenant: string, row: { known: boolean; github: string | null; google_email: string | null; sign_in: string | null; created_at: unknown; password_email?: string | null }): AdminAccountName {
  const kind: AdminAccountKind = !row.known ? "operator" : row.sign_in ? "self_serve" : "operator_made";
  return {
    tenant, name: row.github ?? row.google_email ?? row.password_email ?? tenant, kind,
    sign_in: (row.sign_in as AdminAccountName["sign_in"]) ?? null,
    signed_up_at: row.known && row.created_at !== null ? new Date(Number(row.created_at)).toISOString() : null,
  };
}

/**
 * The UTC days a tab covers: the `days` days that end today (today still going: `incomplete_date`), and the as many
 * days before them that its figures are compared with.
 */
export interface AdminWindow { days: number; start_date: string; end_date: string; previous_start_date: string; incomplete_date: string; time_zone: "UTC" }

export class AdminWindowError extends Error {
  status = 400 as const;
  constructor() { super("days must be a whole number from 1 to 365"); }
}

export const utcDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const startOfUtcDay = (ms: number) => ms - ms % DAY_MS;

export function adminWindow(days: unknown, now = Date.now()): AdminWindow & { from: number; previousFrom: number; until: number } {
  const count = typeof days === "string" && /^\d{1,3}$/.test(days) ? Number(days) : days;
  if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > ADMIN_MAX_WINDOW_DAYS) throw new AdminWindowError();
  const today = startOfUtcDay(now), from = today - (count - 1) * DAY_MS, previousFrom = from - count * DAY_MS;
  return {
    days: count, start_date: utcDate(from), end_date: utcDate(today), previous_start_date: utcDate(previousFrom), incomplete_date: utcDate(today), time_zone: "UTC",
    from, previousFrom, until: today + DAY_MS,
  };
}

/** The window as the response carries it, without the instants it was computed from. */
export const windowOf = ({ days, start_date, end_date, previous_start_date, incomplete_date, time_zone }: AdminWindow): AdminWindow =>
  ({ days, start_date, end_date, previous_start_date, incomplete_date, time_zone });

/** Each date of the window, oldest first. */
export const windowDates = (window: { from: number; days: number }) => Array.from({ length: window.days }, (_, day) => utcDate(window.from + day * DAY_MS));

/**
 * What a `usage` row (`u`) counts, by its model (src/accounts.ts `collectUsage`): a model's responses, a compaction's
 * (`compaction:`), a transcription's (`transcription:`) or images' (`image:`), web searches (`<provider>/web_search`),
 * X searches (`xai/x_search`), page renders (`firecrawl/web_fetch`) or tool searches (`runtime/tool_search`).
 */
export const usageKind = (u = "u") => `case when ${u}.model like 'compaction:%' then 'compaction' when ${u}.model like 'transcription:%' then 'voice'
  when ${u}.model like 'image:%' then 'images' when ${u}.model like '%/web\\_search' or ${u}.model in ('firecrawl/web_fetch', 'xai/x_search') then 'web'
  when ${u}.model = 'runtime/tool_search' then 'tool_search' else 'models' end`;
export type AdminUsageKind = "models" | "compaction" | "voice" | "images" | "web" | "tool_search";
/** A `usage` row (`u`) of a model's responses to an agent's turns. */
export const modelCall = (u = "u") => `((${usageKind(u)}) = 'models')`;
export const MODEL_CALL = modelCall();
/**
 * An agent (`a`) that is one, at the instant the placeholder `now` holds: live, not a stateless run's session
 * (POST /v1/runs) and not a child a delegate call made.
 */
export const liveAgent = (now: string) => `(not a.revoked and a.purged_at is null and (a.expires_at is null or a.expires_at > ${now})
  and a.header->'run' is null and a.header->'parent' is null)`;

/** A figure in the window and in as many days before it. */
export interface AdminCompare { current: number; previous: number }

/**
 * One consistent read: on separate pool connections, a usage flush that commits mid-read shows in some figures and not
 * others. Queries `work` starts together run one after another on the transaction's connection, as it can only run one.
 */
export function snapshot<T>(db: Db, work: (sql: Sql) => Promise<T>) {
  return transaction(db, async sql => {
    await sql.query("set transaction isolation level repeatable read, read only");
    let last: Promise<unknown> = Promise.resolve();
    return work({
      query(text, values) {
        const next = last.then(() => sql.query(text, values));
        last = next.catch(() => undefined);
        return next;
      },
    });
  });
}

export const n = (value: unknown) => Number(value ?? 0);
