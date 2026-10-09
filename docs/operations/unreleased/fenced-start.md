### A run is no longer failed by a fence while its agent starts

- A node that lost an agent (it fenced itself, say after a database stall) while the agent's process was still getting
  ready to start went on and started it anyway, for an owner that was gone. The agent's next load, on that node once it
  rejoined, took that process for its own while it was still starting, and its first run failed with "Agent is not
  initialized": a queued run a drain or a deploy had left for the next owner failed instead of running. Such a start now
  gives up, and the next load starts the agent afresh. A stop while an agent starts now stops the start too.
