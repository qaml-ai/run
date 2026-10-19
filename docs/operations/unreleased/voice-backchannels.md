### Voice: a backchannel over the bot lets it go on

- Barge-in's echo guard also lets the bot go on when what was said over it is only a backchannel ("mm-hm", "yeah",
  "ok", "sí", "vale", "ja", "oui", "да", "haan", "嗯", "はい", "네"… about 20 languages; `BACKCHANNELS` in
  src/voice/echo-guard.ts), so a group's murmurs do not stop it. A partial transcript that is only a backchannel waits
  (it may go on: "yeah, but…" stops it). A backchannel judged so is not a turn: it never reaches `deliver.agent`, and
  its `voice.utterance` has `backchannel: true`. `bargeIn.backchannels` adds a session's own (up to 50); sessions show
  them in `interruption`.
- With `endOfTurn: smart`, a turn that ends with less speech than an utterance needs (300 ms: a cough, a click) ends
  the pause it made at once, not at `resumeMs`. Two people over the bot still hold one pause until both are decided.
- Logs: `voice_barge_in_echo_rejected` has `why: "backchannel"` and `why: "ended"`.
