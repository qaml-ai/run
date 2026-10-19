### Voice: in a group call, the bot answers the turns that are its own

- `addressing: {names, mode, conversationMs}` (src/voice/turns/floor.ts): with `names` (wake words), a turn is the
  bot's when it names it (near misses of long names, phrases, CJK without spaces), when its speaker is in a
  conversation with the bot (it answered them, or they named it, within `conversationMs`, 20 s; someone else naming it
  moves the conversation to them), or when no one else is in the call. Rules, not a model: language models pick a
  multi-party addressee near chance. `mode: "always"` (the default without names) is as before.
- The other turns still reach webhooks: `voice.utterance` has `addressed` and `addressedBy`. The agent gets them as
  context with the next turn that is the bot's. Prompt metadata has `addressedBy` when it is not `always`.
- With `agentReplies`, one reply at a time: a reply not yet heard when a newer turn's reply starts is taken back
  (`voice.speech.ended` `by: "superseded"`, log `voice_reply_superseded`), so rapid-fire turns get one answer.
