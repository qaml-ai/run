-- Billing notices are separate from agent email channels. No email is sent by
-- this migration; delivery workers consume the durable outbox below.
create table billing_alert_settings (
  tenant text primary key,
  threshold bigint not null default 2000000 check (threshold between 10000 and 500000000)
);
create table billing_recipients (
  id uuid primary key,
  tenant text not null,
  email text not null,
  status text not null default 'pending' check (status in ('pending', 'verified', 'bounced')),
  low boolean not null default true,
  depleted boolean not null default true,
  problems boolean not null default true,
  receipts boolean not null default false,
  confirmation_hash text not null unique,
  confirmation_expires bigint not null,
  created_at bigint not null,
  unique (tenant, email)
);
create index billing_recipients_tenant on billing_recipients (tenant);
create table billing_email_suppressions (email_hash text primary key, created_at bigint not null);
-- Survives removing/re-adding a recipient. Scope names contain hashes, not email addresses.
create table billing_confirmation_limits (
  scope text primary key,
  window_start bigint not null,
  sent integer not null,
  last_sent bigint not null
);
create table billing_events (
  id uuid primary key,
  tenant text not null,
  type text not null,
  data jsonb not null,
  created_at bigint not null
);
create index billing_events_tenant on billing_events (tenant, created_at);
create table billing_email_outbox (
  id uuid primary key default gen_random_uuid(),
  tenant text not null,
  recipient uuid not null references billing_recipients(id) on delete cascade,
  event uuid references billing_events(id),
  kind text not null check (kind in ('confirmation', 'low', 'depleted', 'problems', 'receipts')),
  payload jsonb not null,
  -- Only confirmation mail has a secret, sealed using AGENT_SECRETS_KEY.
  secret jsonb,
  expires_at bigint,
  state text not null default 'pending' check (state in ('pending', 'sent', 'cancelled', 'failed')),
  attempts integer not null default 0,
  lease uuid,
  due bigint not null,
  created_at bigint not null,
  unique (event, recipient)
);
create index billing_email_due on billing_email_outbox (due) where state = 'pending';

-- Called inside the balance/payment transaction. Each retry supplies the same
-- event key; fan-out uses the subscriptions that exist at the time of the event.
create function billing_emit_event(p_tenant text, p_type text, p_data jsonb, p_key text, p_email_kind text)
returns uuid language plpgsql as $$
declare
  event_id uuid := md5(p_tenant || ':' || p_type || ':' || p_key)::uuid;
  at_ms bigint := floor(extract(epoch from clock_timestamp()) * 1000);
  inserted integer;
  body jsonb;
begin
  insert into billing_events (id, tenant, type, data, created_at)
    values (event_id, p_tenant, p_type, p_data, at_ms) on conflict (id) do nothing;
  get diagnostics inserted = row_count;
  if inserted = 0 then return event_id; end if;
  body := jsonb_build_object('id', 'evt_' || replace(event_id::text, '-', ''), 'type', p_type,
    'created', floor(at_ms / 1000.0), 'data', p_data);
  insert into webhook_deliveries (id, tenant, endpoint, body, due, created_at)
    select md5((body->>'id') || ':' || w.id)::uuid, p_tenant, w.id, body, at_ms, at_ms
    from webhook_endpoints w where w.tenant = p_tenant and p_type = any(w.events);
  insert into billing_email_outbox (tenant, recipient, event, kind, payload, due, created_at)
    select p_tenant, r.id, event_id, p_email_kind, body, at_ms, at_ms
    from billing_recipients r where r.tenant = p_tenant and r.status = 'verified' and
      case p_email_kind when 'low' then r.low when 'depleted' then r.depleted
        when 'problems' then r.problems when 'receipts' then r.receipts else false end;
  return event_id;
end $$;

-- Balance row locks already serialize all writers (usage, storage, purchases,
-- grants, adjustments, refunds). Capture crossings here so no writer can omit
-- notices and a failure rolls back both the charge and all of its outboxes.
create function billing_balance_crossing() returns trigger language plpgsql as $$
declare
  alert_at bigint;
  was bigint := case when TG_OP = 'INSERT' then 0 else OLD.balance end;
  depleted_now boolean := was > 0 and NEW.balance <= 0;
  crossing_key text := gen_random_uuid()::text;
  facts jsonb;
begin
  if NEW.balance >= was then return NEW; end if;
  select threshold into alert_at from billing_alert_settings where tenant = NEW.tenant;
  alert_at := coalesce(alert_at, 2000000);
  facts := jsonb_build_object('balance', NEW.balance, 'previousBalance', was, 'threshold', alert_at, 'source', 'balance');
  if was >= alert_at and NEW.balance < alert_at then
    -- If one charge crosses both boundaries, deliver both webhook events but
    -- only the more urgent depleted email, never two emails for the same charge.
    perform billing_emit_event(NEW.tenant, 'billing.balance.low', facts, crossing_key || ':low',
      case when depleted_now then null else 'low' end);
  end if;
  if depleted_now then
    perform billing_emit_event(NEW.tenant, 'billing.balance.depleted', facts, crossing_key || ':depleted', 'depleted');
  end if;
  return NEW;
end $$;
create trigger billing_balance_crossing after insert or update of balance on credit_accounts
  for each row execute function billing_balance_crossing();
