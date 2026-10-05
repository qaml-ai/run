import { createHash, randomBytes } from "node:crypto";
import type { Accounts } from "./accounts.ts";
import type { AccountMail } from "./account-mail.ts";
import { transaction, type Sql } from "./db.ts";
import { HttpError } from "./http.ts";
import { checkNewPassword, hashPassword, verifyPassword } from "./passwords.ts";

/**
 * Self-serve email and password accounts, where account mail is configured (src/account-mail.ts): sign-up, a password
 * reset, and adding a password to an account that signs in with GitHub or Google. Each mails a link whose token is
 * random, kept only as its SHA-256 (`account_email_links`), works once and expires.
 *
 * - Sign-up (only with open sign-up) keeps the chosen password's hash with the link. Following the link and entering
 *   that password makes the tenant, with its password, and signs in: a sign-up nobody verified has no tenant and no
 *   sign-in, and someone who signs up with another person's address cannot finish without that mailbox, nor can its
 *   owner, by following the link, finish an account whose password someone else chose.
 * - Requests answer the same whether or not the address has an account; what differs is only the mail it gets. An
 *   address with an account is told someone tried to sign up; one a Google account signed up with is told to sign in
 *   with Google (email sign-up never joins or takes over a GitHub or Google account; GitHub addresses are not known here,
 *   so an email sign-up with one is an account of its own).
 * - A reset link sets a new password while the tenant still signs in with that address, and ends its password sessions.
 * Mail goes out in the background (AccountMail), so a request takes as long whichever mail it sends.
 */
export const VERIFY_MS = 24 * 3600_000;
export const RESET_MS = 3600_000;
/** What following a link that expired, was used, or never existed says. */
export const LINK_GONE = "This link has expired or was already used";
export type LinkPurpose = "verify" | "add" | "reset";
type Link = { purpose: LinkPurpose; email: string; tenant: string | null; hash: string | null; next: string | null };

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export interface EmailAccountsOptions {
  accounts: Accounts;
  mail: AccountMail;
  /** AGENT_OPEN_SIGNUP: whether anyone may sign up (as with GitHub and Google). Resets and adding a password need only mail. */
  openSignup: boolean;
  now?: () => number;
}

export class EmailAccounts {
  private readonly options: EmailAccountsOptions;
  private readonly now: () => number;
  private swept = 0;
  constructor(options: EmailAccountsOptions) { this.options = options; this.now = options.now ?? Date.now; }

  get signup() { return this.options.openSignup; }
  private get db() { return this.options.accounts.db; }
  private link(purpose: LinkPurpose, token: string) { return `${this.options.mail.config.origin}/console/${purpose === "reset" ? "reset" : "verify"}#${token}`; }

  /** A new link's token, stored as its hash; expired links go now and then. */
  private async store(sql: Sql, link: Omit<Link, "next"> & { next?: string }) {
    const token = randomBytes(32).toString("base64url"), now = this.now();
    await sql.query("insert into account_email_links (sha256, purpose, email, tenant, hash, next, created_at, expires_at) values ($1, $2, $3, $4, $5, $6, $7, $8)",
      [sha256(token), link.purpose, link.email, link.tenant, link.hash, link.next ?? null, now, now + (link.purpose === "reset" ? RESET_MS : VERIFY_MS)]);
    if (now - this.swept > 60_000) {
      this.swept = now;
      await this.db.query("delete from account_email_links where expires_at < $1", [now]).catch(() => {});
    }
    return token;
  }

  private async passwordTenant(email: string): Promise<string | undefined> {
    const tenant = (await this.db.query("select tenant from tenant_passwords where email = $1", [email])).rows[0]?.tenant;
    return tenant && await this.options.accounts.exists(tenant) ? tenant : undefined;
  }

  /** Whether a tenant made by Google sign-in has `email` as its (Google-verified) address. */
  private async googleAddress(email: string) {
    return !!(await this.db.query(`select 1 from tenants t where lower(google_email) = $1
      and not exists (select 1 from account_deletions d where d.tenant = t.id) limit 1`, [email])).rowCount;
  }

  /**
   * Sign up `email` (normalized) with `password`: mail a link that finishes it, or, where the address already has an
   * account, mail its owner instead. The caller answers the same either way. The password is checked and hashed first,
   * whatever the address, so every request takes as long.
   */
  async signUp(email: string, password: unknown, next?: string) {
    if (!this.signup) throw new HttpError(404, "Sign-up is not open on this runtime");
    const hash = await hashPassword(checkNewPassword(password, email));
    if (await this.passwordTenant(email)) return this.options.mail.send("exists", email);
    if (await this.googleAddress(email)) return this.options.mail.send("google", email);
    const token = await this.store(this.db, { purpose: "verify", email, tenant: null, hash, next });
    this.options.mail.send("verify", email, this.link("verify", token));
  }

  /** What a link is for and the address it went to, while it works; the page asks for the right thing. */
  async inspect(token: unknown): Promise<{ purpose: LinkPurpose; email: string } | undefined> {
    if (typeof token !== "string" || !TOKEN.test(token)) return undefined;
    const row = (await this.db.query("select purpose, email from account_email_links where sha256 = $1 and expires_at > $2", [sha256(token), this.now()])).rows[0];
    return row ? { purpose: row.purpose, email: row.email } : undefined;
  }

  /**
   * Finish a sign-up (`verify`) or adding a password (`add`) with the password chosen for it: the link is used up, and
   * the address and password sign in to the new tenant, or to the one that asked. `wrong` when the password is not that
   * one (the link still works). `admit` is the sign-up rate limit, counted in the transaction that makes the tenant.
   */
  async complete(token: unknown, password: unknown, admit?: (sql: Sql) => Promise<void>, created?: (sql: Sql, tenant: string) => Promise<void>): Promise<{ tenant: string; email: string; next?: string } | { wrong: true; email: string }> {
    if (typeof token !== "string" || !TOKEN.test(token)) throw new HttpError(400, LINK_GONE);
    const key = sha256(token);
    const link = (await this.db.query("select purpose, email, tenant, hash, next from account_email_links where sha256 = $1 and expires_at > $2 and purpose <> 'reset'", [key, this.now()])).rows[0] as Link | undefined;
    if (!link) throw new HttpError(400, LINK_GONE);
    if (link.purpose === "verify" && !this.signup) throw new HttpError(403, "Sign-up is closed on this runtime");
    if (link.purpose === "add" && !await this.options.accounts.exists(link.tenant!)) throw new HttpError(400, LINK_GONE);
    if (typeof password !== "string" || !await verifyPassword(password, link.hash!)) return { wrong: true, email: link.email };
    const tenant = await transaction(this.db, async sql => {
      await sql.query("select pg_advisory_xact_lock(hashtext($1))", [`email:${link.email}`]);
      // Used once: of two at the same time, one finds it gone.
      if (!(await sql.query("delete from account_email_links where sha256 = $1 and expires_at > $2", [key, this.now()])).rowCount) throw new HttpError(400, LINK_GONE);
      if ((await sql.query("select 1 from tenant_passwords where email = $1", [link.email])).rowCount) throw new HttpError(409, "This address already has an account; sign in");
      let tenant = link.tenant;
      if (link.purpose === "verify") {
        await admit?.(sql);
        tenant = await this.options.accounts.createEmailTenant(sql);
      } else if ((await sql.query("select 1 from tenant_passwords where tenant = $1", [tenant])).rowCount) {
        throw new HttpError(409, "This account already has a password; change it on the Account page");
      }
      try { await sql.query("insert into tenant_passwords (tenant, email, hash, set_at) values ($1, $2, $3, $4)", [tenant, link.email, link.hash, Date.now()]); }
      catch (error) {
        // An operator gave another account the address meanwhile.
        if ((error as { code?: string }).code === "23505") throw new HttpError(409, "This address already has an account; sign in");
        throw error;
      }
      // Other links for the address (or the account) are moot now.
      await sql.query("delete from account_email_links where purpose <> 'reset' and (email = $1 or tenant = $2)", [link.email, tenant]);
      // A sign-up made an account: `created` hears of it in this transaction, as a sign-in's does (Accounts.tenantForGithub).
      if (link.purpose === "verify") await created?.(sql, tenant!);
      return tenant!;
    });
    return { tenant, email: link.email, ...(link.next ? { next: link.next } : {}) };
  }

  /** Mail `email` (normalized) a link to reset its password, if it signs in with one; a Google account's owner is told to use Google. */
  async requestReset(email: string, next?: string) {
    const tenant = await this.passwordTenant(email);
    if (tenant) {
      // Only the newest reset link works.
      await this.db.query("delete from account_email_links where tenant = $1 and purpose = 'reset'", [tenant]);
      const token = await this.store(this.db, { purpose: "reset", email, tenant, hash: null, next });
      return this.options.mail.send("reset", email, this.link("reset", token));
    }
    if (await this.googleAddress(email)) this.options.mail.send("google", email);
  }

  /**
   * Set a new password with a reset link, while the tenant still signs in with the address it went to. Every password
   * session of the tenant ends.
   */
  async reset(token: unknown, password: unknown): Promise<{ tenant: string; email: string; signedOut: number; next?: string }> {
    if (typeof token !== "string" || !TOKEN.test(token)) throw new HttpError(400, LINK_GONE);
    const link = (await this.db.query("select email, tenant from account_email_links where sha256 = $1 and expires_at > $2 and purpose = 'reset'", [sha256(token), this.now()])).rows[0] as Link | undefined;
    if (!link || !await this.options.accounts.exists(link.tenant!)) throw new HttpError(400, LINK_GONE);
    const hash = await hashPassword(checkNewPassword(password, link.email));
    return transaction(this.db, async sql => {
      const used = (await sql.query("delete from account_email_links where sha256 = $1 and expires_at > $2 and purpose = 'reset' returning tenant, email, next", [sha256(token), this.now()])).rows[0];
      if (!used || !(await sql.query("update tenant_passwords set hash = $3, set_at = $4 where tenant = $1 and email = $2", [used.tenant, used.email, hash, Date.now()])).rowCount) throw new HttpError(400, LINK_GONE);
      await sql.query("delete from account_email_links where tenant = $1 and purpose = 'reset'", [used.tenant]);
      const signedOut = (await sql.query("delete from console_sessions where tenant = $1 and method = 'password'", [used.tenant])).rowCount ?? 0;
      return { tenant: used.tenant, email: used.email, signedOut, ...(used.next ? { next: used.next } : {}) };
    });
  }

  /**
   * Give `tenant`, which has no password, the address `email` (normalized) and `password`. Its own Google address is
   * verified already, and is set at once (`set`); any other gets a link to confirm it, as sign-up does (`sent`), unless
   * another account signs in with it, which its owner is told.
   */
  async add(tenant: string, email: string, password: unknown, googleEmail?: string): Promise<{ set: true; email: string } | { sent: true }> {
    const hash = await hashPassword(checkNewPassword(password, email));
    if ((await this.db.query("select 1 from tenant_passwords where tenant = $1", [tenant])).rowCount) throw new HttpError(409, "This account already has a password; change it instead");
    if (await this.passwordTenant(email)) { this.options.mail.send("taken", email); return { sent: true }; }
    if (googleEmail && googleEmail.toLowerCase() === email) {
      try { await this.db.query("insert into tenant_passwords (tenant, email, hash, set_at) values ($1, $2, $3, $4)", [tenant, email, hash, Date.now()]); }
      catch (error) {
        if ((error as { code?: string }).code === "23505") throw new HttpError(409, "This account already has a password; change it instead");
        throw error;
      }
      return { set: true, email };
    }
    const token = await this.store(this.db, { purpose: "add", email, tenant, hash });
    this.options.mail.send("add", email, this.link("add", token));
    return { sent: true };
  }
}
