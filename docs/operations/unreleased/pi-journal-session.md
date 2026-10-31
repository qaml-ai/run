### A person's answer survives a deploy that lands as their question is asked

When a node stopped just as a tool call began waiting for a person, the next owner could lose track of the wait: the
question was already shown, but the answer was then accepted and dropped, and the turn ended without it. The call now
stays waiting on the next owner, and the answer reaches the run.

The host's journal now always writes through Pi's Session. A journal write made once an agent is closing is refused and
logged (`journal_write_refused`, with the kinds of record it held), except a call left waiting for a person, which is
stored. The next owner goes on from what is stored, as after a lost node.
