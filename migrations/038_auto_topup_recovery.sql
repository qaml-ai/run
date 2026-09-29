alter table billing_auto_attempts add column cancel_requested boolean not null default false;
alter table billing_auto_attempts add column action_expires_at bigint;
update billing_auto_attempts set action_expires_at=(extract(epoch from clock_timestamp())*1000)::bigint+86400000 where state='action_required';
create index billing_auto_scan on billing_auto_settings (checked_at) where enabled;
