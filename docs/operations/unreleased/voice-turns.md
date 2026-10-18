### Voice: turns end when people are done talking, not after a fixed silence

- Voice sessions take `endOfTurn`: `smart` (the default where the runtime has the models) finds speech with Silero VAD
  and, at each pause, asks Pipecat's Smart Turn whether the speaker is done: done, the turn ends at `commitMs` (500 ms)
  of silence; mid-thought, they get up to `maxSilenceMs` (1.4 s). `silence` is the energy segmenter as before
  (`silenceMs`). `threshold`, `commitMs`, `maxSilenceMs` tune it per session; sessions show `endOfTurn`.
- Measured (`scripts/voice-turns-eval.ts`, 920 labelled turns, 23 languages): turns end 580 ms after the last word
  (median, against 816 ms), mid-thought pauses are held 87% of the time (against 1%), and noise is not speech.
- The models run in worker threads (src/voice/turns, onnxruntime-node on the CPU): about 40 ms of CPU per pause and
  0.1 core of VAD for 80 people talking at once, at most two threads (one Smart Turn thread by default; past its
  short queue a check is refused and the turn ends on silence), ~115 MB idle and ~190 MB working set. **Off unless
  the operator sets `AGENT_VOICE_TURN_MODELS=true`**: without it nothing is loaded, every session ends turns on
  silence and `smart` is refused. `AGENT_VOICE_TURN_WORKERS` sets the Smart Turn threads (default 1). onnxruntime's
  usage telemetry is off (`ORT_DISABLE_TELEMETRY`). Logs:
  `voice_turn_models_failed` (they did not load), `voice_turn_models_exited` (a thread died; it restarts).
