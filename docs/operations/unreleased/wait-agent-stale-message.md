### wait_agent no longer answers twice for one sub-agent message

A sub-agent's message cuts its parent's `wait_agent` short. A `wait_agent` the model called right after reading that
message could be cut short by it again, while the node was still saving that the message was read, and return "running"
with "sent you a message". It now waits for the sub-agent.
