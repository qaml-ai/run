### Voice: a session moving between nodes keeps its Discord credentials

- A node letting a voice session go (draining, retiring, fenced) drops its Discord voice socket instead of closing it.
  A normal close (1000) ended Discord's voice session, so the node that took the call next was refused (4006, session
  no longer valid) and the session ended with `credentials` after 15 s. The DAVE roster check's rejoin drops its old
  socket the same way.
- When Discord stops taking a session's credentials, `voice.session.error` (`code: "credentials_needed"`, `waitMs`)
  goes out at once: the app sends OP 4 for the channel again and PATCHes what Discord answers, and the session goes on.
