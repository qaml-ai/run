-- Journey events (src/journey.ts), off unless AGENT_JOURNEY_URL is set: what an operator's own analytics
-- store is told about accounts (made, signed in to, a token minted, deleted) and the console's pages,
-- never a tenant's webhooks. An account is named there by `account_ref`, a random id: a tenant id can be a GitHub login.
create table journey_accounts (
  tenant text primary key,
  account_ref uuid not null unique,
  -- The browser's visitor id when the account was made; later sign-ins never change it.
  signup_visitor uuid,
  -- The operator's own (staff, an admin tenant): once known, every later event says so.
  internal boolean not null default false,
  -- Whether the account was made while journey events were on, so what it did first is known and not guessed.
  since_signup boolean not null,
  -- What the account's browser last said about being measured; `lost` when that went with a lost event, and nothing is sent until a browser says.
  consent text not null check (consent in ('granted', 'denied', 'unknown', 'lost')),
  -- Google Analytics' id for the account's last browser that agreed, sent with what the account does away from one (a payment, a run); gone when a browser refuses.
  ga_client_id text,
  created_at bigint not null
);
-- What an account has done once (its first token, say), so `is_first` is decided here and not by the receiver.
create table journey_milestones (
  account_ref uuid not null,
  name text not null,
  at bigint not null,
  primary key (account_ref, name)
);
-- When journey events were first on: accounts made since then and missing from journey_accounts lost their event (Journey.reconcile).
create table journey_state (
  singleton boolean primary key default true check (singleton),
  enabled_at bigint not null
);
-- A sign-up whose event could not be written, kept as little as it takes to send it late: above all what its browser said about being measured.
create table journey_lost_signups (
  tenant text primary key,
  consent text not null check (consent in ('granted', 'denied', 'unknown')),
  visitor uuid,
  method text not null,
  surface text not null,
  at bigint not null
);
-- The outbox: one delivery per row, sent by any node until the store acknowledges it. `target` is where it goes:
-- an event (keyed by the event's id) to the store's events endpoint, a visitor's touch to its attribution endpoint,
-- or word that an account's browser refused to be measured to its consent endpoint (no event: a refusal is not activity).
create table journey_outbox (
  id uuid primary key,
  target text not null default 'events' check (target in ('events', 'resolve', 'consent')),
  account_ref uuid,
  body jsonb not null,
  attempts integer not null default 0,
  -- When the next attempt is due; a node sending it holds it by moving this past its attempt.
  due bigint not null,
  created_at bigint not null,
  last_error text,
  -- Set when the store refused it as invalid: tried again only once a day, in case the store has learned to read it.
  rejected_at bigint
);
create index journey_outbox_due on journey_outbox (due);
create index journey_outbox_account on journey_outbox (account_ref) where account_ref is not null;
