### Voice: barge-in ignores the bot's own voice coming back

- A person on laptop speakers without headphones sends the bot's speech back into the call, which would stop every
  answer about a second in. Barge-in now pauses first (`src/voice/echo-guard.ts`):
  - After `minMs` (300) of speech over the bot, the media pauses playback at once, in its worker. The answer is kept.
  - Speech going on for `confirmMs` (1000) after the pause stops it (`by: "barge_in"`): echo stops with the bot.
    `resumeMs` (3000) is the longest pause: it then stops if they are still talking, else resumes. What the guard
    judged echo is dropped, not kept as someone's words.
- `bargeIn` takes `true | false | {minMs, confirmMs, resumeMs}`; `confirmMs: 0` stops at `minMs`, with no pause.
  Sessions show `interruption`.
- Sounds under `minMs` (a click, a cough) no longer stop the bot.
- Logs `voice_barge_in_confirmed` and `voice_barge_in_echo_rejected` (`why`, `pausedMs`, `speechMs`; never the words).
  `speech_played` has `heldMs.paused`.
- Media protocol: `resume` (control to media), and `barge_in` and `speech_progress` (media to control).
