-- Google sign-in (src/console-auth.ts): a tenant is tied to a Google account by its `sub`, which
-- never changes; the address is kept for display only. GitHub and Google identities are never merged.
alter table tenants add column google_sub text;
alter table tenants add column google_email text;
create unique index tenants_google_sub on tenants (google_sub);

-- Starting credit unlocked by verifying a card through Stripe (src/card-credit.ts): one row per
-- completed SetupIntent, so a retried webhook or a second confirmation settles once. A card
-- (its Stripe fingerprint) unlocks credit once across all tenants, and a tenant unlocks it once.
-- Rows outlive their tenant, so recreating an account cannot reuse the card.
create table card_checks (
  setup_intent text primary key,
  tenant text not null,
  livemode boolean not null,
  fingerprint text not null,
  granted boolean not null,
  grant_ledger_id bigint unique references credit_ledger(id),
  checked_at bigint not null
);
create unique index card_checks_card_once on card_checks (livemode, fingerprint) where granted;
create unique index card_checks_tenant_once on card_checks (tenant) where granted;
