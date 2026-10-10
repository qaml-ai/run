### Fixes

- A run that an abort cancels while the runtime is still accepting it now gives its agent's busy slot back before the
  run is seen to end, as other cancelled, failed and finished runs already did. A client that started another agent's
  run as soon as it saw the cancelled one end could be refused with 429 `BUSY_AGENT_LIMIT` at its tenant's busy limit,
  for as long as the slot took to free.
