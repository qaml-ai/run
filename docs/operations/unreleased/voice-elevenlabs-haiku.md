### ElevenLabs voice can run on claude-haiku-5-5

A session may ask for `realtime.model: "claude-haiku-5-5"` on ElevenLabs Agents. It runs on its own agent,
`camelRun realtime voice v5`, made as each key's first such call connects. The default stays `gemini-2.5-flash-lite`.

Set `AGENT_PRICE_ELEVENLABS_HAIKU_LLM_MINUTE_USD` before the first such session (`0.003` in Terraform): without it,
that model is refused with `REALTIME_UNPRICED`.

`voice_realtime_lost` now names the `reference`, the `failure` class and any `closeCode`, with no provider text.
