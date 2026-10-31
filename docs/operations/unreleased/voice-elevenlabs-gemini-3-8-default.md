### ElevenLabs voice defaults to gemini-3.8-flash

ElevenLabs calls now use `gemini-3.8-flash` unless a session asks for another model, on a new agent,
`camelRun realtime voice v6`, made as each key's first such call connects. `claude-haiku-5-5` stays allowed for rollback.

Set `AGENT_PRICE_ELEVENLABS_GEMINI_3_8_LLM_MINUTE_USD` before this deploys (`0.04` in Terraform): without it, ElevenLabs
calls are refused with `REALTIME_UNPRICED`. Their total goes from $0.083 to $0.12 a minute.
