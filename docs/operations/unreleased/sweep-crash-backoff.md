### Back off sweep loads after node crashes

Orphan sweeps now reserve a retry delay before loading an agent. If the load or its run kills the node without recording an error, the next node waits for that delay. Repeated attempts double the sweep interval, up to one hour. The delay clears after the agent stays loaded for two minutes or its run ends.

This backoff only gates sweep selection. It does not add a wait to a resumed turn's model call, change its resume limit, or count a load refused because another node owns the agent.
