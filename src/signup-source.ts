import type { Sql } from "./db.ts";

/**
 * Where a self-serve account came from, as the browser that made it showed it: kept on the account
 * (`tenants.signup_source`) in the transaction that makes it, as camelBot keeps its users' `signup_ref`. The ops
 * dashboard's sources read it (src/admin-acquisition.ts). First-party: no cookie of its own outlives the sign-in, and
 * nothing here is sent anywhere.
 *
 * - `ref`: the tag of the link that opened the console (`/console/?ref=run-slack`). The operator's website tags its
 *   links to the console with the page they are on. Letters, digits, `.`, `_`, `-` and `/`, at most 64, lowercased.
 * - `referrer`: the host of the site the browser came from (the console's `document.referrer`), without `www.`. Not
 *   kept for a browser that asks not to be measured: Global Privacy Control, or the operator's consent cookie saying
 *   `denied` (src/journey.ts).
 *
 * The console sends both when it starts a sign-in (`?ref=&from=` on `/console/auth/github` and `/google`, `ref` and
 * `from` in the body of `/console/auth/signup`). They wait in the sign-in's own cookie, or with the mailed link, until
 * the account is made. `{}` is a sign-up that showed neither: direct. An account made before this was kept, or by an
 * operator, has none.
 */
export type SignupSource = { ref?: string; referrer?: string };

const REF = /^[a-z0-9][a-z0-9._/-]{0,63}$/;
const HOST = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** What a sign-in's `ref` and `from` say, with anything else dropped; the referrer not at all for a browser that refused. */
export function signupSource(input: { ref?: unknown; from?: unknown }, refused = false): SignupSource {
  const ref = typeof input.ref === "string" ? input.ref.toLowerCase() : "";
  const host = typeof input.from === "string" ? input.from.toLowerCase().replace(/^www\./, "") : "";
  return { ...(REF.test(ref) ? { ref } : {}), ...(!refused && HOST.test(host) ? { referrer: host } : {}) };
}

/** The source a sign-in's cookie or a mailed link kept, checked again; undefined for none. */
export function keptSignupSource(value: unknown): SignupSource | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { ref, referrer } = value as { ref?: unknown; referrer?: unknown };
  return signupSource({ ref, from: referrer });
}

/** Keep where a new account came from, in the transaction that made it. Once: a source is never rewritten. */
export async function recordSignupSource(sql: Sql, tenant: string, source: SignupSource) {
  await sql.query("update tenants set signup_source = $2::jsonb where id = $1 and signup_source is null", [tenant, JSON.stringify(source)]);
}
