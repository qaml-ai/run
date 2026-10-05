-- Email and password sign-in (src/passwords.ts): an operator gives a tenant an address and a password; there is no
-- sign-up. `hash` is scrypt with its salt and parameters. Admin tenants (the tenants file's) have no `tenants` row, so
-- there is no foreign key; account deletion removes the row with the tenant's others.
create table tenant_passwords (
  tenant text primary key,
  email text not null unique,
  hash text not null,
  set_at bigint not null
);

-- Console sessions are made by GitHub, Google or a password: signing in with a token is gone, and its sessions end.
-- 'token' (with token_id and operator_sha256) stays allowed only while nodes from before this release roll out.
alter table console_sessions drop constraint console_sessions_method_check;
alter table console_sessions add constraint console_sessions_method_check check (method in ('github', 'google', 'password', 'token'));
delete from console_sessions where method = 'token';
