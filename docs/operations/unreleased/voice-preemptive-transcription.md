### Voice: a smart turn's transcript is made while the turn waits to be sure

- With `endOfTurn: smart` and live transcription, a turn Smart Turn calls complete (`likely_end`, ~250 ms after the
  last word) commits its speaker's live stream then, so the transcript is made while the turn waits out `commitMs`. A
  speaker who goes on (`resume`) is committed again at the cut, and the parts are one transcript (billed as one; if
  either fails, the utterance is transcribed whole, as before). Silence after it is cleared, not sent.
- Measured with a 400 ms commit: the transcript ~235 ms sooner (729 ms from the last speech, against ~960 ms).
- `voice_turn_stats` when a session is let go: turns, likely ends, resumes and `discardRate` (likely ends spoken past:
  what speculative work started at likely_end would throw away), and the floor's counts.
