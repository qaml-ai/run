### Opt-in Pi durable execution and session migration

`AGENT_ENGINE=pi-durable` selects the Pi durable 1.3.0 replacement in process or
inline hosting. The default remains `legacy`. Eligible idle sessions migrate on
load, retaining public IDs, full history, provider fields, human-input behavior
and historical request deduplication. Unfinished legacy turns stay on their
existing engine until an eligible reopen.

Pi owns execution, canonical history and compaction. The host loads a bounded
native checkpoint and uses indexed request admissions; it does not replay or
append the legacy transcript during normal operation. Rollback rebuilds the
legacy transcript from native history before selecting the legacy engine.

Postgres responses and summary usage commit with durable accounting receipts and
agent spend. Receipt consumption atomically updates daily usage, prepaid charges
and webhook events, including after a crash or concurrent worker retry.

The engine remains opt-in. Deploying this code with `AGENT_ENGINE=legacy` does
not migrate sessions. Production's durable model-attempt accounting and end-user
credit holds remain authoritative; native fallback receipts do not charge those
tracked calls a second time. Storage metering is deferred.

Automatic migration and rollback-era adoption now cap source history at 64 MiB
and 200,000 records. Oversized histories stay on the legacy engine with a
`size_limit` deferral, without losing history or reserving partial import state.
The bound is checked before full archive transfer to a child process. Storage
metering remains deferred.
