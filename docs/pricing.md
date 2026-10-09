# Pricing and credit

camelRun is prepaid: you buy credit, and usage draws it down. There is no
subscription and no per-seat or per-agent fee. `GET /v1/billing` (the console's
**Billing** page) shows your balance, this month's spending by kind, and the
rates below as your account is charged them.

| What | Price |
| --- | --- |
| Model calls on the platform's keys | The provider's own reported cost, else the model catalog's price (`GET /v1/models`, `cost` per million tokens). No markup. OpenRouter models add what funding OpenRouter credit costs: ×1.055 |
| Model calls on your own key (or a key scope's) | Nothing from camelRun: the provider bills you |
| Agent time | $0.01 per hour an agent spends in a run (model calls and tool execution), metered continuously. An idle agent costs nothing |
| Storage | $0.10 per GB-month of what your agents and volumes keep (history, files, snapshots), charged daily |
| `web_search` on the platform's keys | Per search, by the provider that answered: Exa $0.007, Brave $0.005, Parallel $0.001 |
| `web_fetch` page rendering on the platform's key | $0.00083 per page Firecrawl renders |
| [Transcription](guides/voice.md) on the platform's OpenAI key | $0.0045 per minute of audio (`gpt-transcribe`), billed per second |
| [Images](guides/images.md) on the platform's OpenAI key | Per token as OpenAI bills `gpt-image-2.5-flare`: $5 per million text tokens in, $8 per million image tokens in, $30 per million image tokens out. A 1024x1024 image is $0.0059 at `low`, $0.0132 at `medium`, $0.0527 at `high` |

## Credit

- **Starting credit: $5**, once. GitHub accounts older than 30 days get it at
  sign-up. Everyone else unlocks it by verifying a card on the **Billing** page;
  the card is not charged.
- **Buying credit:** $5 to $1,000 at a time, with a 5.5% fee on the purchase.
  Auto top-up can buy more when your balance runs low.
- **Before your first purchase:** at most $1 of model tokens and agent time an
  hour, and 1 GB stored. After it, 100 GB stored, and the
  [usage tiers](reference/limits.md#usage-tiers) raise how many agents may be
  busy at once as your purchases add up.
- At zero balance, new runs and file writes get 402 `INSUFFICIENT_CREDIT`, and a
  running turn ends after the response that spent the last credit. Nothing is
  deleted: add credit and send the next message.

## Spending less

- Use your own provider keys (`PUT /v1/providers/:provider/key`): model calls
  then cost you only what the provider charges, and camelRun charges agent time
  and storage. See [Models and keys](guides/models-and-keys.md).
- Bound an agent or a run with a [spend limit](guides/models-and-keys.md#spend-limits),
  and see where credit goes with `GET /v1/usage` or the `usage.recorded`
  [webhook](guides/webhooks.md).

A self-hosted runtime charges nothing unless its operator sets up billing; see
[Self-hosting](operations/self-host.md).
