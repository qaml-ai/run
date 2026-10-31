-- What a prepaid tenant's model calls on the platform's keys hold of its credit while they run (credit-holds.ts).
create table credit_holds (
  id uuid primary key,
  tenant text not null,
  amount bigint not null,
  expires_at bigint not null,
  created_at bigint not null
);
create index credit_holds_tenant on credit_holds (tenant, expires_at);
