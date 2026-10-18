### Voice: turns end when people are done talking, not after a fixed silence

- Voice sessions take `endOfTurn`: `smart` (the default where the runtime has the models) finds speech with Silero VAD
  and, at each pause, asks Pipecat's Smart Turn whether the speaker is done: done, the turn ends at `commitMs` (500 ms)
  of silence; mid-thought, they get up to `maxSilenceMs` (1.4 s). `silence` is the energy segmenter as before
  (`silenceMs`). `threshold`, `commitMs`, `maxSilenceMs` tune it per session; sessions show `endOfTurn`.
- Measured (`scripts/voice-turns-eval.ts`, 920 labelled turns, 23 languages): turns end 580 ms after the last word
  (median, against 816 ms), mid-thought pauses are held 87% of the time (against 1%), and noise is not speech.
- The models run in worker threads (src/voice/turns, onnxruntime-node on the CPU): about 40 ms of CPU per pause and
  0.1 core of VAD for 80 people talking at once. `AGENT_VOICE_TURN_MODELS=false` turns them off (every session then
  ends turns on silence); `AGENT_VOICE_TURN_WORKERS` sets the Smart Turn threads (default 2). Logs:
  `voice_turn_models_failed` (they did not load), `voice_turn_models_exited` (a thread died; it restarts).
- Barge-in in group calls (with `endOfTurn: smart`): the bot pauses at a person's first speech and stops only once
  they have talked over it for 400 ms with a word that is not a backchannel ("mm-hm", "yeah"... in ~20 languages) nor
  its own words echoed back (or 700 ms of speech without live transcripts); otherwise it resumes where it paused.
  `bargeIn: {minMs, minWords, noTranscriptMs, resumeMs, backchannels}` tunes it; sessions show `interruption`. Logs:
  `voice_duck`, `voice_unduck` (`why`), `voice_barge_in`, `voice_backchannel`.
- Floor control: `addressing: {names, mode, conversationMs}` answers only the bot's turns in a group call (named,
  in a conversation with it, or alone with it); the rest reach webhooks (`voice.utterance`'s new `addressed` and
  `addressedBy`) and go to the agent as context with the next turn that is the bot's. With `agentReplies`, one reply at
  a time: a reply not yet heard when a newer turn comes is superseded (`by: "superseded"`). Logs:
  `voice_reply_superseded`.
- Preemptive transcription (smart turns, with live transcription): when Smart Turn calls a turn complete (likely_end,
  about 250 ms after the last word), its speaker's stream is committed then, so the transcript is made while the turn
  waits to be sure (`commitMs`); a speaker who goes on is committed again at the cut and the parts joined. Measured with
  a 400 ms commit: the transcript ~235 ms sooner. `voice_turn_stats` (at a session's end) logs likely ends, resumes and
  `discardRate` (speculation thrown away), barge-in and floor counts.
