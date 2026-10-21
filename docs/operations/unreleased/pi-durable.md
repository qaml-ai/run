### Pi durable execution

Every agent runs on Pi durable 1.3.0, in process or inline hosting. Pi owns
execution, canonical history and compaction. The host loads a bounded native
checkpoint and uses indexed request admissions; it does not replay a legacy
transcript.

Postgres responses and summary usage commit with durable accounting receipts and
agent spend. Receipt consumption atomically updates daily usage, prepaid charges
and webhook events, including after a crash or concurrent worker retry.
Production's durable model-attempt accounting and end-user credit holds remain
authoritative; native fallback receipts do not charge those tracked calls a second
time. Storage metering is deferred.
