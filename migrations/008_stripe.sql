-- The Stripe customer each tenant's credit purchases are made as, created at its first checkout.
alter table credit_accounts add column stripe_customer text;
-- A refund finds its purchase by payment intent, and what was already refunded by charge.
create index credit_ledger_purchase_intent on credit_ledger ((metadata->>'paymentIntent')) where kind = 'purchase';
create index credit_ledger_refund_charge on credit_ledger ((metadata->>'charge')) where kind = 'refund';
