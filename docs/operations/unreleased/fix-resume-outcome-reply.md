### Fixes

- A run whose node is lost after its turn ended, but before the run recorded its end, now ends on the next owner with
  the turn's reply (and structured output) from history. A prompt in that window used to end `uncertain` ("The runtime
  restarted during this request") though its reply was written, and a resumed approval or answer completed with no
  `reply`.
