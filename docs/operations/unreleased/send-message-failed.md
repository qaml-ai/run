### Workers: a `send_message` that never reached its sub-agent ends failed

If delivering a parent's `send_message` to its sub-agent failed, the Workers backend left the message's entry running.
A later `wait_agent` then polled a request the sub-agent never had and reported "The sub-agent was deleted before it
answered". The entry now ends failed ("The message did not reach …"), with no notification to come, as on Node.
