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
  agent spends from its `bucket` (default `default`); a stateless run or call names
  its own. A run sent with your API key (`POST /v1/agents/{id}/prompt`) may name
  another; an agent's own token cannot.
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

All amounts are integer **micro-USD**: 1 USD = 1,000,000.

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
  lowBalance: 2_000_000,                                     // end_user.balance.low below $2
});
```

```python
await agents.end_users.configure(enabled=True, allowances={"builder": 50_000_000, "bot:*": 1_000_000},
                                  markup_bps=2_500, daily_limit=20_000_000, low_balance=2_000_000)
```

REST: `PUT /v1/end-user-settings`. Fields left out keep their values.

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

// 4. Their credit page.
const person = await agents.endUsers.get(user.id, { buckets: ["builder"] });
// person.balance, person.available, person.today.buckets[0].allowanceLeft
const { entries, next } = await agents.endUsers.ledger(user.id, { limit: 50 });
```

```python
await agents.end_users.grant(user_id, amount=amount_cents * 10_000, key=payment_id, reference=f"Stripe {payment_id}")
person = await agents.end_users.get(user_id, buckets=["builder"])
```

A refund you make in Stripe: `endUsers.refund(id, { amount, key })` takes the credit
back. Anything else: `endUsers.adjust(id, { amount, key })` with a signed amount.
Grants, refunds and adjustments are idempotent by `key`: the same key and entry again
returns the first; the same key for another entry is a 409.

## When a person runs out

camelRun holds credit for each model call before it is made: its input, and up to
8,192 tokens of output, from the bucket's allowance first, then the balance. While
the reply streams, it asks for more ahead of the end of what it holds. Holds are
taken one at a time per person, on any node, so calls in parallel (sub-agents, several
of their agents at once) never each see the whole balance.

When nothing more can be held:

- **A new run** is refused with `402` and code `END_USER_CREDIT`, with `endUser`,
  `bucket` and `reason` in the body.
- **A run already going** stops where the credit ends, even in the middle of a reply:
  what streamed is kept, and the run fails with code `end_user_credit`, `stopped:
  "spend_limit"`, `limit: "end_user"` and a `reason`. It is never retried.
  - `reason: "balance"`: no allowance left in the bucket today, and no balance.
  - `reason: "daily_limit"`: the person's paid spend reached the daily limit.
- Transcriptions and images are refused before they are made, with the same 402.

```ts
const run = await agent.run(text, { throwOnError: false });
if (run.error?.code === "end_user_credit") notify(user, run.error.reason === "daily_limit" ? "You've reached today's limit" : "You're out of credit");
```

Read the error's `reason` rather than its message.

### How far past zero

A balance can go a little below zero. Visible output never passes what a call holds,
but these can:

- output a provider bills without streaming it (hidden reasoning tokens);
- the gap between the input estimate and the real input;
- a call whose node died: its hold lapses after 10 minutes, and if the provider
  reports its cost later, it is charged then.

That is at most one call's unstreamed output per call in flight. The next grant
covers it.

## Webhooks

Subscribe an endpoint (`POST /v1/webhooks`) to:

| Type | When |
| --- | --- |
| `end_user.balance.low` | a balance falls below `lowBalance`; again only after a grant lifts it back above |
| `end_user.credit.exhausted` | `reason: "allowance"`: a bucket's allowance for the day is used up (the balance may still pay; once per person, bucket and day); `"balance"`: the balance reached zero, or a call was refused for it (once until the next grant); `"daily_limit"`: the daily limit was reached (once a day) |

They are signed and retried like every [webhook](webhooks.md), and written in the
same transaction as the change that caused them.

## The ledger

Every movement of a person's money is an entry, newest first:

| `kind` | `amount` | Also |
| --- | --- | --- |
| `grant`, `refund`, `adjustment` | what you posted | your `key`, `reference` and `metadata` |
| `usage` | what the balance paid (negative), 0 when the allowance covered it all | `raw` (the call's cost), `allowance` (what the allowance covered), `bucket`, and `metadata` naming the call (`response`, `compaction`, `transcription`, `image`, `web_search`…), its agent and run |

A call whose cost is corrected later (a provider's final figure) has another usage
entry for the difference. `balanceAfter` is the balance after each entry.

## API

| Call | SDK (TypeScript / Python) |
| --- | --- |
| `GET`, `PUT /v1/end-user-settings` | `endUsers.settings()`, `endUsers.configure({...})` / `end_users.settings()`, `end_users.configure(...)` |
| `GET /v1/end-users` | `endUsers.list({ after, limit })` |
| `GET /v1/end-users/{id}?buckets=` | `endUsers.get(id, { buckets })` |
| `PATCH /v1/end-users/{id}` | `endUsers.update(id, { allowances, dailyLimit })`: a person's own allowances (merged; `null` removes one) and limit |
| `GET /v1/end-users/{id}/ledger` | `endUsers.ledger(id, { before, limit })` |
| `POST /v1/end-users/{id}/entries` | `endUsers.grant`, `refund`, `adjust` |

`bucket` is taken by agent upserts and configuration, prompts sent with your API key,
`POST /v1/runs`, `/v1/transcriptions` and `/v1/images`.
