-- Daily raw-cost pools shared by matching buckets of one end user.
alter table end_user_settings add column shared_allowances jsonb not null default '{}';
alter table end_users add column shared_allowances jsonb not null default '{}';
