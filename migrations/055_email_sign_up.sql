-- Self-serve email and password accounts (src/email-accounts.ts): links mailed to an address, one row each, keyed by
-- the SHA-256 of the link's random token (the token itself is only in the mail). A link works once and until it expires.
--   verify: finishes a sign-up. `hash` is the password chosen at sign-up; the tenant is made only when the link is
--           followed with that password, so an unverified sign-up has no tenant and cannot sign in.
--   add:    gives `tenant`, an account without a password, this address and the password `hash`, the same way.
--   reset:  sets a new password for `tenant`, while it still signs in with `email`.
-- `next` is where the person goes afterwards (the MCP consent page they signed up from). Rows are swept once expired;
-- a tenant's go with it when the account is deleted.
create table account_email_links (
  sha256 text primary key,
  purpose text not null check (purpose in ('verify', 'add', 'reset')),
  email text not null,
  tenant text,
  hash text,
  next text,
  created_at bigint not null,
  expires_at bigint not null,
  check ((purpose = 'verify') = (tenant is null)),
  check ((purpose = 'reset') = (hash is null))
);
create index account_email_links_email on account_email_links (email);
create index account_email_links_tenant on account_email_links (tenant) where tenant is not null;
create index account_email_links_expires on account_email_links (expires_at);

-- A sign-up or reset for a Google account's address mails its owner to sign in with Google instead (no second account).
create index tenants_google_email on tenants (lower(google_email)) where google_email is not null;
