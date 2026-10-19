# Auto top-up on end-user credits

With [end-user credits](end-user-credits.md), your users spend a balance you credit after
they pay. An auto top-up charges a person's saved card when their balance runs low, and
credits them. For example: "when I'm below $10, add $5, at most $50 a month".

camelRun never charges anyone's card. You hold the card, the person's terms and the payment
provider. camelRun tells you when a balance runs low, what moved it, and who is under their
threshold. This guide shows how to build a top-up that charges at the right time, once.

## What camelRun gives you

- **A threshold per person.** Set the person's own with
  `PATCH /v1/end-users/{id} {"lowBalance": 10000000}` (`endUsers.update(id, { lowBalance })`).
  `null` falls back to your tenant-wide `lowBalance`. `GET /v1/end-users/{id}` shows the one
  that applies (`lowBalance`) and their own (`overrides.lowBalance`).
- **`end_user.balance.low`**, with the `threshold` that applied and a `cause`. It fires when a
  debit takes the balance under the threshold, and again on the first debit after each
  grant that left the balance still under it. So "below $10, add $5" keeps working until
  the person is above $10. Setting a threshold above someone's balance fires it once, with
  `cause.kind: "threshold_changed"`, so turning auto top-up on for someone already low starts
  it. See [When balance events fire](end-user-credits.md#when-balance-events-fire).
- **`end_user.credit.granted`** (and `.refunded`, `.adjusted`) for each entry you post: a
  receipt, and a way to count what was topped up this month.
- **A sweep**: `GET /v1/end-users?belowLowBalance=true` (`endUsers.list({ belowLowBalance: true })`)
  lists the people under the threshold that applies to them, a page at a time.

## Treat events as wake-ups, not orders

An event says "look at this person". It does not say "charge them now". When one arrives,
or your sweep finds someone:

1. Dedupe by the event's `id`. Delivery is at least once.
2. Ignore causes that must not charge (next section).
3. Read the person again: `GET /v1/end-users/{id}`. Charge only if all of these hold:
   - their `balance` is still under their `lowBalance`;
   - auto top-up is on for them, and their card isn't paused (declined, or waiting on 3DS);
   - no top-up attempt of theirs is in flight (one at a time, under your own lock or a
     unique row per person);
   - this month's top-ups, paid and in flight, leave room under their monthly cap.
4. Charge, with the payment provider's idempotency key set to the attempt (a row you created
   in step 3), not to the event.
5. When the payment succeeds, post the grant with the payment's id as its `key`:
   `endUsers.grant(id, { amount, key: payment.id })`. A grant posted twice under the same key
   is posted once.

Without the one-at-a-time rule a person can be charged twice. A top-up is in flight for
someone at $9.95. A late cost correction lifts them to $10.05, which re-arms the event. Their
next call takes them to $9.90, and `balance.low` fires again.

## What must not charge

- **`cause.kind: "adjustment"` with a negative amount**: you took credit back (a chargeback, a
  correction). Don't charge the card that is being disputed. Turn auto top-up off for that
  person when your provider reports the dispute, and stop paid spend at once if you want with
  `PATCH /v1/end-users/{id} {"dailyLimit": 0}`.
- **Refunds** never fire balance events. Don't top up anyone you just refunded.
- **`end_user.credit.exhausted`** says the person ran out, so you can tell them. It isn't a
  separate reason to charge: if they're under their threshold, `balance.low` or the sweep
  already covers them.

`usage`, `usage_correction` (a call's cost corrected, maybe hours later) and
`threshold_changed` are the causes a top-up acts on.

## Order and the sweep

Events are sent concurrently and retried with backoff for up to 3 days, then dropped. So
they can arrive out of order, or not at all after a long outage.

- Order a person's events by `cause.entryId`. A person's entry ids grow. `created` is in
  whole seconds and doesn't order them.
- Don't rely on events alone. Every few minutes, run a sweep with
  `GET /v1/end-users?belowLowBalance=true` and put each person it returns through the same
  checks as an event. The sweep is also what retries a declined card once it's fixed:
  the person stays under their threshold, so no new event comes for them.

## Messages to people

The same events drive messages:

| Message | From |
| --- | --- |
| "Your credit is low" | `end_user.balance.low` (skip it while a top-up is in flight) |
| "You're out of credit" | `end_user.credit.exhausted` with `reason: "balance"` |
| A receipt | `end_user.credit.granted`, or your payment provider's own |
| "Today's free allowance is almost used" | `end_user.allowance.low`, with `allowanceWarningPercent` set |

## A sketch

```ts
app.post("/hooks/camelrun", async (req, res) => {
  const event = verify(req); // Standard Webhooks signature
  res.sendStatus(200);
  if (await seen(event.id)) return;
  if (event.type !== "end_user.balance.low") return;
  if (event.data.cause.kind === "adjustment" || event.data.cause.kind === "refund") return;
  await maybeTopUp(event.data.endUser);
});

// Also every few minutes:
for (let after: string | undefined; ;) {
  const page = await agents.endUsers.list({ belowLowBalance: true, after });
  for (const person of page.endUsers) await maybeTopUp(person.id);
  if (!page.next) break;
  after = page.next;
}

async function maybeTopUp(id: string) {
  const plan = await db.autoTopUp(id);                     // your terms: amount, monthly cap, card, paused?
  if (!plan?.enabled || plan.paused) return;
  const person = await agents.endUsers.get(id);
  if (person.lowBalance === null || person.balance >= person.lowBalance) return;
  const attempt = await db.startAttempt(id, plan);         // fails if one is in flight or the cap is reached
  if (!attempt) return;
  const payment = await charge(plan.card, plan.amount, { idempotencyKey: attempt.id });
  if (payment.succeeded) await agents.endUsers.grant(id, { amount: plan.amountMicros, key: payment.id });
  await db.finishAttempt(attempt, payment);                // pause on a decline or 3DS
}
```
