-- Self-serve tenants are tied to a GitHub account by its numeric id, which survives
-- a login rename (the `github` login column follows the account's current login).
-- Tenants from before this get theirs at their next sign-in.
alter table tenants add column github_id bigint;
create unique index tenants_github_id on tenants (github_id);
-- Free-credit tenants' spend in the last hour.
create index credit_ledger_usage_time on credit_ledger (tenant, created_at) where kind = 'usage';
