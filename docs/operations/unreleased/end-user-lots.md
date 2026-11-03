### End-user credits: credit that expires

A grant may carry `expiresAt`: a lot of the person's one balance that every bucket spends first (the soonest expiring
first, splitting across lots; credit without `expiresAt` last, and never expires). At its time the lot's unspent part is
posted as an `expiry` entry and `end_user.credit.expired` fires; a call that held some of it before then settles against
it. `GET /v1/end-users/{id}` returns `lots` (in the order they are spent), each day of `.../days` has `expired`, a debit
may name the grant whose lot it takes first (`lot`), and `POST /v1/end-users/{id}/lots` marks credit granted before as a
lot without moving the balance. SDKs: `grant({ expiresAt })`, `refund({ lot })`, `markLot`.
