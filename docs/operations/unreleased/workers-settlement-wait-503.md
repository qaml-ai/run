### Workers: a prompt or DELETE that waits on a slow turn settlement answers 503, not 500

A tenant's turn settlements take one PostgreSQL lock in turn. When many of its agents end runs together, the wait
can pass the 10 s query timeout. A prompt to an agent with a spend limit settles that agent's pending turns first,
so it answered `500 INTERNAL`; it now answers `503 UNAVAILABLE`, and a retry succeeds once the settlements finish.
A DELETE whose shutdown failed after the agent was revoked answers `503 CLEANUP_PENDING` ("Agent revoked; cleanup
pending"), as a failed shutdown already did: the agent is gone, and another DELETE finishes the cleanup. Server
errors an agent answers itself are now logged (`agent_http_failed`); before, only errors thrown to the Worker were.
