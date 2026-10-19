-- End-user credits: what a call cost past what was left for it (the balance, the daily limit, the bucket's own limit) is
-- written off rather than charged: raw micro-USD the tenant bears and its user never pays. Kept on the usage entry, per
-- day and bucket, and on the model attempt, so a corrected cost posts only its difference.
alter table end_user_ledger add column written_off bigint not null default 0;
alter table end_user_days add column written_off bigint not null default 0;
alter table model_attempts add column end_user_written_off bigint not null default 0;
