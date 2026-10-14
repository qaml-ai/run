# Model attempt reconciliation

Each model call is recorded before dispatch. Generation IDs are persisted before response headers or stream bytes reach the model SDK. OpenRouter Messages uses `X-Generation-Id`; the native `msg_*` body identifier is not a generation lookup ID.

Interrupted OpenRouter attempts with IDs can be reconciled with the original platform, tenant, admin, or direct key-scope key. The current key must match the fingerprint recorded at dispatch. A gateway's scoped key is not sent directly to OpenRouter. Final provider evidence is required; a successful upstream HTTP status alone is insufficient. Corrections post only the difference, including refunds, and preserve one response count. A late completed host delivery can also replace an estimate.

## Remaining gaps

- A connection lost before headers arrive can still have unknown provider usage. Historical calls whose IDs were never saved cannot be safely matched by time/model alone.
- Anthropic, Azure, Bedrock and other non-OpenRouter providers do not yet have per-request reconciliation adapters. Interrupted calls retain observed estimates or remain pending if no usage reached the runtime.
- Rotated/deleted keys and gateway-managed credentials can make lookup unavailable. Keys are not retained in attempt records.
- Process death before final usage delivery can lose partial usage for providers without lookup. Durable incremental usage checkpoints are not implemented.
- `settled` means accepted completed usage or successful reconciliation; it does not mean every completed call was independently checked against a provider invoice.
- Exactly-once ledger posting does not guarantee exactly-once provider execution. Distinct retried calls are separate billable attempts.

Unknown usage is never silently finalized as zero. The recheck migration queues existing OpenRouter records with IDs; it neither manufactures historical IDs nor changes balances itself.

## Operational checks

```sql
select provider, platform, prepaid, state, count(*) as attempts,
       count(*) filter (where generation_id is null) as missing_ids,
       sum(charge)/1000000.0 as charged_usd
from model_attempts group by 1,2,3,4 order by 1,2,3,4;

select provider, state, last_error, count(*) as attempts
from model_attempts
where state <> 'settled' and started_at < extract(epoch from now())*1000-900000
 group by 1,2,3 order by 1,2,3;

with billed as (
  select metadata->>'attempt' as id, -sum(amount) as amount
  from credit_ledger where idempotency_key like 'model-attempt:%' group by 1
)
select count(*) as mismatches from model_attempts a
left join billed b on b.id=a.id::text
where a.charge <> coalesce(b.amount,0);
```
