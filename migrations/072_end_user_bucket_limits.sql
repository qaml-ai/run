-- End-user credits: the most each bucket may charge an end user's balance per UTC day (charged micro-USD), keyed as
-- allowances are ({"bot:*": 2000000}); a bucket with no key is held only to the daily limit. The tenant's, and each
-- user's own overrides, key by key.
alter table end_user_settings add column bucket_limits jsonb not null default '{}';
alter table end_users add column bucket_limits jsonb not null default '{}';
