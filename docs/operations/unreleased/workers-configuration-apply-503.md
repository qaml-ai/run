### Workers: a create whose configuration apply fails answers 503, and a keyed retry finishes it

Creating an agent (and changing its name, type or mounts) writes its directory row first, then has the agent apply the
configuration. When the apply failed, the agent's handler rejected instead of answering, so the error was mapped by
the Worker (`503 UNAVAILABLE` for a database timeout, `500 INTERNAL` otherwise), and a create retried with the same
`Idempotency-Key` was queued as a change on an agent that had no configuration, answering `404 NOT_FOUND`. A failed
apply now answers `503 CONFIGURATION_PENDING` ("Agent configuration saved; applying it failed, retry"), as a DELETE
whose cleanup failed answers `503 CLEANUP_PENDING`, and the keyed retry applies the configuration as a creation.
