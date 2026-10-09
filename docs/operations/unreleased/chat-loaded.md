### Faster chat loading

- `watchAgent` and `createAgentChat` (`@camelai/run`) read pending inputs while the event stream opens, and history
  and state together once it has: opening a chat takes three round trips (token, stream, history and state) where it
  took five. Their state has `loaded` (`ChatSnapshot.loaded`): true once history and state are read, so a UI shows
  a loading state, not an empty chat, before it. The React kit's empty state waits for it.
