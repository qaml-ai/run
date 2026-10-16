### Voice sessions can speak

- A session made with `speak: true` (its app joins un-muted: the answer's `join` says so) takes
  `POST /v1/voice/sessions/{id}/speak` `{text, voice?, instructions?, interrupt?}` (202, `speechId`, `position`) and
  `DELETE …/speak` (stop and clear). Speech is made with OpenAI's `gpt-4o-mini-tts`, streamed as PCM and encoded to
  20 ms Opus as it comes, so it starts playing before it is all made; one at a time per session, at most 20 waiting.
  `bargeIn` (default on) stops the bot when a person starts talking; `voice` sets the session's voice.
- Events `voice.speech.started` (`latencyMs`) and `voice.speech.ended` (`reason`: `done`, `interrupted` with `by`, or
  `error`; `seconds`, `costUsd`). Usage `kind: "speech"` at $0.015 a minute of speech made (`AGENT_PRICE_SPEECH_USD`),
  per second; end-user credits hold and settle it as transcription; running out ends the session (`budget`).
- Any node takes a speak request and passes it to the node holding the call.
- `speak: {agentReplies: true}` with `deliver.agent`: the session speaks the agent's reply to each utterance as it is
  written, sentence by sentence (streamed from the agent's node), markdown, links' addresses and code left out, at most
  400 characters; its speech events carry `reply: {agent, requestId}`. Barge-in stops the rest of a reply.
- DAVE's send path: a Welcome into a group with a member the voice gateway never named is refused at once (opcode 31,
  then welcomed again), around @discordjs/voice's handling, as libdave checks it; speech goes out only while the group
  is ready and every member named.
- SDKs: `agents.voice.speak` and `stopSpeaking` (Python `speak`, `stop_speaking`); `speak`, `bargeIn` and `voice` on
  `create`. `scripts/voice-check.ts` now also has the listener speak and the other bot hear it (with `OPENAI_API_KEY`,
  OpenAI's speech, transcribed back; else a tone). Migration 071.
