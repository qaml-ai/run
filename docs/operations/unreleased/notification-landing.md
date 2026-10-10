### Background sub-agents: notifications are never lost

- A notification whose landing the database refused for now (a deadlock, a serialization failure, a statement timeout)
  failed its run and was lost: its landing is now tried again, as a run's start is.
- An abort of the parent cancelled a notification queued behind its turn, or ended one about to start, and the
  sub-agent's answer never reached history: it now lands without a turn (the run ends `aborted`).
- A node lost while delivering a notification held it for a minute; another node now takes over after two sweeps.
