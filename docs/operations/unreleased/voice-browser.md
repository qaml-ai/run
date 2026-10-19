### Voice: calls from a browser

- `POST /v1/voice/sessions` takes `provider: "browser"`: a call from a web page, no Discord, through the same
  pipeline. The answer's `browser.url` and `browser.token` open its WebSocket (Opus or PCM in, the bot's speech out as
  Opus or PCM, and the session's utterance and speech events). Any node accepts the socket and relays it to the node
  holding the session. See [Voice calls](../guides/voice-calls.md#from-a-browser).
- `POST /v1/voice/sessions/{id}/browser-token` makes another token.
- `ws` moves from devDependencies to dependencies (it was already installed, through @discordjs/voice).
