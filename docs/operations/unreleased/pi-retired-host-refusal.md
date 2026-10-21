### Sessions a later release moved to Pi's journal alone are refused as newer

Once a later release reads a session's history from Pi's journal alone, it retires the session's host transcript
(the host document's `retired`). This release refuses such a session with 409 `AGENT_NOT_MIGRATED` saying its history
format is newer than this runtime (logged as `session_format_newer`), rather than continue from the frozen host
transcript, and writes nothing. Run a newer release.
