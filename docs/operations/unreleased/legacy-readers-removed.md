### Legacy history formats are refused, not read

Every agent in a legacy history format was converted by `POST /v1/operations/legacy-migrate`, and legacy coverage read
0. The readers of the host transcript's records, its retirement, the legacy log, and the migration endpoint itself are
removed. An agent whose history is still in such a format (none should be) is refused with `409 AGENT_NOT_MIGRATED` and
its storage is left untouched; each refusal logs `legacy_format_refused` with the agent, tenant and `kind`:

- `host_transcript`: a host transcript no release retired.
- `not_on_pi`: Pi storage without a journal history (a session rolled back to the legacy engine, or imported before #322).
- `legacy_log`: no Pi storage, but a legacy log (a session from before Pi).
- `history_before_base`: a history read reaches before the journal's base, and the history index does not hold it.

`GET /v1/operations/legacy-coverage` stays, to check none appears. The supervisor's `closeTurn` no longer takes a history
index (only the retirement used it). Legacy logs themselves are not deleted.
