### A cold agent starts at once: nothing in startup waits on itself or on another object

A cold agent woken by an RPC (for example, a workflow's notice to its owner) could deadlock inside its own startup. The RPC's send started the startup, and startup's notice drain then waited on that same send. Workers reset the object after 30 s on every wake, so the notice arrived minutes late or never. Startup now holds nothing that waits on itself or on another object:

- **Not awaited by startup:** the notice drain, the endings outbox flush, children's cancels, reconciles and resumes, and the input mirrors' restage (then their flush) are all started during startup, not awaited by it. A cancelled agent's queued notices are marked aborted the same way.
- **Bounded reads:** Pi's provider and endpoint reads and the stale-preparations sweep, which must stay inside startup, each have a 4-second deadline. Past it, the start fails fast (a request that woke the agent gets a 500) and the next wake starts again.
- **Logs:** a startup over 5 s is logged as `agent_start_slow` (step "startup"). `workflow_notice_failed` lines are now short and searchable.
