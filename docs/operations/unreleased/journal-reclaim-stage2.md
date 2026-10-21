### Journal reclaim stage 2: retired host transcripts

`scripts/ops/reclaim-checkpoints.ts --stage host-transcript` removes a retired host transcript's records, archive and
snapshot document, for sessions whose history index holds the history before their journal's base: dry run by
default, idle sessions only, one transaction each. See [Reclaim superseded journal checkpoints](journal-reclaim.md).
