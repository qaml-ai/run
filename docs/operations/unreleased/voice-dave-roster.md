### Voice: DAVE's group checked against the call

- After each transition of a voice connection's DAVE group, a member Discord's voice server never named (past 5 s)
  drops the connection, which joins again with a new group; a fourth drop in 5 minutes ends the session (`error`,
  `dave_roster`). davey 0.1.12 does not check a Welcome's roster (the check behind CVE-2026-104480). Metric
  `VoiceDaveRosterDrops`; log line `voice_dave_roster`.
- A retiring node releases its voice sessions before telling peers they are free, so a peer's scan takes them at once.
