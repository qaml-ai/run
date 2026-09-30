-- A signup decision belongs to a GitHub identity, not a login or a later sign-in.
-- Keep it if the tenant is removed so recreating an account cannot reset the award.
-- Policy inputs and support notes are private; none belong in the public ledger.
create table starting_credit_decisions (
  github_id bigint primary key,
  tenant text not null,
  decision text not null check (decision in ('eligible', 'ineligible', 'disabled', 'legacy')),
  offered_amount bigint not null check (offered_amount >= 0),
  minimum_account_age_ms bigint,
  github_created_at bigint,
  signup_at bigint not null,
  decided_at bigint not null,
  grant_ledger_id bigint unique references credit_ledger(id),
  granted_by text,
  support_note text
);
create index starting_credit_tenant on starting_credit_decisions (tenant);

-- Existing accounts are never reconsidered for an automatic award. Preserve the
-- amount of a recorded award, without guessing why another account has no grant.
insert into starting_credit_decisions
  (github_id, tenant, decision, offered_amount, signup_at, decided_at, grant_ledger_id)
select t.github_id, t.id, 'legacy', coalesce(l.amount, 0), t.created_at,
       (extract(epoch from now()) * 1000)::bigint, l.id
from tenants t left join credit_ledger l
  on l.idempotency_key = 'grant:github:' || t.github_id::text
  and l.tenant = t.id and l.kind = 'grant' and l.amount > 0
where t.github_id is not null and t.billing = 'prepaid';
