-- End-user credits (src/end-user-credits.ts): a `spend` entry, credit a person spent on what the tenant sells other than
-- metered usage (a month of a feature, an item), taken from the balance as a refund is; and `description`, the tenant's
-- words for any of its entries, for the person's credit history. The kind check is replaced NOT VALID: every row in the
-- ledger already passes it, and validating would read the whole ledger (a row per metered call) under the migration's lock.
alter table end_user_ledger drop constraint end_user_ledger_kind_check;
alter table end_user_ledger add constraint end_user_ledger_kind_check check (kind in ('grant', 'refund', 'adjustment', 'usage', 'spend')) not valid;
alter table end_user_ledger add column description text;
