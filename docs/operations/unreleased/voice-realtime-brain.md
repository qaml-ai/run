### Voice: a realtime brain (beta), off by default

- A voice session may have `brain: "realtime"` (`"cascade"`, today's pipeline, is the default): a speech-to-speech
  model (OpenAI Realtime, `gpt-realtime-2.1` or `-mini`, over a server-side WebSocket) hears the call and answers aloud,
  asking `deliver.agent` for anything beyond talk (`ask_agent`), and staying quiet when people talk to each other
  (`stay_silent`). See [Voice calls](../guides/voice-calls.md#realtime-brain-beta). Nothing changes for sessions that
  do not ask for it.
- It is offered only where `AGENT_VOICE_REALTIME` lists a provider (`openai`); unset, `brain: "realtime"` is refused
  (404). `AGENT_OPENAI_REALTIME_URL` dials another address. The tenant's OpenAI key is used, else the platform's.
- Our media plane, Smart Turn, addressing and echo guard stay in front of the model: the call's per-speaker audio is
  mixed, with a note naming who speaks at each change (`speakers` names them); turns are committed by us (the
  provider's turn detection is off), with the answer begun at Smart Turn's likely end and held until the turn ends; a
  barge-in cancels the answer and truncates its item at what was heard.
- Billing: each answer's tokens at list price, as `usage.recorded` `kind: "speech"` (the model as `model`), and the
  inputs' transcripts (`gpt-transcribe`) as transcriptions; end-user credits hold $0.05 before each answer.
- Logs and metrics: `voice_turn_latency` with `Path=realtime` (and `VoiceRealtimeMs`, commit to the model's first
  audio), `voice_realtime_stats` and the `voice_realtime` metric line per session (turns, answers, ask_agent,
  stay_silent, barge-ins, speculation taken back), `voice_realtime_ask_agent` (`VoiceRealtimeAskAgentMs` by outcome).
  No words are logged.
- `scripts/voice-realtime-e2e.ts` measures it end to end on the bake-off's clips (one-on-one, 2-3 speakers,
  overlapping), against OpenAI with `OPENAI_API_KEY`, or a stand-in provider (`--fake <ms>`).
