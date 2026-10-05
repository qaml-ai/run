-- Card disputes (chargebacks) on credit purchases (Billing.dispute). An open dispute debits the disputed share of
-- its purchase's credit and stops the tenant's runs; one closed in the tenant's favour restores it. Kept like
-- refunds, by payment intent, until the purchase is known (Stripe delivers events out of order); `tenant` is set
-- once it is.
create table billing_disputes (
  id text primary key,
  payment_intent text not null,
  charge text,
  tenant text,
  amount bigint not null check (amount > 0),
  currency text,
  status text not null,
  reason text,
  closed boolean not null default false,
  created_at bigint not null,
  updated_at bigint not null
);
create index billing_disputes_payment on billing_disputes (payment_intent);
create index billing_disputes_open on billing_disputes (tenant) where not closed;
