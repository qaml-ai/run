### A voice turn caught writing a tool call out still gets an answer

When ElevenLabs' LLM writes a tool call as text, that text is still not played, and the turn now recovers once it ends.
`default_api.ask_agent` with its request as one whole string asks the agent, and the model gets the reply to say.
`default_api.stay_silent()` stays silent. Anything else is never run: the model is asked once a turn to answer in words.
`voice_realtime_warning` with `errorCode: tool_text_recovery` logs which, in `detail` (`ask_agent`, `stay_silent`,
`retry` or `limit`), with no text.
