### Metrics: a Workers startup reset is `startup_reset`, not `context_overflow`

Workers resets an agent whose startup (`blockConcurrencyWhile`) runs past 30 s with "A call to blockConcurrencyWhile()
in a Durable Object waited for too long". The `ErrorClass` dimension matched its "too long" as a context overflow; it
is now its own class, `startup_reset`. A run's API `error.errorClass` stays `other`, as it was.
