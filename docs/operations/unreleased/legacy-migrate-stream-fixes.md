### Streamed legacy retirement: settled by size, never a message taken back

A streamed host-transcript retirement in `POST /v1/operations/legacy-migrate` now settles messages by size (at least 4 MiB
per write, at most about 8 MiB held, the newest few always held) rather than by turn, and writes to the history index
only messages no later record takes back (a first pass finds them, four bytes a record), so the index never holds a
retracted message. A native entry its read let go is read again rather than failing, at most 256 are held, entries are
read 8 at a time, and a legacy log that cannot be read streaming fails the conversion.
