-- Admin tenants linked to a GitHub login (the tenants file's `github`) are bound to the numeric id of the first
-- account to sign in with it (Accounts.tenantForGithub), so whoever later takes a freed or renamed login does not
-- get the tenant. `login` is the entry's login when bound: an admin who changes it rebinds the tenant.
create table admin_github_bindings (
  tenant text primary key,
  github_id bigint not null,
  login text not null,
  bound_at bigint not null
);
create index admin_github_bindings_github_id on admin_github_bindings (github_id);
