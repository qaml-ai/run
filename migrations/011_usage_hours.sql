-- Usage charges accrue into one credit_ledger entry per tenant per UTC hour, keyed
-- usage:<tenant>:<hour>, which each usage flush in that hour updates in place
-- (src/billing.ts accrueUsage). Entries from before, one per flush (usage:<flush>:<tenant>),
-- stay as they are: the ledger still sums to each balance.

-- Each tenant's usage charges by minute, for the free-credit limit on spend in any hour
-- (the hourly entries are too coarse for a sliding hour). Only the last hour is read;
-- older minutes are deleted by the billing timer.
create table credit_spend_minutes (
  tenant text not null,
  -- Milliseconds since the epoch / 60000.
  minute bigint not null,
  -- Micro-USD spent, positive.
  amount bigint not null,
  primary key (tenant, minute)
);
