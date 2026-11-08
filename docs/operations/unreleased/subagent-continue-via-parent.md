### A `continue` to a sub-agent is refused too

A `continue` request to a sub-agent the runtime made (its own token's `/clients/{child}/requests`, or the operator
bridge's `/registry/{child}/requests`) started a turn its parent did not send. It is now refused with 409
`SUBAGENT_VIA_PARENT` on both backends, like a prompt, steer or code run.
