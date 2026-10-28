-- Where a self-serve account came from (src/signup-source.ts): the `ref` of the link that opened the console and the
-- host of the site the browser came from, kept once when a sign-in or an email sign-up makes the account. `{}` when it
-- showed neither; null for accounts made before this, or by an operator.
alter table tenants add column signup_source jsonb;
-- An email sign-up's, with its mailed link until following it makes the account.
alter table account_email_links add column signup_source jsonb;
