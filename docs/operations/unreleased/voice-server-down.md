### Voice calls survive a Discord voice server going down

- A Discord voice connection whose reconnects keep failing (a voice server that is down answers 521 or 522) now asks
  the app for new credentials (`voice.session.error`, `credentials_needed`) instead of ending the session with
  `error`: Discord's answer to the app's OP 4 can be another voice server. Without new credentials within the grace
  the session ends with `credentials`. See [voice calls](../guides/voice-calls.md).
