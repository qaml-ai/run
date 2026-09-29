alter table billing_recipients drop constraint billing_recipients_status_check;
alter table billing_recipients add constraint billing_recipients_status_check
  check (status in ('pending', 'verified', 'bounced', 'unsubscribed'));
-- Created lazily before sending, so existing recipients acquire an opt-out too.
alter table billing_recipients add column unsubscribe_hash text unique;
alter table billing_recipients add column unsubscribe_secret jsonb;
