### A leaving node hands its turns to Pi on the next owner at once

A node that retires (a deploy), drains with a live peer, or leaves under memory pressure no longer waits for each
running turn to reach a step boundary. It closes each agent's Pi harness at once, mid-step and without an abort, records
the hand-off on the run (`handoffs`, with what the run gathered), and its peer's Pi goes on with the run where it was: a
model request the close cut is made again; a tool call in flight is answered as interrupted ("was interrupted and may
have partially run"), or made again when it is safe to repeat (`delegate` and the other multi-agent tools, declared
`replay: "safe"`). A code execution (`execute`) still finishes where it runs, up to `AGENT_RETIRE_MAX_MS`.

A node lost mid-turn (a crash) recovers the same way: the next owner resumes Pi's run instead of aborting it and
repairing the turn. A model request the crash cut ends Pi's run `interrupted` (Pi's retry is off), and the runtime asks
again once (`task_interrupted` in `pi_report`). Turns lost between Pi's runs (a host retry's backoff, say) are still
closed by the runtime as before.

Visible: drains are faster; a non-replay-safe call in flight at a deploy or drain is answered as interrupted (before,
only at a crash). `RunStop` loses `handoff`. Watch `turn_handed_off`, `task_interrupted` and turn outcomes after deploys.
