### Legacy migration retires host transcripts of any size

`POST /v1/operations/legacy-migrate` retires a host transcript streaming: its records, and its legacy log's (an object
at a time from Storage, a snapshot an item at a time), pass through a window that holds the latest turn, and the settled
history is written to the history index 4 MiB at a time from where the index ends, then the same single retire commit.
Memory stays bounded whatever the agent's size, so `maxBytes` no longer refuses host transcripts; it still bounds the
conversions that hold a whole history in memory (`not_on_pi`, `legacy_log`, `history_before_base`). Logs gain
`AppendLog.records()`, a streamed read.
