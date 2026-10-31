### A message sent just after a prompt joins its turn

A prompt with `whileRunning: "steer"` that arrived after another prompt was taken, but before its turn had begun (the
agent still starting), was queued as a turn of its own, to run after all of the first. A parent's `send_message` beside
its `spawn_agent` met this: the sub-agent did its whole task without the message. It now waits up to 5 s for that turn
and joins it.
