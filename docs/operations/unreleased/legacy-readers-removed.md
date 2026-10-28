### Legacy history formats are refused, not read

The readers of the host transcript's records, its retirement and the legacy log are removed. An agent whose history is
still in such a format is refused with `409 AGENT_NOT_MIGRATED` and its storage is left untouched; each refusal logs
`legacy_format_refused` with the agent, tenant and `kind`:

- `host_transcript`: a host transcript no release retired (its first load on a release from #374 on would have).
- `not_on_pi`: Pi storage without a journal history (a session rolled back to the legacy engine, or imported before #322).
- `legacy_log`: no Pi storage, but a legacy log (a session from before Pi).
- `history_before_base`: a history read reaches before the journal's base, and the history index does not hold it.

Stragglers can be migrated with the existing ops scripts, or the readers restored from git. The supervisor's
`closeTurn` no longer takes a history index (only the retirement used it).
