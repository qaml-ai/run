### Ending a run after a tool round without a Pi patch

Vendored Pi drops our `afterTools` `{ end: true }` patch (`1.4.0-main.f09d01b85e03-camel.1`). The host still decides
after each call of a round whether the run ends there (a call waiting for input, final_output, a run or spend limit):
the first call that ends it, and every call after it, return `control.terminate`, and when a call of the round had
already settled, the conversation's turn limit ends the round, so Pi makes no further model request. The round's end is
committed with the decision, so a node that takes over a round a lost node left open ends it too. Run outcomes, inputs
and replies are unchanged.

No stored document or task version changes: this deploy can be rolled back.
