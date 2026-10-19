### Voice: each session's audio in a worker of its own

- A voice session's audio work (the Discord connection, DAVE, Opus, cutting turns, playing speech) runs in a media
  worker thread, one per session by default, supervised by the node (`src/voice/media-host.ts`). A crash, a heap that
  runs out or a worker that stops answering for 5 s ends that session's audio alone: the session sends
  `voice.session.error` (`code: "media_crashed"`, `restarting`, `attempt`) and reconnects in a fresh worker. After 3
  failures in 5 minutes it ends (`error`). Agent turns, and every other session, are untouched.
- `AGENT_VOICE_ISOLATION=inline` keeps the audio on the node's thread, as before. `AGENT_VOICE_SESSIONS_PER_WORKER`,
  `AGENT_VOICE_WORKERS` (16) and `AGENT_VOICE_WORKER_MAX_MB` (256) size it ([Configuration](configuration.md)).
- New event `voice.session.error`; apps that select every voice event should handle it, or ignore it.
- Logs and metrics: `voice_worker_crashed` (`VoiceWorkerCrashes`, `VoiceWorkerCrashSessions`), `voice_media_crashed`
  per session.
