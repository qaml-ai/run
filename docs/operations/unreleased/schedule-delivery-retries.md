### Schedule deliveries back off, then move on

- A schedule whose delivery fails is retried 1, 5 and 15 minutes later (with the same request id, so a delivery that
  did reach the agent never runs twice), instead of every minute for ever. After that, or at once for a refusal a
  retry cannot change (a spend limit's or spent credit's 402, a 400 or 403), the occurrence is given up: a repeating
  schedule moves to its next occurrence and a one-off one is removed. Schedules list `failures` (occurrences given up
  in a row), `lastError` and `lastErrorAt` until a delivery succeeds; each failure is logged as
  `schedule_delivery_failed` ([Waking later](../concepts.md#waking-later)).
- A failed delivery no longer holds up the other wake-ups due in the same scan for a minute.
