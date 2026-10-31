### Model calls hold your credit before they are made

A model call on the platform's keys now holds its estimate of a prepaid account's credit first, at the catalog's rates. Before, the balance was only checked between calls, so a few cents could start a call costing many dollars.

- A call the credit does not cover is not made, and the turn ends with `stopped: "spend_limit"`, `limit: "credit"`. On free credit, the room is also what is left of the hour's allowance.
- All of your credit can be spent: a last call starts within $0.25 of what is left, and a reply stops where the credit does.
- Each call, on your credit or an end user's, asks for at most the output what is left pays for, so `max_tokens` can come out lower than the model's maximum near the end of a balance. That also bounds reasoning that never streams.
- An estimate now uses a model's long-context rates for end users' holds as well.
- A model with no price, or a router, holds at $3 and $15 per million tokens. It settles at what the provider reports.
- Your own keys are not held, and neither are `:free` models.
