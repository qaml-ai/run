alter table billing_auto_settings drop constraint billing_auto_settings_status_check;
alter table billing_auto_settings add check (status in ('on','paused_no_card','paused_expired','limit_reached'));
alter table billing_auto_settings add column limit_resets_at bigint;
alter table billing_auto_attempts add column cancel_reason text check (cancel_reason in ('disabled','expired'));
update billing_auto_attempts set cancel_reason='disabled' where cancel_requested;
