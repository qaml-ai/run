-- Stripe can deliver a refund before its Checkout payment. Retain the latest
-- cumulative refund total until fulfillment has enough information to apply it.
create table billing_stripe_refunds (
  charge text primary key,
  payment_intent text not null,
  amount bigint not null check (amount > 0),
  refunded bigint not null check (refunded >= 0 and refunded <= amount),
  currency text,
  updated_at bigint not null
);
create index billing_stripe_refunds_payment on billing_stripe_refunds (payment_intent);
