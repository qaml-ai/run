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
