### A person can spend the credit they have

- With end-user credits on, a model call whose estimate is more than what is left now starts anyway when the shortfall
  is within $0.25, holding what is left, where it was refused (402 `END_USER_CREDIT`) with up to the cost of its input
  left. What it costs past its hold is written off and recorded as any write-off is (`writtenOff`, `end_user_written_off`):
  the tenant bears it, no balance goes negative, and no daily or bucket limit is passed. With nothing left, calls and
  runs are refused as before.
- The same holds for fixed holds: transcription, images and each realtime voice answer. A realtime voice session starts
  with any credit left, not only with one answer's $0.05. `EndUserCredits.refusal` no longer takes `usd`.
