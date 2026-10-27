### Every message of a prompt is sent; steers are placed by Pi's own boundaries

- **Fix:** a prompt of several messages sent with a `requestId` lost every message after the first: each was submitted
  to Pi under the same request id, which Pi takes for the first. A run's input now goes into Pi's context at once, in
  order, before its first model request (all but the last as entries, the last as the input that starts the run), and
  only the first message of a request carries its id.
- A steer given while a run runs is handed to Pi's inbox as the tool round ends, and Pi places it at that boundary,
  instead of the agent placing it itself before the next model request. One given as the run answers starts a run of
  its own, as before. Steers given while no run is running wait for the next run, which now starts with all of them after
  its input (before: one per model request).
- The agent's unused follow-up queue is removed.
