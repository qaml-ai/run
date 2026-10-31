### ElevenLabs voice defaults to gemini-3.1-flash-lite

ElevenLabs calls now use `gemini-3.1-flash-lite` unless a session asks for another model, on a new agent,
`camelRun realtime voice v6`, made as each key's first such call connects. In group calls on this model, a rule that what
isn't for it comes first. `claude-haiku-5-5` stays allowed for rollback; other models and providers keep today's rules.

Set `AGENT_PRICE_ELEVENLABS_GEMINI_3_1_LLM_MINUTE_USD` before this deploys (`0.012` in Terraform): without it, ElevenLabs
calls are refused with `REALTIME_UNPRICED`. Their total goes from $0.083 to $0.092 a minute.
