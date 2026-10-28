### Trace export is removed

The per-tenant OpenTelemetry trace export is gone: `PUT/GET/DELETE /v1/telemetry` and `POST /v1/telemetry/test`, the
`runtime.telemetry` SDK object (TypeScript and Python), `camelrun telemetry` and `run --traceparent`, the console's
Telemetry page (Settings now opens the account), the run record's `trace`, and inbound `traceparent` handling (a header or
param older clients send is ignored). Nobody used it: no tenant exported a span in the 14 days before (no
`telemetry_spans` lines), and chiridion and camel-bots never configured it. `AGENT_TELEMETRY_INTERVAL_MS` and
`AGENT_TELEMETRY_RETRY_MS` are no longer read.

The `telemetry_exporters` table stays, unread (account deletion still clears a tenant's row); dropping it is a separate
migration once it is confirmed empty. Operators keep the CloudWatch metric lines (`turn_metrics`, `model_response` and
the rest); Pi's own spans (`@earendil-works/pi-telemetry`) can be attached to an operator pipeline if one is added.
