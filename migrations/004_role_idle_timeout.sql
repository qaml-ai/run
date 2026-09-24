-- Bound transactions left idle by a hung node (log compaction holds an advisory
-- lock and a row lock on the actor across its S3 write). Set on the role rather
-- than with SET LOCAL per transaction: through RDS Proxy a SET pins the session.
-- The role is shared by every schema, so serialize and skip when already set.
do $$ begin
  perform pg_advisory_xact_lock(hashtext('agent-runtime:role-settings'));
  if not exists (
    select from pg_db_role_setting s join pg_roles r on r.oid = s.setrole
    where r.rolname = current_user and s.setdatabase = 0
      and 'idle_in_transaction_session_timeout=30s' = any (s.setconfig)
  ) then
    execute format('alter role %I set idle_in_transaction_session_timeout = %L', current_user, '30s');
  end if;
end $$;
