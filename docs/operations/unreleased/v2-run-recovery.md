### Resume v2 run settlement from its saved conversation boundary

AgentDO saves the last conversation entry ID before it starts a Pi run. After a restart, it reads the run's committed entries in bounded ascending pages and resumes from its saved progress. Reconnecting WebSockets and background settlement use the same boundary. The terminal run record and its terminal event are committed together.

For a run created before the boundary was saved, the runtime looks up the exact Pi submission for that run. A placed user entry proves where the run began. If the boundary cannot be proved, the runtime logs `run_recovery_boundary_missing`, leaves the conversation intact, and skips transcript and live event attribution. It settles from the exact submission's terminal outcome when available. A missing submission settles as `not_found`.
