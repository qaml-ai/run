### One place decides whether a turn ends the run

- The agent asks the host whether a turn ends the run (`finishTurn`: a call waiting for input, `final_output`, a run
  or spend limit, a hand-off) in one place, for a tool round and for an answer alike, from the response and results it
  already holds, instead of reading them back from the journal at the end of every tool round. `turn_end` events carry
  the round's results in call order, as before.
- A steer sent `whileRunning: "steer"` that its run did not take is dropped by the agent itself when the run ends; the
  host no longer keeps its own list of steers to take them back.
- A tool result's `structuredContent` goes to Pi only for a tool that declares an output schema: Pi drops it otherwise,
  and reported each one as an `extension_error` (`pi_report`).
