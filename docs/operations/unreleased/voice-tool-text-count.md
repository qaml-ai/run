### ElevenLabs voice counts tool calls written as text

A tool call an ElevenLabs model writes out as text is read aloud. Each one now logs `voice_realtime_warning` with
`errorCode: tool_text_written`, the session's `reference`, and in `detail` the form it matched, plus `muted` if the
adapter was muting that audio. It logs no text and changes nothing that's played. `voice_realtime_warning` lines now all
carry `reference`.
