### Voice: barge-in ignores the bot's own voice coming back

- A person on laptop speakers without headphones sent the bot's speech back into the call, and barge-in stopped every
  reply about a second in. Barge-in now pauses first and checks (`src/voice/echo-guard.ts`):
  - After `minMs` (300) of speech over the bot, the media pauses playback at once, in its worker. The speech is kept.
  - The utterance's words (live partials, else its transcript) are compared with what the bot is saying and just said:
    matching words in the bot's order (60% or more, allowing small slips) is echo. Echo, or no words, **resumes** where
    it paused. Anyone else's words **stop** it (`by: "barge_in"`).
  - Speech going on for `confirmMs` (1000) after the pause stops it without the words (echo stops with the bot).
    `resumeMs` (3000) is the longest pause: it then stops if they are still talking, else resumes.
- `bargeIn` takes `true | false | {minMs, confirmMs, resumeMs}`; `confirmMs: 0` is the old behaviour (stop at
  `minMs`, no pause). Sessions show `interruption`. Existing sessions get the defaults.
- Sounds under `minMs` (a click, a cough) no longer stop the bot.
- Logs `voice_barge_in_candidate`, `voice_barge_in_confirmed` and `voice_barge_in_echo_rejected` (`why`, `pausedMs`,
  `speechMs`, `score`; never the words); metric `voice_barge_in` (`VoiceBargeIns`, `VoiceBargeInPausedMs` by `Outcome`
  and `Why`). `speech_played` has `heldMs.paused`.
- Media protocol: `resume` (control to media), and `barge_in` and `speech_progress` (media to control).
