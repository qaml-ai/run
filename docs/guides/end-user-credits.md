# End-user credits

Charge your own users for what their agents spend. camelRun keeps a balance for
each person your app serves, gives each a daily free allowance per part of your
product, enforces both on every model call, and tells you when someone runs low or
runs out. You keep the money side: your payment provider, your pricing page, your
emails. After a payment, you tell camelRun "add $10 to this person".

Everything a person causes counts against one balance: every agent that acts for
them, their stateless runs, transcriptions, images, web searches and the rest. You
still pay camelRun for raw usage as before (see [Pricing](../pricing.md)); end-user
balances are your ledger of your users, and camelRun never moves money for them.

## The model

- **End user**: the `subject` of an agent (set when you upsert it) or of a call
  (`POST /v1/runs`, `/v1/transcriptions`, `/v1/images`). Children of an agent
  (delegate, spawn) act for its subject too. Work with no subject is not metered:
  you pay for it, as today.
- **Bucket**: the part of your product that spends, such as `builder` or `bot:42`. An
  agent spends from its `bucket`; a stateless run or call names its own. A run sent
  with your API key (`POST /v1/agents/{id}/prompt`) may name another; an agent's own
  token cannot. A run that names none (one you send without, a schedule's, a
  sub-agent's notice, a channel's message, or a voice session's `ask_agent`) spends from the
  agent's bucket, else the one your latest run of the agent named, and only with
  neither from `default` (logged as `end_user_default_bucket`).
- **Daily allowance**: free spend per bucket per UTC day, spent first. Set by bucket
  name, by prefix (`"bot:*"`) or for every bucket (`"*"`); a bucket takes its own
  name, else the longest prefix it starts with, else `*`. You can override them per
  person. Allowances count **raw cost**: what the call costs you.
- **Balance**: paid credit, spent once the allowance is used. You add to it with
  grants (after a payment), and take from it with refunds and adjustments.
- **Markup**: added to the raw cost of paid spend before it is charged (`markupBps`:
  2500 is +25%). The ledger records both.
- **Daily limit**: the most a person's paid spend may be per UTC day, for everyone
  or per person.
- **Bucket limits**: the most one bucket may charge a person's balance per UTC day,
  keyed as allowances are (`"bot:*"`), for everyone or per person. A bot at
  `"bot:*": 2_000_000` spends its allowance, then at most $2 of the balance a day,
  however much the person holds; at `0` it spends its allowance only. To list the
  buckets that may spend paid credit at all, give `"*": 0` and a limit for each of
  them: `{ "*": 0, builder: 20_000_000, "bot:*": 2_000_000 }`. Then no other bucket,
  `default` included, ever charges anyone's balance.

All amounts are integer **micro-USD**: 1 USD = 1,000,000.

A call costs a person what it cost you: on camelRun's keys, what you are charged for it
(the provider's price, and the cost of funding OpenRouter credit on OpenRouter calls, about
5.5%); on your own keys, the provider's reported cost, else the catalog's price for its
tokens (cache reads and writes included), as `usage.recorded` says. The markup is on top
of that. A call
on a model with no price (one of your [own models](custom-models.md) declared without
`pricing`) is never free to them: it is charged at the catalog's price for the model,
else a mid-range price ($3 in, $15 out a million tokens), and logged as `end_user_unpriced_model`. Declare its
pricing to charge your own.

Changing an allowance or a limit never resets what was spent today: spend is kept
per day and bucket, and the allowance is only the cap. Raise a bucket from $40 to $60
mid-day and the person has $20 more, not $60.

## Turn it on

```ts
import { Agents } from "@camelai/run";
const agents = new Agents();

await agents.endUsers.configure({
  enabled: true,
  allowances: { builder: 50_000_000, "bot:*": 1_000_000 }, // $50 a day for the builder, $1 a day per bot
  markupBps: 2_500,                                          // paid spend at cost +25%
  dailyLimit: 20_000_000,                                    // at most $20 of paid spend a day
  bucketLimits: { "bot:*": 2_000_000 },                      // and at most $2 of it per bot
  lowBalance: 2_000_000,                                     // end_user.balance.low below $2
  allowanceWarningPercent: 80,                               // end_user.allowance.low at 80% of a bucket's allowance
});
```

```python
await agents.end_users.configure(enabled=True, allowances={"builder": 50_000_000, "bot:*": 1_000_000},
                                  markup_bps=2_500, daily_limit=20_000_000, bucket_limits={"bot:*": 2_000_000},
                                  low_balance=2_000_000)
```

REST: `PUT /v1/end-user-settings`. Fields left out keep their values; `allowances` and
`bucketLimits`, when sent, replace the whole map, so a key someone added by hand is gone
after the next `configure` that sends the map. To change some keys and keep the rest, use
`PATCH /v1/end-user-settings` (`endUsers.amend` / `end_users.amend`): only what is sent
changes, maps merge key by key, and `null` removes a key. A person's own overrides merge
the same way (`endUsers.update`).

Several writers (each server node as it starts, an admin tool, a script) may change the
settings at once. Each write changes only the fields it sends, and a `PATCH` merges its keys
into the map as it stands when the write lands, so writes to different fields or keys all
keep their changes. Of two writes to the same field or key, the later wins. So give each
writer its own fields and keys and have it `PATCH` only those: a node that `configure`s with
the whole `allowances` map replaces keys another writer added to it.

## Pay as you go: an example

A person buys credit with Stripe; their builder agent and their bots spend it.

```ts
// 1. Their agents act for them, each from its bucket.
const builder = await agents.upsert(`builder-${user.id}`, { subject: user.id, bucket: "builder", definition: BUILDER });
const helper = await agents.upsert(`bot-${botId}`, { subject: user.id, bucket: `bot:${botId}`, definition: BOT });

// 2. One-off model calls in their bot's code spend from the same bucket.
const answer = await agents.run({ input: prompt, subject: user.id, bucket: `bot:${botId}` });

// 3. A payment lands: credit it, once per payment (a retried webhook posts nothing twice).
app.post("/stripe/webhook", async (req, res) => {
  const event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], secret);
  if (event.type === "payment_intent.succeeded") {
    const payment = event.data.object;
    await agents.endUsers.grant(payment.metadata.userId, { amount: payment.amount * 10_000, key: payment.id, reference: `Stripe ${payment.id}` });
  }
  res.sendStatus(200);
});

// 4. Their credit page: where they stand, what they bought, and what their credit went to each day.
const person = await agents.endUsers.get(user.id, { buckets: ["builder"] });
// person.balance, person.available, person.today.buckets[0].allowanceLeft
const purchases = await agents.endUsers.ledger(user.id, { kind: ["grant", "refund", "adjustment"], limit: 20 });
const { days, next } = await agents.endUsers.days(user.id, { limit: 7 });
// days[0]: { day: "…", freeRaw, paidCharged, writtenOff, granted, refunded, adjusted, entries, buckets: [{ bucket: "bot:42", freeRaw, paidCharged, writtenOff }] }
```

```python
await agents.end_users.grant(user_id, amount=amount_cents * 10_000, key=payment_id, reference=f"Stripe {payment_id}")
person = await agents.end_users.get(user_id, buckets=["builder"])
purchases = await agents.end_users.ledger(user_id, kind=["grant", "refund", "adjustment"], limit=20)
days = await agents.end_users.days(user_id, limit=7)
```

A credit page reads no usage rows: the ledger's `kind` filter leaves them out, and
`days` gives each UTC day's totals by bucket in one request.

A refund you make in Stripe: `endUsers.refund(id, { amount, key })` takes the credit
back: at most the balance that calls in flight do not hold, else a 409
`INSUFFICIENT_BALANCE` (with `refundable`). Anything else: `endUsers.adjust(id, { amount, key })` with a signed amount.
Grants, refunds and adjustments are idempotent by `key`: the same key and entry again
returns the first; the same key for another entry is a 409.

## When a person runs out

camelRun holds credit for each model call before it is made: its input, and up to
2,048 tokens of output (a longer reply holds more as it streams), from the bucket's allowance first, then the balance. While
the reply streams, it asks for more ahead of the end of what it holds. Holds are
taken one at a time per person, on any node, so calls in parallel (sub-agents, several
of their agents at once) never each see the whole balance.

When nothing more can be held:

- **A new run** is refused with `402` and code `END_USER_CREDIT`, with `endUser`,
  `bucket` and `reason` in the body. The SDKs throw `AgentError` with the same fields
  (`reason`, `bucket`, `endUser`; Python `end_user`).
- **A run waiting in the queue** that is refused as it comes to start fails with code
  `end_user_credit`, `reason`, `bucket` and `endUser`, as below.
- **A run already going** stops where the credit ends, even in the middle of a reply:
  what streamed is kept, and the run fails with code `end_user_credit`, `stopped:
  "spend_limit"`, `limit: "end_user"`, a `reason`, the `bucket` and the `endUser`. It is never retried.
- `run.failed` carries `code`, `limit`, `reason`, `bucket` and `endUser` too, and
  `voice.session.ended` its `endUserReason` and `bucket`.
- Transcriptions, speech and images are refused before they are made, with the same 402.

`reason` is one of the [credit reasons](../reference/errors.md#end-user-credit-reasons):

- `balance`: no allowance left in the bucket today, and no balance.
- `daily_limit`: the person's paid spend reached the daily limit.
- `bucket_limit`: the bucket's paid spend reached its own limit (the person may still
  have a balance, for their other buckets; a bucket limited to 0 spends only its allowance).

`endUserCredit` (Python `end_user_credit`) reads these from a thrown error, a failed
run or its error, so one place handles every path:

```ts
import { endUserCredit } from "@camelai/run";

try {
  const run = await agent.run(text, { throwOnError: false });
  const credit = endUserCredit(run);
  if (credit) notify(user, credit.reason);
} catch (error) {
  const credit = endUserCredit(error); // a 402 at submit
  if (!credit) throw error;
  notify(user, credit.reason);
}

function notify(user: string, reason?: string) {
  // "daily_limit" | "bucket_limit" | "balance"; a reason added later: a credit refusal of no particular kind.
}
```

Branch on `code` and `reason`, never on the message: its words are for people and may change.

### Costs past a call's hold: written off

Usage never takes a balance below zero, and never takes paid spend past the daily
limit or a bucket's limit. A call can still cost more than it held:

- output a provider bills without streaming it (hidden reasoning tokens);
- what streams while the last credit check is answered (milliseconds of output);
- the gap between the input estimate and the real input (a provider cache that
  expired, a provider's own price at the time);
- a call whose node died: its hold lapses after 10 minutes, and if the provider
  reports its cost later, it is settled then.

When it settles, the person is charged at most what is left for it: the balance, the
daily limit and the bucket's limit, less what their other calls in flight hold. The
rest is **written off**: you bear it (your camelRun usage is the call's full cost, as
always), and it is never charged to the person later, even after they buy credit.
Each usage entry shows it as `writtenOff`, `GET /v1/end-users/{id}` totals it per
bucket for today (`today.buckets[].writtenOff`), and `GET /v1/end-users/{id}/days` per
bucket and day, all in raw micro-USD. The limit
that capped the charge fires `end_user.credit.exhausted` as a refused call would, and
the person's next call is refused for it.

A cost corrected down later takes back the write-off first, then refunds what the
balance paid, then the allowance. One corrected up is capped the same way, by the
limits of the day it posts to (the day the call began) and the balance as it is then.

## Webhooks

Subscribe an endpoint (`POST /v1/webhooks`) to:

| Type | When |
| --- | --- |
| `end_user.balance.low` | a balance is below the person's threshold: their own `lowBalance` (`PATCH /v1/end-users/{id}`), else yours. See [when it fires](#when-balance-events-fire) |
| `end_user.credit.exhausted` | `reason: "allowance"`: a bucket's allowance for the day is used up (the balance may still pay; once per person, bucket and day); `"balance"`: the balance reached zero, or a call was refused for it (see [when it fires](#when-balance-events-fire)); `"daily_limit"`: the daily limit was reached (once a day); `"bucket_limit"`: a bucket's own limit was reached (once per person, bucket and day) |
| `end_user.credit.granted`, `.refunded`, `.adjusted` | you posted a grant, refund or adjustment: once per entry (a replayed `key` sends nothing). `{endUser, entryId, kind, amount, key, reference, metadata, balance, previousBalance}`, `amount` signed as in the ledger. For receipts, and for a second service or a mirror of balances |
| `end_user.allowance.low` | a person's spend in a bucket passed `allowanceWarningPercent` (1–100, off by default) of its daily allowance: once per person, bucket and day. `{endUser, bucket, day, allowance, allowanceSpent, percent}` |

They are signed and retried like every [webhook](webhooks.md), and written in the
same transaction as the change that caused them.

### When balance events fire

`end_user.balance.low` and `end_user.credit.exhausted` with `reason: "balance"` each
carry a `cause`: what moved the balance.

```jsonc
"cause": {
  "kind": "usage",       // usage | usage_correction | grant | refund | adjustment | refusal | threshold_changed
  "entryId": 1234,       // the ledger entry; none for refusal and threshold_changed
  "entryKey": "dp_123",  // your key, for grant, refund and adjustment
  "requestId": "…",      // usage: the run's request, when there is one
  "bucket": "bot:42"
}
```

- `usage_correction` is a call's cost posted again, corrected: a provider's final
  figure, which can come long after the call.
- `refusal` is a call refused with no balance left: there is no ledger entry.
- A person's entry ids grow, so `entryId` puts their events in order, which delivery
  may not.

The rules:

- **`balance.low` fires on a debit** (usage or a negative adjustment) that takes the
  balance below the threshold from at or above it. Staying below fires nothing more,
  until one of the next rules applies.
- **`credit.exhausted` (`balance`) fires on a debit** that takes the balance from above
  zero to zero or below, and on a call refused with no balance left
  (`cause.kind: "refusal"`), once until the balance is back above zero or re-armed.
- **A grant or a positive adjustment that leaves the balance short re-arms the event**:
  the next debit fires it again. So with a $10 threshold, a $5 top-up that leaves someone
  at $6 makes their next debit fire `balance.low` again, and a grant that leaves someone
  at or below zero makes their next debit or refused call fire `credit.exhausted` again.
- **Any move that leaves the balance past the line** (at or above the threshold, above
  zero) resets the event, a call's cost corrected down included: the next crossing fires.
- **Setting a threshold** fires `balance.low` once, with `cause.kind: "threshold_changed"`,
  for each person under it who hasn't been told since they were last above it (or who
  was re-armed since). A person's own threshold (`PATCH /v1/end-users/{id}`) applies to
  them alone. Your tenant-wide `lowBalance` applies to everyone without their own who
  has ever been credited. Setting the same value again fires nothing.
- **Refunds are silent.** A refund fires neither event (no one should be topped up
  because you gave money back), and counts as told for each line the balance is short
  of, so neither fires until a grant or a positive adjustment.
- **Someone never credited** (who only spends free allowances) isn't re-armed by
  anything, and your tenant-wide threshold never tells them their balance is low.

To top a person up automatically when their balance runs low, see
[Auto top-up on end-user credits](end-user-auto-top-up.md).

## The ledger

Every movement of a person's money is an entry, newest first:

| `kind` | `amount` | Also |
| --- | --- | --- |
| `grant`, `refund`, `adjustment` | what you posted | your `key`, `reference` and `metadata` |
| `usage` | what the balance paid (negative), 0 when the allowance covered it all | `raw` (the call's cost), `allowance` (what the allowance covered), `writtenOff` (the cost past what was left for it, not charged), `bucket`, and `metadata` naming the call (`response`, `compaction`, `transcription`, `image`, `web_search`…), its agent and run |

A call whose cost is corrected later (a provider's final figure) has another usage
entry for the difference. `balanceAfter` is the balance after each entry.

Narrow it with `kind` (any of `grant`, `refund`, `adjustment`, `usage`, comma-separated
in the API), `from` and `to` (a time range on `createdAt`, `to` exclusive: epoch
milliseconds, a UTC day or an ISO 8601 time), `bucket`, and `moved=true` (only entries
that moved the balance, so usage the allowance paid for in full is left out). They
combine with each other and with `before` and `limit`.

### Per day

`GET /v1/end-users/{id}/days` (`endUsers.days(id, { from, to, bucket, limit })`) gives
a person's UTC days, newest first, `limit` days a page (default 31, at most 100; pass
`next` as `to` for the next). `from` and `to` are UTC days (`YYYY-MM-DD`, `to`
exclusive), at most 366 apart; by default the 366 days up to today. Days with no spend
and no entries are left out. `bucket` keeps that bucket's spend alone, without entries
(they belong to no bucket).

A call counts on the UTC day it began (its usage entry's `metadata.day`), so near
midnight its day can differ from the day of its entry's `createdAt`. An entry of yours
counts on the day it was posted.

### Units

Amounts are integer micro-USD. Some are raw cost (what a call cost you); others are
charged, in the balance's units (raw cost with your markup).

| Field | Unit |
| --- | --- |
| `allowances`, `allowance`, `allowanceSpent`, `allowanceLeft` | raw |
| a usage entry's `raw`, `allowance` and `writtenOff`; a bucket's or a day's `writtenOff` | raw |
| `balance`, `held`, `available`, `dailyLimit`, `bucketLimits`, `paidLimit`, `lowBalance` | charged |
| `paidSpent`, any entry's `amount` and `balanceAfter` | charged |
| a day's `freeRaw` (what allowances paid) | raw |
| a day's `paidCharged` (what the balance paid), `granted`, `refunded`, `adjusted` | charged |

A bucket's `held` today adds the allowance's part of holds (raw) to the balance's
(charged): read `available` and `allowanceLeft` for what is left.

## API

| Call | SDK (TypeScript / Python) |
| --- | --- |
| `GET`, `PUT`, `PATCH /v1/end-user-settings` | `endUsers.settings()`, `endUsers.configure({...})`, `endUsers.amend({...})` / `end_users.settings()`, `end_users.configure(...)`, `end_users.amend(...)` |
| `GET /v1/end-users` | `endUsers.list({ after, limit, belowLowBalance })`: `belowLowBalance` lists only those under their threshold |
| `GET /v1/end-users/{id}?buckets=` | `endUsers.get(id, { buckets })` |
| `PATCH /v1/end-users/{id}` | `endUsers.update(id, { allowances, bucketLimits, dailyLimit, lowBalance })`: a person's own allowances and bucket limits (merged; `null` removes one), limit and low-balance threshold (`null`: yours) |
| `GET /v1/end-users/{id}/ledger?kind=&from=&to=&bucket=&moved=` | `endUsers.ledger(id, { before, limit, kind, from, to, bucket, moved })` / `end_users.ledger(id, before=, limit=, kind=, from_=, to=, bucket=, moved=)` |
| `GET /v1/end-users/{id}/days?from=&to=&bucket=&limit=` | `endUsers.days(id, { from, to, bucket, limit })` / `end_users.days(id, from_=, to=, bucket=, limit=)` |
| `POST /v1/end-users/{id}/entries` | `endUsers.grant`, `refund`, `adjust` |

`bucket` is taken by agent upserts and configuration, prompts sent with your API key,
`POST /v1/runs`, `/v1/transcriptions` and `/v1/images`.
