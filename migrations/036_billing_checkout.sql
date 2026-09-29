-- Preserve Stripe ownership, environment and quoted terms before making API calls.
create table billing_stripe_customers (
  tenant text not null,
  livemode boolean not null,
  request_id uuid not null unique,
  customer text unique,
  created_at bigint not null,
  primary key (tenant, livemode)
);

create table billing_checkouts (
  id uuid primary key,
  tenant text not null,
  livemode boolean not null,
  request_id uuid not null,
  customer text not null,
  amount bigint not null check (amount > 0 and amount % 10000 = 0),
  fee bigint not null check (fee >= 0 and fee % 10000 = 0),
  currency text not null check (currency = 'usd'),
  api_version text not null,
  parameters jsonb not null,
  session text unique,
  invoice text unique,
  payment_intent text unique,
  url text,
  created_at bigint not null,
  expires_at bigint,
  paid_at bigint,
  unique (tenant, livemode, request_id)
);

-- Only sessions created before this cutover can use legacy metadata fulfillment.
-- Drain the old Checkout route before migration; do not run old writers afterward.
create table billing_checkout_cutover (singleton boolean primary key default true check (singleton), created_before bigint not null);
insert into billing_checkout_cutover values (true, floor(extract(epoch from now()))::bigint);
