### Fewer database round trips per Pi step

Pi sessions on Postgres make about 40% fewer database statements per model call: a commit takes its sequence in
the metadata lock, checks its IDs and documents in one read and writes everything in one statement, and journal
reads fetch their conversation in the same statement. A turn's first model request starts sooner, and so does each
tool round. New metrics separate the runtime's part of time to first token from the model's: `TimeToFirstRequestMs`
on `turn_metrics`, and `RequestFirstTokenMs` on `model_response` ([architecture](architecture.md)).
